import { Router } from '../lib/router.js';
import crypto from 'node:crypto';

import { usesHttps } from '../config.js';
import { attemptService } from '../services/attemptService.js';
import { quizService } from '../services/quizService.js';

export const attemptRoutes = new Router();

/** What a participant sees before typing their name. */
attemptRoutes.get('/api/quizzes/:quizId/intro', ({ params }) => {
  const quiz = quizService.requireQuiz(params.quizId);
  return {
    id: quiz.id,
    title: quiz.title,
    description: quiz.description,
    timeLimitSeconds: quiz.timeLimitSeconds,
    questionCount: quiz.questions.length,
    totalPoints: quizService.totalPoints(quiz),
    isPublished: quiz.isPublished,
    allowRetakes: quiz.allowRetakes,
    endOnLeave: quizService.endsOnLeave(quiz),
  };
});

const DEVICE_COOKIE = 'sq_taker';

/**
 * An opaque marker for the browser taking the quiz.
 *
 * It is not a security credential and is deliberately unsigned: a taker who
 * wants a second go can clear it either way. It exists to stop the trivial
 * bypass - retyping a different name - not a determined one.
 */
function readDeviceId(req) {
  for (const part of (req.headers?.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === DEVICE_COOKIE) {
      return decodeURIComponent(part.slice(index + 1).trim()) || null;
    }
  }
  return null;
}

const deviceCookie = (value) =>
  [
    `${DEVICE_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(usesHttps() ? ['Secure'] : []),
    `Max-Age=${60 * 60 * 24 * 365}`,
  ].join('; ');

attemptRoutes.post('/api/quizzes/:quizId/attempts', ({ params, body, req, res }) => {
  const existing = readDeviceId(req);
  const deviceId = existing ?? crypto.randomUUID();

  // Set it before the attempt is scored, so a first-timer is recognised next time.
  if (!existing) res.setHeader('Set-Cookie', deviceCookie(deviceId));

  return attemptService.start(params.quizId, body, deviceId);
});

attemptRoutes.get('/api/attempts/:attemptId', ({ params }) => attemptService.getState(params.attemptId));

attemptRoutes.post('/api/attempts/:attemptId/answers', ({ params, body }) =>
  attemptService.saveAnswer(params.attemptId, body),
);

attemptRoutes.post('/api/attempts/:attemptId/submit', ({ params, body }) => ({
  result: attemptService.submit(params.attemptId, body),
}));

/**
 * The participant left the quiz - switched tab, switched app, or locked the
 * phone. Reached by navigator.sendBeacon as the page is hidden, so it must
 * stay cheap and must tolerate being called more than once.
 */
attemptRoutes.post('/api/attempts/:attemptId/abandon', ({ params }) => ({
  result: attemptService.abandon(params.attemptId),
}));
