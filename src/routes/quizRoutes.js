import { buildJoinUrl } from '../config.js';
import { generateQuestions, isConfigured, toPasteFormat } from '../lib/gemini.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { send, sendNoContent } from '../lib/http.js';
import { renderQrPng, renderQrSvg } from '../lib/qrcode.js';
import { Router } from '../lib/router.js';
import { leaderboardService } from '../services/leaderboardService.js';
import { quizService } from '../services/quizService.js';

export const quizRoutes = new Router();

/** Everything in this block requires a signed-in maker and their own quiz. */
const maker = { maker: true };

quizRoutes.get('/api/quizzes', ({ user }) => ({ quizzes: quizService.listSummaries(user.id) }), maker);

quizRoutes.post(
  '/api/quizzes',
  ({ body, user }) => {
    const quiz = quizService.create(body, user.id);
    return { quiz, joinUrl: buildJoinUrl(quiz.id) };
  },
  maker,
);

quizRoutes.get(
  '/api/quizzes/:quizId',
  ({ params, user }) => {
    const quiz = quizService.requireOwnedQuiz(params.quizId, user.id);
    return {
      quiz,
      joinUrl: buildJoinUrl(quiz.id),
      totalPoints: quizService.totalPoints(quiz),
    };
  },
  maker,
);

quizRoutes.patch(
  '/api/quizzes/:quizId',
  ({ params, body, user }) => ({ quiz: quizService.update(params.quizId, body, user.id) }),
  maker,
);

quizRoutes.delete(
  '/api/quizzes/:quizId',
  ({ params, res, user }) => {
    quizService.remove(params.quizId, user.id);
    sendNoContent(res);
  },
  maker,
);

/* ---- Questions ---- */

quizRoutes.post(
  '/api/quizzes/:quizId/questions',
  ({ params, body, user }) => ({ quiz: quizService.addQuestion(params.quizId, body, user.id) }),
  maker,
);

/** Whether the editor should offer question generation at all. */
quizRoutes.get('/api/ai/status', () => ({ available: isConfigured() }), maker);

/**
 * Draft questions from a topic.
 *
 * Deliberately returns text for the paste box rather than writing questions
 * straight into the quiz: a model can be confidently wrong, and the person
 * running the quiz is the one who has to answer for it. The draft goes through
 * the same preview and the same validation as a spreadsheet paste.
 */
quizRoutes.post(
  '/api/quizzes/:quizId/questions/generate',
  async ({ params, body, user }) => {
    quizService.requireOwnedQuiz(params.quizId, user.id);

    const topic = String(body?.topic ?? '').trim();
    if (topic.length < 3) throw badRequest('Describe what the quiz should be about.');
    if (topic.length > 2000) throw badRequest('That topic is too long; summarise it.');

    assertGenerationAllowed(user.id);

    let questions;
    try {
      questions = await generateQuestions({
        topic,
        count: body?.count,
        difficulty: String(body?.difficulty ?? '').slice(0, 40),
        notes: String(body?.notes ?? '').slice(0, 1000),
      });
    } catch (error) {
      // The client library explains what actually went wrong - a missing key,
      // a rejected key, a rate limit. Left unwrapped these become a generic
      // 500 and the teacher is told nothing useful.
      throw new HttpError(isConfigured() ? 502 : 503, error.message);
    }

    return { text: toPasteFormat(questions), count: questions.length };
  },
  maker,
);

/** Paste many questions at once. `dryRun` powers the preview. */
quizRoutes.post(
  '/api/quizzes/:quizId/questions/bulk',
  ({ params, body, user }) =>
    quizService.addQuestionsFromText(params.quizId, body?.text, user.id, {
      dryRun: body?.dryRun === true,
    }),
  maker,
);

quizRoutes.put(
  '/api/quizzes/:quizId/questions/:questionId',
  ({ params, body, user }) => ({
    quiz: quizService.updateQuestion(params.quizId, params.questionId, body, user.id),
  }),
  maker,
);

quizRoutes.delete(
  '/api/quizzes/:quizId/questions/:questionId',
  ({ params, user }) => ({
    quiz: quizService.removeQuestion(params.quizId, params.questionId, user.id),
  }),
  maker,
);

