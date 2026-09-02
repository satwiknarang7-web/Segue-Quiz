import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seguequiz-access-'));
process.env.SEGUEQUIZ_DATA_DIR = dataDir;
process.env.SEGUEQUIZ_SIGNUP_CODE = 'MAKER-CODE';

const { handleRequest } = await import('../src/app.js');
const { quizService } = await import('../src/services/quizService.js');
const { quizRepository } = await import('../src/repositories/quizRepository.js');
const { attemptRepository } = await import('../src/repositories/attemptRepository.js');
const { userRepository } = await import('../src/repositories/userRepository.js');
const { generateTotp } = await import('../src/lib/totp.js');

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(() => res.end());
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.close();
  await Promise.all([quizRepository.flushed(), attemptRepository.flushed(), userRepository.flushed()]);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/* ---- Helpers ---- */

const call = (method, pathname, { cookie, body } = {}) =>
  fetch(origin + pathname, {
    method,
    redirect: 'manual',
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

const cookieOf = (response) => (response.headers.get('set-cookie') ?? '').split(';')[0];

let makerCount = 0;

/** Register a maker and walk the whole two-factor enrolment. */
async function createMaker(overrides = {}) {
  makerCount += 1;
  const email = overrides.email ?? `maker${makerCount}@example.test`;

  const signup = await call('POST', '/api/auth/signup', {
    body: {
      name: `Maker ${makerCount}`,
      email,
      password: 'a-long-enough-password',
      signupCode: 'MAKER-CODE',
      ...overrides,
    },
  });
  const signupBody = await signup.json();
  assert.equal(signup.status, 201, JSON.stringify(signupBody));
  const pendingCookie = cookieOf(signup);

  const secret = userRepository.findByEmail(email).totpSecret;
  const activate = await call('POST', '/api/auth/2fa/activate', {
    cookie: pendingCookie,
    body: { code: generateTotp(secret) },
  });
  const activateBody = await activate.json();
  assert.equal(activate.status, 200, JSON.stringify(activateBody));

  return { email, secret, cookie: cookieOf(activate), recoveryCodes: activateBody.recoveryCodes };
}

async function seedQuiz(cookie) {
  const created = await call('POST', '/api/quizzes', {
    cookie,
    body: { title: 'Gated quiz', timeLimitSeconds: 60 },
  });
  const { quiz } = await created.json();

  await call('POST', `/api/quizzes/${quiz.id}/questions`, {
    cookie,
    body: { text: 'Which one is right?', options: ['Right', 'Wrong'], correctIndex: 0 },
  });
  await call('PATCH', `/api/quizzes/${quiz.id}`, { cookie, body: { isPublished: true } });

  return quizService.requireQuiz(quiz.id);
}

/* ---- Sign up and 2FA ---- */

test('signing up requires the maker code', async () => {
  const refused = await call('POST', '/api/auth/signup', {
    body: {
      name: 'Nope',
      email: 'nope@example.test',
      password: 'a-long-enough-password',
      signupCode: 'WRONG',
    },
  });
  assert.equal(refused.status, 403);
  assert.equal(userRepository.findByEmail('nope@example.test'), null);
});

test('a password alone does not sign you in - the second factor is required', async () => {
  const maker = await createMaker();

  const signin = await call('POST', '/api/auth/signin', {
    body: { email: maker.email, password: 'a-long-enough-password' },
  });
  assert.equal(signin.status, 200);
  const pending = cookieOf(signin);
  assert.equal((await signin.json()).requiresSecondFactor, true);

  // The half-session must not open the dashboard or its API.
  assert.equal((await call('GET', '/api/quizzes', { cookie: pending })).status, 401);
  assert.equal((await call('GET', '/dashboard', { cookie: pending })).status, 302);

  const wrong = await call('POST', '/api/auth/2fa/verify', {
    cookie: pending,
    body: { code: '000000' },
  });
  assert.equal(wrong.status, 400);

  const verified = await call('POST', '/api/auth/2fa/verify', {
    cookie: pending,
    body: { code: generateTotp(maker.secret) },
  });
  assert.equal(verified.status, 200);
  assert.equal((await call('GET', '/api/quizzes', { cookie: cookieOf(verified) })).status, 200);
});

test('a recovery code signs you in once and then stops working', async () => {
  const maker = await createMaker();
  const [code] = maker.recoveryCodes;

  const first = await call('POST', '/api/auth/signin', {
    body: { email: maker.email, password: 'a-long-enough-password' },
  });
  const used = await call('POST', '/api/auth/2fa/verify', {
    cookie: cookieOf(first),
    body: { code },
  });
  assert.equal(used.status, 200);
  assert.equal((await used.json()).usedRecoveryCode, true);

  const second = await call('POST', '/api/auth/signin', {
    body: { email: maker.email, password: 'a-long-enough-password' },
  });
  const reused = await call('POST', '/api/auth/2fa/verify', {
    cookie: cookieOf(second),
    body: { code },
  });
  assert.equal(reused.status, 400, 'a recovery code is single use');
});

test('a wrong password is refused without revealing whether the account exists', async () => {
  const maker = await createMaker();

  const wrongPassword = await call('POST', '/api/auth/signin', {
    body: { email: maker.email, password: 'not-the-password' },
  });
  const unknownAccount = await call('POST', '/api/auth/signin', {
    body: { email: 'ghost@example.test', password: 'not-the-password' },
  });

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownAccount.status, 401);
  assert.deepEqual(await wrongPassword.json(), await unknownAccount.json());
});

test('a forged session cookie is rejected', async () => {
  const forged = Buffer.from(
    JSON.stringify({ userId: 'anything', stage: 'active', version: 1, expiresAt: Date.now() + 1000 }),
  ).toString('base64url');

  const response = await call('GET', '/api/quizzes', {
    cookie: `sq_session=${forged}.not-a-real-signature`,
  });
  assert.equal(response.status, 401);
});

/* ---- What quiz takers can reach ---- */

test('quiz takers cannot reach the dashboard or the editor', async () => {
  const maker = await createMaker();
  const quiz = await seedQuiz(maker.cookie);

  const editor = await call('GET', `/quizzes/${quiz.id}`);
  assert.equal(editor.status, 302);
  assert.equal(editor.headers.get('location'), `/signin?next=%2Fquizzes%2F${quiz.id}`);
  assert.equal((await call('GET', '/dashboard')).status, 302);

  assert.equal((await call('GET', `/quizzes/${quiz.id}`, { cookie: maker.cookie })).status, 200);
  assert.equal((await call('GET', '/dashboard', { cookie: maker.cookie })).status, 200);
});

test('quiz takers cannot reach authoring or sharing endpoints', async () => {
  const maker = await createMaker();
  const quiz = await seedQuiz(maker.cookie);

  const blocked = [
    ['GET', '/api/quizzes'],
    ['POST', '/api/quizzes'],
    ['GET', `/api/quizzes/${quiz.id}`],
    ['PATCH', `/api/quizzes/${quiz.id}`],
    ['DELETE', `/api/quizzes/${quiz.id}`],
    ['POST', `/api/quizzes/${quiz.id}/questions`],
    ['GET', `/api/quizzes/${quiz.id}/share`],
    ['GET', `/api/quizzes/${quiz.id}/qr.svg`],
    ['GET', `/api/quizzes/${quiz.id}/qr.png`],
  ];

  for (const [method, pathname] of blocked) {
    assert.equal((await call(method, pathname)).status, 401, `${method} ${pathname} should be gated`);
  }
});

test('the landing page is public and the take flow needs no account', async () => {
  const maker = await createMaker();
  const quiz = await seedQuiz(maker.cookie);

  assert.equal((await call('GET', '/')).status, 200);
  assert.equal((await call('GET', '/signin')).status, 200);
  assert.equal((await call('GET', '/signup')).status, 200);
  assert.equal((await call('GET', `/take/${quiz.id}`)).status, 200);

  const started = await call('POST', `/api/quizzes/${quiz.id}/attempts`, {
    body: { participantName: 'Priya' },
  });
  assert.equal(started.status, 200);
  const { attempt, quiz: participantQuiz } = await started.json();

  await call('POST', `/api/attempts/${attempt.attemptId}/answers`, {
    body: { questionId: participantQuiz.questions[0].id, optionIndex: 0 },
  });
  const submitted = await call('POST', `/api/attempts/${attempt.attemptId}/submit`, { body: {} });
  assert.equal((await submitted.json()).result.score, 1);
});

test('a signed-in maker is sent to the dashboard from the landing page', async () => {
  const maker = await createMaker();
  const response = await call('GET', '/', { cookie: maker.cookie });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/dashboard');
});

/* ---- Answer key protection ---- */

test('the answer key never reaches a quiz taker', async () => {
  const maker = await createMaker();
  const quiz = await seedQuiz(maker.cookie);

  assert.equal((await call('GET', `/api/quizzes/${quiz.id}`)).status, 401);

  const intro = await call('GET', `/api/quizzes/${quiz.id}/intro`);
  assert.ok(!JSON.stringify(await intro.json()).includes('correctIndex'));

  const ownerResults = await (
    await call('GET', `/api/quizzes/${quiz.id}/results`, { cookie: maker.cookie })
  ).json();
  assert.ok(Array.isArray(ownerResults.breakdown));
});

test('quiz takers cannot see the leaderboard at all', async () => {
  const maker = await createMaker();
  const quiz = await seedQuiz(maker.cookie);

  // The page redirects to sign in rather than rendering.
  const page = await call('GET', `/quizzes/${quiz.id}/results`);
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), `/signin?next=%2Fquizzes%2F${quiz.id}%2Fresults`);

  for (const pathname of [`/api/quizzes/${quiz.id}/results`, `/api/quizzes/${quiz.id}/results.csv`]) {
    assert.equal((await call('GET', pathname)).status, 401, `${pathname} should be gated`);
  }

  // Nor can a different maker read someone else's board.
  const other = await createMaker();
  assert.equal(
    (await call('GET', `/api/quizzes/${quiz.id}/results`, { cookie: other.cookie })).status,
    404,
  );
});

