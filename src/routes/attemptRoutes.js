import { Router } from '../lib/router.js';
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

attemptRoutes.post('/api/quizzes/:quizId/attempts', ({ params, body }) =>
  attemptService.start(params.quizId, body),
);

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