quizRoutes.post(
  '/api/quizzes/:quizId/questions/:questionId/move',
  ({ params, body, user }) => ({
    quiz: quizService.moveQuestion(
      params.quizId,
      params.questionId,
      body?.direction === 'up' ? 'up' : 'down',
      user.id,
    ),
  }),
  maker,
);

/* ---- Sharing and QR codes ---- */

quizRoutes.get(
  '/api/quizzes/:quizId/share',
  ({ params, user }) => {
    const quiz = quizService.requireOwnedQuiz(params.quizId, user.id);
    return {
      quizId: quiz.id,
      joinCode: quiz.id,
      joinUrl: buildJoinUrl(quiz.id),
      qrSvgUrl: `/api/quizzes/${quiz.id}/qr.svg`,
      qrPngUrl: `/api/quizzes/${quiz.id}/qr.png`,
      isPublished: quiz.isPublished,
    };
  },
  maker,
);

quizRoutes.get(
  '/api/quizzes/:quizId/qr.svg',
  ({ params, query, res, user }) => {
    const quiz = quizService.requireOwnedQuiz(params.quizId, user.id);
    const size = clamp(Number(query.get('size') ?? 320), 120, 1024);

    send(res, 200, renderQrSvg(buildJoinUrl(quiz.id), { size, ecLevel: 'Q' }), {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  },
  maker,
);

quizRoutes.get(
  '/api/quizzes/:quizId/qr.png',
  ({ params, query, res, user }) => {
    const quiz = quizService.requireOwnedQuiz(params.quizId, user.id);
    const scale = clamp(Number(query.get('scale') ?? 12), 2, 40);

    send(res, 200, renderQrPng(buildJoinUrl(quiz.id), { scale, ecLevel: 'Q' }), {
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="seguequiz-${quiz.id}.png"`,
      'Cache-Control': 'no-store',
    });
  },
  maker,
);

/* ---- Results: for the maker who owns the quiz, and nobody else ---- */

quizRoutes.get(
  '/api/quizzes/:quizId/results',
  ({ params, user }) => {
    // Ownership is checked first: a taker must not learn who is winning,
    // and the breakdown would hand them the answer key outright.
    quizService.requireOwnedQuiz(params.quizId, user.id);
    return {
      ...leaderboardService.build(params.quizId),
      breakdown: leaderboardService.questionBreakdown(params.quizId),
    };
  },
  maker,
);

/** One participant's paper: what they chose on every question. */
quizRoutes.get(
  '/api/quizzes/:quizId/attempts/:attemptId',
  ({ params, user }) => {
    quizService.requireOwnedQuiz(params.quizId, user.id);
    return leaderboardService.attemptReview(params.quizId, params.attemptId);
  },
  maker,
);

/** Remove one person's result, letting just them take the quiz again. */
quizRoutes.delete(
  '/api/quizzes/:quizId/attempts/:attemptId',
  ({ params, user }) => quizService.removeAttempt(params.quizId, params.attemptId, user.id),
  maker,
);

/** Clear the leaderboard without deleting the quiz. */
quizRoutes.delete(
  '/api/quizzes/:quizId/results',
  ({ params, user }) => quizService.clearResults(params.quizId, user.id),
  maker,
);

quizRoutes.get('/api/quizzes/:quizId/results.csv', ({ params, res, user }) => {
  const quiz = quizService.requireOwnedQuiz(params.quizId, user.id);
  const csv = leaderboardService.toCsv(quiz.id);
  const fileName = `${quiz.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-results.csv`;

  send(res, 200, `﻿${csv}`, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Cache-Control': 'no-store',
  });
}, maker);

/**
 * Generation costs money on somebody's API key, and anybody can register a
 * maker account, so it is capped per account per hour.
 */
const GENERATIONS_PER_HOUR = 20;
const generationLog = new Map();

function assertGenerationAllowed(userId) {
  const now = Date.now();
  const recent = (generationLog.get(userId) ?? []).filter((at) => now - at < 60 * 60 * 1000);

  if (recent.length >= GENERATIONS_PER_HOUR) {
    throw new HttpError(
      429,
      `That is ${GENERATIONS_PER_HOUR} generations this hour, which is the limit. Try again later.`,
    );
  }

  recent.push(now);
  generationLog.set(userId, recent);
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
