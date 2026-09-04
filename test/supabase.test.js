import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/* ------------------------------------------------------------------ *
 * A stand-in for Supabase's PostgREST endpoint.
 *
 * It speaks the slice of the protocol this app uses - select all, upsert
 * one row, delete by a single equality filter - and keeps rows in memory
 * so the test can inspect exactly what was written, column by column.
 * ------------------------------------------------------------------ */

const tables = { users: [], quizzes: [], attempts: [] };
const requests = [];
let failNextWrite = false;

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
};

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const [, , , table] = url.pathname.split('/'); // /rest/v1/<table>
  requests.push(`${req.method} ${table}`);

  if (!tables[table]) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: `relation "${table}" does not exist` }));
    return;
  }

  if (req.method === 'GET') {
    // A ?select=col,col probe checks the schema; answer it like Postgres would.
    const select = url.searchParams.get('select') ?? '*';
    if (select !== '*') {
      const wanted = select.split(',');
      const known = {
        quizzes: ['id', 'owner_id', 'shuffle_questions', 'shuffle_options', 'reveal_answers'],
        attempts: ['id', 'device_id', 'marks', 'pending_mark_count'],
        users: ['id'],
      }[table] ?? ['id'];
      const missing = wanted.find((column) => !known.includes(column));

      if (missing) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: `column ${table}.${missing} does not exist` }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tables[table]));
    return;
  }

  if (req.method === 'POST') {
    const [row] = await readBody(req);

    if (failNextWrite) {
      failNextWrite = false;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'connection reset by peer' }));
      return;
    }

    const index = tables[table].findIndex((existing) => existing.id === row.id);
    if (index === -1) tables[table].push(row);
    else tables[table][index] = row;
    res.writeHead(201).end();
    return;
  }

  if (req.method === 'DELETE') {
    const [column, predicate] = [...url.searchParams.entries()][0] ?? [];
    const value = String(predicate ?? '').replace(/^eq\./, '');
    tables[table] = tables[table].filter((row) => String(row[column]) !== value);
    res.writeHead(204).end();
    return;
  }

  res.writeHead(405).end();
});

await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));

