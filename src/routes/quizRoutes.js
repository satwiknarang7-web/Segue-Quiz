import { buildJoinUrl } from '../config.js';
import { AI_QUIZ, AI_QUIZ_QUESTIONS } from '../data/aiQuiz.js';
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

/**
 * One-click import of the bundled SegueIT AI Quiz, created under whoever is
 * signed in. Saves a new maker staring at an empty dashboard, and means the
 * quiz can be added without anyone handing over their password to a script.
 */
quizRoutes.post(
  '/api/quizzes/import/ai-quiz',
  ({ user }) => {
    const quiz = quizService.createWithQuestions(
      { quiz: AI_QUIZ, questions: AI_QUIZ_QUESTIONS },
      user.id,
    );
    return { quiz, joinUrl: buildJoinUrl(quiz.id) };
  },
  maker,
);

/* ---- Questions ---- */

quizRoutes.post(
  '/api/quizzes/:quizId/questions',
  ({ params, body, user }) => ({ quiz: quizService.addQuestion(params.quizId, body, user.id) }),
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

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
