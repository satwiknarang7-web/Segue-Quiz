import { config } from '../config.js';
import { sendHtmlPage } from '../lib/http.js';
import { Router } from '../lib/router.js';
import { accountService } from '../services/accountService.js';
import { storageBackend } from '../store/index.js';

/**
 * Readable URLs for every screen.
 *
 * Public: the landing page, sign in / sign up, and taking a quiz.
 * Maker-only: the dashboard, the editor and the leaderboard.
 */
export const pageRoutes = new Router();

const page = (fileName) => async ({ res }) => sendHtmlPage(res, config.publicDir, fileName);

/** Signed-in makers get their dashboard; everyone else gets the landing page. */
pageRoutes.get('/', async ({ req, res }) => {
  if (accountService.currentUser(req)) {
    res.writeHead(302, { Location: '/dashboard', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  await sendHtmlPage(res, config.publicDir, 'landing.html');
});

pageRoutes.get('/dashboard', page('dashboard.html'), { maker: true });
pageRoutes.get('/quizzes/:quizId', page('editor.html'), { maker: true });

pageRoutes.get('/quizzes/:quizId/results', page('results.html'), { maker: true });
pageRoutes.get('/take/:quizId', page('take.html'));
pageRoutes.get('/signin', page('signin.html'));
pageRoutes.get('/signup', page('signup.html'));

/** Liveness probe for the hosting platform. Deliberately reveals nothing. */
pageRoutes.get('/healthz', () => ({ status: 'ok', storage: storageBackend() }));
