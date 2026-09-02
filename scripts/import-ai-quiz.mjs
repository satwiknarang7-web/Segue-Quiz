/**
 * Imports the "SegueIT AI Quiz" Google Form into a running SegueQuiz server.
 *
 *   node scripts/import-ai-quiz.mjs
 *
 * Source form:
 * https://docs.google.com/forms/d/e/1FAIpQLSeSV5Fig35B0NEYAC58U3NJzc5uHZhbDLSz5b1apgv87tmiog/viewform
 *
 * The questions live in src/data/aiQuiz.js, shared with the dashboard's
 * one-click import. Easier still: sign in and press the button on an empty
 * dashboard.
 *
 * Sign in with your own maker account by setting four variables:
 *
 *   SEGUEQUIZ_URL       the site, e.g. https://your-app.onrender.com
 *   SEGUEQUIZ_EMAIL     your maker email
 *   SEGUEQUIZ_PASSWORD  your password
 *   SEGUEQUIZ_TOTP      the six digits your authenticator shows right now
 *
 * That code is only valid for about 30 seconds, so run this straight after
 * reading it.
 */

import { AI_QUIZ as QUIZ, AI_QUIZ_QUESTIONS as QUESTIONS } from '../src/data/aiQuiz.js';

const BASE_URL = (process.env.SEGUEQUIZ_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const EMAIL = process.env.SEGUEQUIZ_EMAIL;
const PASSWORD = process.env.SEGUEQUIZ_PASSWORD;
const TOTP = process.env.SEGUEQUIZ_TOTP;

if (!EMAIL || !PASSWORD || !TOTP) {
  console.error('Set SEGUEQUIZ_EMAIL, SEGUEQUIZ_PASSWORD and SEGUEQUIZ_TOTP.');
  console.error('SEGUEQUIZ_TOTP is the code your authenticator app is showing right now.');
  process.exit(1);
}

let cookie = '';

async function call(method, path, body) {
  const response = await fetch(BASE_URL + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} failed: ${payload?.error ?? response.status}`);
  return { payload, response };
}

// Step one: password. This yields a half-session that unlocks only the 2FA step.
const signIn = await call('POST', '/api/auth/signin', { email: EMAIL, password: PASSWORD });
cookie = (signIn.response.headers.get('set-cookie') ?? '').split(';')[0];
if (!cookie) throw new Error('No session cookie returned from sign in.');

if (signIn.payload?.needsEnrolment) {
  throw new Error('That account has not finished setting up two-factor authentication.');
}

// Step two: the authenticator code, which upgrades it to a usable session.
const verified = await call('POST', '/api/auth/2fa/verify', { code: TOTP });
cookie = (verified.response.headers.get('set-cookie') ?? '').split(';')[0] || cookie;

const { payload: created } = await call('POST', '/api/quizzes', QUIZ);
const quizId = created.quiz.id;

for (const [index, question] of QUESTIONS.entries()) {
  await call('POST', `/api/quizzes/${quizId}/questions`, { ...question, points: 1 });
  process.stdout.write(`\r  added ${index + 1}/${QUESTIONS.length} questions`);
}

await call('PATCH', `/api/quizzes/${quizId}`, { isPublished: true });
const { payload: share } = await call('GET', `/api/quizzes/${quizId}/share`);

console.log(`\n\n  ${QUIZ.title} imported and opened.`);
console.log(`  Join code: ${share.joinCode}`);
console.log(`  Join URL:  ${share.joinUrl}`);
console.log(`  Editor:    ${BASE_URL}/quizzes/${quizId}\n`);