process.env.SUPABASE_URL = `http://127.0.0.1:${fake.address().port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
process.env.SEGUEQUIZ_SIGNUP_CODE = 'MAKER-CODE';

const { config } = await import('../src/config.js');
const { initialiseStores, storageBackend } = await import('../src/store/index.js');
const { quizService } = await import('../src/services/quizService.js');
const { attemptService } = await import('../src/services/attemptService.js');
const { leaderboardService } = await import('../src/services/leaderboardService.js');
const { quizRepository } = await import('../src/repositories/quizRepository.js');
const { attemptRepository } = await import('../src/repositories/attemptRepository.js');

await initialiseStores();

test.after(() => {
  // fetch holds keep-alive sockets open; without this the process never exits.
  fake.closeAllConnections?.();
  fake.close();
});

const settled = () =>
  Promise.all([quizRepository.flushed(), attemptRepository.flushed()]);

/* ---- Tests ---- */

test('Supabase is selected when both settings are present', () => {
  assert.equal(config.supabase.enabled, true);
  assert.equal(storageBackend(), 'supabase');
});

test('half-configured Supabase settings are refused rather than ignored', async () => {
  const realUrl = config.supabase.url;
  const realKey = config.supabase.serviceRoleKey;

  config.supabase.serviceRoleKey = '';
  await assert.rejects(initialiseStores(), /SUPABASE_SERVICE_ROLE_KEY is missing/);

  config.supabase.url = '';
  config.supabase.serviceRoleKey = realKey;
  await assert.rejects(initialiseStores(), /SUPABASE_URL is missing/);

  config.supabase.url = realUrl;
  await initialiseStores(); // put the stores back the way the other tests expect
});

test('a quiz is written as snake_case columns', async () => {
  const quiz = quizService.create(
    { title: 'Postgres quiz', description: 'Stored remotely', timeLimitSeconds: 90 },
    'owner-1',
  );
  quizService.addQuestion(
    quiz.id,
    { text: 'Is it persisted?', options: ['Yes', 'No'], correctIndex: 0, points: 3 },
    'owner-1',
  );
  await settled();

  const row = tables.quizzes.find((candidate) => candidate.id === quiz.id);
  assert.ok(row, 'the row reached the database');

  assert.deepEqual(Object.keys(row).sort(), [
    'allow_retakes',
    'created_at',
    'description',
    'end_on_leave',
    'id',
    'is_published',
    'owner_id',
    'questions',
    'reveal_answers',
    'shuffle_options',
    'shuffle_questions',
    'time_limit_seconds',
    'title',
    'updated_at',
  ]);

  assert.equal(row.owner_id, 'owner-1');
  assert.equal(row.time_limit_seconds, 90);
  assert.equal(row.is_published, false);
  assert.equal(row.end_on_leave, true);
  assert.equal(row.questions.length, 1);
  assert.equal(row.questions[0].correctIndex, 0, 'questions ride along as jsonb');
});

test('an attempt is written as snake_case columns', async () => {
  const quiz = quizService.create({ title: 'Attempt columns', timeLimitSeconds: 60 }, 'owner-1');
  quizService.addQuestion(
    quiz.id,
    { text: 'Pick one', options: ['A', 'B'], correctIndex: 1, points: 2 },
    'owner-1',
  );
  quizService.update(quiz.id, { isPublished: true }, 'owner-1');

  const { attempt, quiz: view } = attemptService.start(quiz.id, { participantName: 'Rae' });
  attemptService.saveAnswer(attempt.attemptId, {
    questionId: view.questions[0].id,
    optionIndex: 1,
  });
  attemptService.submit(attempt.attemptId, {});
  await settled();

  const row = tables.attempts.find((candidate) => candidate.id === attempt.attemptId);
  assert.ok(row);
  assert.equal(row.quiz_id, quiz.id);
  assert.equal(row.participant_name, 'Rae');
  assert.equal(row.participant_key, 'rae');
  assert.equal(row.status, 'submitted');
  assert.equal(row.ended_reason, 'submitted');
  assert.equal(row.score, 2);
  assert.equal(row.max_score, 2);
  assert.equal(row.correct_count, 1);
  assert.equal(row.answered_count, 1);
  assert.equal(typeof row.answers, 'object');
  assert.ok(!('quizId' in row), 'no camelCase leaks into the table');
});

test('leaving a quiz is recorded in the database', async () => {
  const quiz = quizService.create({ title: 'Leaver', timeLimitSeconds: 60 }, 'owner-1');
  quizService.addQuestion(quiz.id, { text: 'Q', options: ['A', 'B'], correctIndex: 0 }, 'owner-1');
  quizService.update(quiz.id, { isPublished: true }, 'owner-1');

  const { attempt } = attemptService.start(quiz.id, { participantName: 'Wanderer' });
  attemptService.abandon(attempt.attemptId);
  await settled();

  const row = tables.attempts.find((candidate) => candidate.id === attempt.attemptId);
  assert.equal(row.ended_reason, 'left_quiz');
  assert.equal(row.status, 'submitted');
});

test('deleting a quiz removes it and its attempts from the database', async () => {
  const quiz = quizService.create({ title: 'Doomed', timeLimitSeconds: 60 }, 'owner-1');
  quizService.addQuestion(quiz.id, { text: 'Q', options: ['A', 'B'], correctIndex: 0 }, 'owner-1');
  quizService.update(quiz.id, { isPublished: true }, 'owner-1');

  const { attempt } = attemptService.start(quiz.id, { participantName: 'Doomed taker' });
  attemptService.submit(attempt.attemptId, {});
  await settled();
  assert.ok(tables.attempts.some((row) => row.quiz_id === quiz.id));

  quizService.remove(quiz.id, 'owner-1');
  await settled();

  assert.ok(!tables.quizzes.some((row) => row.id === quiz.id), 'quiz row deleted');
  assert.ok(!tables.attempts.some((row) => row.quiz_id === quiz.id), 'its attempts deleted');
});

test('rows read back from the database rebuild the domain objects', async () => {
  const quiz = quizService.create(
    { title: 'Round trip', description: 'there and back', timeLimitSeconds: 120 },
    'owner-2',
  );
  quizService.addQuestion(
    quiz.id,
    { text: 'Survives?', options: ['Yes', 'No', 'Maybe'], correctIndex: 0, points: 5 },
    'owner-2',
  );
  quizService.update(quiz.id, { isPublished: true, endOnLeave: false }, 'owner-2');

  const { attempt } = attemptService.start(quiz.id, { participantName: 'Round Tripper' });
  attemptService.submit(attempt.attemptId, {});
  await settled();

  // Reload every store, exactly as a restart would.
  await initialiseStores();

  const reloaded = quizService.requireQuiz(quiz.id);
  assert.equal(reloaded.title, 'Round trip');
  assert.equal(reloaded.description, 'there and back');
  assert.equal(reloaded.ownerId, 'owner-2');
  assert.equal(reloaded.timeLimitSeconds, 120);
  assert.equal(reloaded.isPublished, true);
  assert.equal(reloaded.endOnLeave, false);
  assert.equal(reloaded.questions.length, 1);
  assert.equal(reloaded.questions[0].points, 5);
  assert.equal(reloaded.questions[0].correctIndex, 0);

  const board = leaderboardService.build(quiz.id);
  assert.equal(board.entries.length, 1);
  assert.equal(board.entries[0].participantName, 'Round Tripper');

  // Ownership still works after a reload, which is what gates the editor.
  assert.doesNotThrow(() => quizService.requireOwnedQuiz(quiz.id, 'owner-2'));
  assert.throws(() => quizService.requireOwnedQuiz(quiz.id, 'someone-else'), /does not exist/i);
});

test('a quiz with no owner survives the round trip and can be adopted', async () => {
  const quiz = quizService.create({ title: 'Ownerless', timeLimitSeconds: 60 }, undefined);
  await settled();

  const row = tables.quizzes.find((candidate) => candidate.id === quiz.id);
  assert.equal(row.owner_id, null, 'stored as SQL NULL, not the string "undefined"');

  await initialiseStores();
  assert.equal('ownerId' in quizService.requireQuiz(quiz.id), false);

  assert.ok(quizService.adoptOwnerless('new-owner') >= 1);
  await settled();

  const adopted = tables.quizzes.find((candidate) => candidate.id === quiz.id);
  assert.equal(adopted.owner_id, 'new-owner');
});

test('a failed write is logged but never crashes the app', async () => {
  const quiz = quizService.create({ title: 'Unreliable', timeLimitSeconds: 60 }, 'owner-1');
  await settled();

  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));

  failNextWrite = true; // the next upsert comes back 500, as a dropped link would
  quizService.update(quiz.id, { title: 'Renamed while offline' }, 'owner-1');
  await settled();

  console.error = realError;

  assert.ok(
    errors.some((line) => line.includes('write to quizzes failed')),
    `expected a logged failure, saw: ${JSON.stringify(errors)}`,
  );
  // The in-memory copy is still correct, so the app carries on serving.
  assert.equal(quizService.requireQuiz(quiz.id).title, 'Renamed while offline');

  // And the queue is not poisoned - the next write still lands.
  quizService.update(quiz.id, { title: 'Back online' }, 'owner-1');
  await settled();
  const row = tables.quizzes.find((candidate) => candidate.id === quiz.id);
  assert.equal(row.title, 'Back online');
});