test('page shells cannot be fetched as static files', async () => {
  for (const pathname of ['/editor.html', '/dashboard.html', '/landing.html', '/signup.html']) {
    assert.equal((await call('GET', pathname)).status, 404, `${pathname} should not be served`);
  }
  assert.equal((await call('GET', '/css/app.css')).status, 200);
  assert.equal((await call('GET', '/js/api.js')).status, 200);
});

/* ---- Ownership between makers ---- */

test('one maker cannot see or edit another maker\'s quizzes', async () => {
  const alice = await createMaker();
  const mallory = await createMaker();
  const quiz = await seedQuiz(alice.cookie);

  const { quizzes } = await (await call('GET', '/api/quizzes', { cookie: mallory.cookie })).json();
  assert.ok(!quizzes.some((entry) => entry.id === quiz.id), 'the dashboard is scoped to its owner');

  for (const [method, pathname] of [
    ['GET', `/api/quizzes/${quiz.id}`],
    ['PATCH', `/api/quizzes/${quiz.id}`],
    ['DELETE', `/api/quizzes/${quiz.id}`],
    ['GET', `/api/quizzes/${quiz.id}/share`],
  ]) {
    const response = await call(method, pathname, {
      cookie: mallory.cookie,
      body: method === 'PATCH' ? { title: 'Hijack' } : undefined,
    });
    assert.equal(response.status, 404, `${method} ${pathname} should not be reachable`);
  }

  // The original is untouched.
  assert.equal(quizService.requireQuiz(quiz.id).title, 'Gated quiz');

  // Nor can they open its leaderboard.
  assert.equal(
    (await call('GET', `/api/quizzes/${quiz.id}/results`, { cookie: mallory.cookie })).status,
    404,
  );
});

test('signing out invalidates the session', async () => {
  const maker = await createMaker();
  assert.equal((await call('GET', '/api/quizzes', { cookie: maker.cookie })).status, 200);

  const out = await call('POST', '/api/auth/signout', { cookie: maker.cookie });
  assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/);
});
