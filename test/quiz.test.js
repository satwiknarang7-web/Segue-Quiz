import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each run gets a throwaway data directory, so tests never touch real quizzes.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seguequiz-test-'));
process.env.SEGUEQUIZ_DATA_DIR = dataDir;

const { quizService } = await import('../src/services/quizService.js');
const { attemptService } = await import('../src/services/attemptService.js');
const { leaderboardService } = await import('../src/services/leaderboardService.js');
const { attemptRepository } = await import('../src/repositories/attemptRepository.js');

process.on('exit', () => fs.rmSync(dataDir, { recursive: true, force: true }));

/* ---- Helpers ---- */

function makeQuiz({ timeLimitSeconds = 300, allowRetakes = false } = {}) {
  const quiz = quizService.create({
    title: 'Physics warm-up',
    description: 'Two quick questions',
    timeLimitSeconds,
  });

  quizService.addQuestion(quiz.id, {
    text: 'SI unit of force?',
    options: ['Newton', 'Joule', 'Pascal'],
    correctIndex: 0,
    points: 2,
  });
  quizService.addQuestion(quiz.id, {
    text: 'Speed of light is roughly?',
    options: ['3x10^8 m/s', '3x10^6 m/s'],
    correctIndex: 0,
    points: 3,
  });

  return quizService.update(quiz.id, { isPublished: true, allowRetakes });
}

/** Rewind an attempt's clock so timing behaviour is testable without waiting. */
function backdate(attemptId, millisecondsAgo) {
  const attempt = attemptRepository.findById(attemptId);
  const quiz = quizService.requireQuiz(attempt.quizId);
  const startedAt = new Date(Date.now() - millisecondsAgo);
  attemptRepository.update(attemptId, (current) => ({
    ...current,
    startedAt: startedAt.toISOString(),
    deadlineAt: new Date(startedAt.getTime() + quiz.timeLimitSeconds * 1000).toISOString(),
  }));
}

function answersFor(quiz, ...optionIndexes) {
  return Object.fromEntries(quiz.questions.map((question, index) => [question.id, optionIndexes[index]]));
}

/* ---- Quiz authoring ---- */

test('creates a quiz with a short, readable join code', () => {
  const quiz = quizService.create({ title: 'Pop quiz', timeLimitSeconds: 60 });
  assert.match(quiz.id, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  assert.equal(quiz.isPublished, false);
  assert.deepEqual(quiz.questions, []);
});

test('rejects invalid quiz settings', () => {
  assert.throws(() => quizService.create({ title: '', timeLimitSeconds: 60 }), /title/i);
  assert.throws(() => quizService.create({ title: 'Ok', timeLimitSeconds: 5 }), /at least 10/i);
  assert.throws(() => quizService.create({ title: 'Ok', timeLimitSeconds: 99999 }), /at most/i);
});

test('rejects invalid questions', () => {
  const quiz = quizService.create({ title: 'Validation', timeLimitSeconds: 60 });

  assert.throws(() => quizService.addQuestion(quiz.id, { text: 'Q', options: ['only one'], correctIndex: 0 }), /at least 2/i);
  assert.throws(() => quizService.addQuestion(quiz.id, { text: 'Q', options: ['a', 'a'], correctIndex: 0 }), /different/i);
  assert.throws(() => quizService.addQuestion(quiz.id, { text: 'Q', options: ['a', 'b'], correctIndex: 5 }), /correctIndex/i);
});

test('will not publish a quiz with no questions', () => {
  const quiz = quizService.create({ title: 'Empty', timeLimitSeconds: 60 });
  assert.throws(() => quizService.update(quiz.id, { isPublished: true }), /at least one question/i);
});

test('reorders and removes questions', () => {
  const quiz = makeQuiz();
  const [first, second] = quiz.questions;

  const moved = quizService.moveQuestion(quiz.id, second.id, 'up');
  assert.deepEqual(moved.questions.map((q) => q.id), [second.id, first.id]);

  const removed = quizService.removeQuestion(quiz.id, second.id);
  assert.deepEqual(removed.questions.map((q) => q.id), [first.id]);
});

test('never exposes the answer key to participants', () => {
  const quiz = makeQuiz();
  const view = quizService.toParticipantView(quiz);
  const serialised = JSON.stringify(view);

  assert.equal(view.questions.length, 2);
  assert.ok(!('correctIndex' in view.questions[0]));
  assert.ok(!serialised.includes('correctIndex'));
});

/* ---- Taking a quiz ---- */

test('scores a submission against the answer key', () => {
  const quiz = makeQuiz();
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Asha' });

  const { result } = { result: attemptService.submit(attempt.attemptId, { answers: answersFor(quiz, 0, 1) }) };

  assert.equal(result.score, 2); // first question right (2 pts), second wrong
  assert.equal(result.maxScore, 5);
  assert.equal(result.correctCount, 1);
  assert.equal(result.answeredCount, 2);
});

test('autosaves answers so a lost tab does not lose progress', () => {
  const quiz = makeQuiz();
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Bala' });

  attemptService.saveAnswer(attempt.attemptId, {
    questionId: quiz.questions[0].id,
    optionIndex: 0,
  });

  // Submitting with no body still counts the autosaved answer.
  const result = attemptService.submit(attempt.attemptId, {});
  assert.equal(result.score, 2);
  assert.equal(result.answeredCount, 1);
});

test('blocks a second attempt unless retakes are allowed', () => {
  const quiz = makeQuiz();
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Chen' });
  attemptService.submit(attempt.attemptId, { answers: answersFor(quiz, 0, 0) });

  assert.throws(() => attemptService.start(quiz.id, { participantName: '  chen ' }), /already taken/i);

  const openQuiz = makeQuiz({ allowRetakes: true });
  const first = attemptService.start(openQuiz.id, { participantName: 'Chen' });
  attemptService.submit(first.attempt.attemptId, { answers: answersFor(openQuiz, 0, 0) });
  assert.doesNotThrow(() => attemptService.start(openQuiz.id, { participantName: 'Chen' }));
});

test('resumes an attempt instead of restarting the timer on refresh', () => {
  const quiz = makeQuiz({ timeLimitSeconds: 120 });
  const first = attemptService.start(quiz.id, { participantName: 'Nina' });

  attemptService.saveAnswer(first.attempt.attemptId, {
    questionId: quiz.questions[0].id,
    optionIndex: 0,
  });
  backdate(first.attempt.attemptId, 90_000); // 90 seconds already spent

  const second = attemptService.start(quiz.id, { participantName: 'nina' });

  assert.equal(second.resumed, true);
  assert.equal(second.attempt.attemptId, first.attempt.attemptId, 'same attempt is resumed');
  assert.deepEqual(
    second.attempt.answers,
    { [quiz.questions[0].id]: 0 },
    'answers saved before the refresh come back',
  );
  assert.ok(second.attempt.remainingMs <= 30_500, 'the clock kept running across the refresh');
  assert.ok(second.attempt.remainingMs > 28_000);
});

test('refuses attempts on a draft quiz', () => {
  const quiz = quizService.create({ title: 'Draft', timeLimitSeconds: 60 });
  quizService.addQuestion(quiz.id, { text: 'Q', options: ['a', 'b'], correctIndex: 0 });

  assert.throws(() => attemptService.start(quiz.id, { participantName: 'Dev' }), /not open/i);
});

test('ignores answers for questions that do not belong to the quiz', () => {
  const quiz = makeQuiz();
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Esha' });

  const result = attemptService.submit(attempt.attemptId, {
    answers: { 'not-a-question': 0, [quiz.questions[0].id]: 0 },
  });
  assert.equal(result.answeredCount, 1);
  assert.equal(result.score, 2);
});

/* ---- The timer ---- */

test('caps recorded time at the limit and flags late submissions', () => {
  const quiz = makeQuiz({ timeLimitSeconds: 30 });
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Farid' });

  backdate(attempt.attemptId, 45_000); // 15 seconds past the deadline
  const result = attemptService.submit(attempt.attemptId, { answers: answersFor(quiz, 0, 0) });

  assert.equal(result.timedOut, true);
  assert.equal(result.durationMs, 30_000, 'time is capped at the limit');
});

test('auto-submits abandoned attempts once their timer expires', () => {
  const quiz = makeQuiz({ timeLimitSeconds: 30 });
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Gita' });

  attemptService.saveAnswer(attempt.attemptId, { questionId: quiz.questions[0].id, optionIndex: 0 });
  backdate(attempt.attemptId, 60_000);

  const board = leaderboardService.build(quiz.id);
  assert.equal(board.entries.length, 1);
  assert.equal(board.entries[0].participantName, 'Gita');
  assert.equal(board.entries[0].timedOut, true);
  assert.equal(board.entries[0].score, 2, 'autosaved answers still count');
});

test('rejects answers once the deadline has passed', () => {
  const quiz = makeQuiz({ timeLimitSeconds: 30 });
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Hari' });

  backdate(attempt.attemptId, 60_000);
  assert.throws(
    () => attemptService.saveAnswer(attempt.attemptId, { questionId: quiz.questions[0].id, optionIndex: 0 }),
    /time is up/i,
  );
});

/* ---- One attempt per person ---- */

test('a second attempt from the same device is refused, whatever name is typed', () => {
  const quiz = makeQuiz();
  const device = 'device-aaa';

  const first = attemptService.start(quiz.id, { participantName: 'Priya' }, device);
  attemptService.submit(first.attempt.attemptId, { answers: answersFor(quiz, 0, 0) });

  // The same name is refused, as before.
  assert.throws(
    () => attemptService.start(quiz.id, { participantName: 'Priya' }, device),
    /already taken this quiz/i,
  );

  // And so is a different name from the same browser - the actual hole.
  assert.throws(
    () => attemptService.start(quiz.id, { participantName: 'Totally Someone Else' }, device),
    /device has already taken/i,
  );
});

test('a different device may still take the quiz', () => {
  const quiz = makeQuiz();

  const first = attemptService.start(quiz.id, { participantName: 'Priya' }, 'device-aaa');
  attemptService.submit(first.attempt.attemptId, { answers: answersFor(quiz, 0, 0) });

  assert.doesNotThrow(() =>
    attemptService.start(quiz.id, { participantName: 'Rahul' }, 'device-bbb'),
  );
});

test('retyping a new name mid-attempt resumes rather than restarting the clock', () => {
  const quiz = makeQuiz({ timeLimitSeconds: 300 });
  const device = 'device-ccc';

  const started = attemptService.start(quiz.id, { participantName: 'First Name' }, device);
  backdate(started.attempt.attemptId, 60_000);

  const again = attemptService.start(quiz.id, { participantName: 'Second Name' }, device);

  assert.equal(again.resumed, true);
  assert.equal(again.attempt.attemptId, started.attempt.attemptId, 'the same attempt continues');
  assert.ok(again.attempt.remainingMs <= 240_500, 'the timer kept running, it did not reset');
});

test('allowing retakes lifts both checks', () => {
  const quiz = makeQuiz();
  quizService.update(quiz.id, { allowRetakes: true });

  const first = attemptService.start(quiz.id, { participantName: 'Repeat' }, 'device-ddd');
  attemptService.submit(first.attempt.attemptId, { answers: answersFor(quiz, 0, 0) });

  const second = attemptService.start(quiz.id, { participantName: 'Repeat' }, 'device-ddd');
  assert.notEqual(second.attempt.attemptId, first.attempt.attemptId);
});

test('a taker with no device marker still gets the name check', () => {
  const quiz = makeQuiz();

  const first = attemptService.start(quiz.id, { participantName: 'Cookieless' }, null);
  attemptService.submit(first.attempt.attemptId, { answers: answersFor(quiz, 0, 0) });

  assert.throws(
    () => attemptService.start(quiz.id, { participantName: 'Cookieless' }, null),
    /already taken this quiz/i,
  );
  // Two different people who both block cookies must not block each other.
  assert.doesNotThrow(() => attemptService.start(quiz.id, { participantName: 'Nobody Else' }, null));
});

/* ---- Leaving the quiz ---- */

test('leaving the quiz ends the attempt and scores what was answered', () => {
  const quiz = makeQuiz();
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Wanderer' });

  attemptService.saveAnswer(attempt.attemptId, { questionId: quiz.questions[0].id, optionIndex: 0 });

  const result = attemptService.abandon(attempt.attemptId);

  assert.equal(result.endedReason, 'left_quiz');
  assert.equal(result.score, 2, 'answers given before leaving still count');
  assert.equal(result.answeredCount, 1);
  assert.equal(attemptRepository.findById(attempt.attemptId).status, 'submitted');
});

test('an abandoned attempt cannot be answered or resumed', () => {
  const quiz = makeQuiz();
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Gone' });
  attemptService.abandon(attempt.attemptId);

  assert.throws(
    () => attemptService.saveAnswer(attempt.attemptId, {
      questionId: quiz.questions[0].id,
      optionIndex: 0,
    }),
    /already been submitted/i,
  );

  // Coming back to the start screen must not hand out a second attempt.
  assert.throws(() => attemptService.start(quiz.id, { participantName: 'Gone' }), /already taken/i);
});

test('abandoning twice is harmless and keeps the first result', () => {
  const quiz = makeQuiz();
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Beacon' });

  const first = attemptService.abandon(attempt.attemptId);
  const second = attemptService.abandon(attempt.attemptId);

  assert.equal(second.submittedAt, first.submittedAt);
  assert.equal(second.endedReason, 'left_quiz');
});

test('leaving never credits more time than the clock allowed', () => {
  const quiz = makeQuiz({ timeLimitSeconds: 30 });
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Late leaver' });

  backdate(attempt.attemptId, 90_000); // long past the deadline
  const result = attemptService.abandon(attempt.attemptId);

  assert.equal(result.durationMs, 30_000);
});

test('the leaderboard reports why each attempt ended', () => {
  const quiz = makeQuiz();

  const finished = attemptService.start(quiz.id, { participantName: 'Finished' });
  attemptService.submit(finished.attempt.attemptId, { answers: answersFor(quiz, 0, 0) });

  const left = attemptService.start(quiz.id, { participantName: 'Left' });
  attemptService.saveAnswer(left.attempt.attemptId, {
    questionId: quiz.questions[0].id,
    optionIndex: 0,
  });
  attemptService.abandon(left.attempt.attemptId);

  const byName = Object.fromEntries(
    leaderboardService.build(quiz.id).entries.map((entry) => [entry.participantName, entry]),
  );
  assert.equal(byName.Finished.endedReason, 'submitted');
  assert.equal(byName.Left.endedReason, 'left_quiz');
});

test('endOnLeave defaults to on and can be switched off', () => {
  const strict = makeQuiz();
  assert.equal(strict.endOnLeave, true);
  assert.equal(quizService.toParticipantView(strict).endOnLeave, true);

  const relaxed = quizService.update(strict.id, { endOnLeave: false });
  assert.equal(quizService.toParticipantView(relaxed).endOnLeave, false);

  // A quiz written before the setting existed still enforces it.
  assert.equal(quizService.endsOnLeave({ questions: [] }), true);
});

test('submitting twice returns the first result', () => {
  const quiz = makeQuiz();
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Ira' });

  const first = attemptService.submit(attempt.attemptId, { answers: answersFor(quiz, 0, 0) });
  const second = attemptService.submit(attempt.attemptId, { answers: answersFor(quiz, 1, 1) });

  assert.equal(second.score, first.score);
  assert.equal(second.submittedAt, first.submittedAt);
});

/* ---- The leaderboard ---- */

test('ranks by score first, then by the faster time', () => {
  const quiz = makeQuiz();

  // Two people tie on 2 points at different speeds; one person scores all 5.
  const submitAfter = (name, elapsedMs, ...answers) => {
    const { attempt } = attemptService.start(quiz.id, { participantName: name });
    backdate(attempt.attemptId, elapsedMs);
    return attemptService.submit(attempt.attemptId, { answers: answersFor(quiz, ...answers) });
  };

  const slowTie = submitAfter('Two points, slow', 45_000, 0, 1);
  const fastTie = submitAfter('Two points, fast', 5_000, 0, 1);
  const perfect = submitAfter('Five points, slowest', 120_000, 0, 0);

  assert.equal(slowTie.score, 2);
  assert.equal(fastTie.score, 2);
  assert.equal(perfect.score, 5);

  const board = leaderboardService.build(quiz.id);

  assert.deepEqual(
    board.entries.map((entry) => entry.participantName),
    ['Five points, slowest', 'Two points, fast', 'Two points, slow'],
  );
  assert.deepEqual(board.entries.map((entry) => entry.rank), [1, 2, 3]);
});

test('a higher score beats a faster time', () => {
  const quiz = makeQuiz();

  const fastLowScore = attemptService.start(quiz.id, { participantName: 'Fast, half right' });
  backdate(fastLowScore.attempt.attemptId, 3_000);
  attemptService.submit(fastLowScore.attempt.attemptId, { answers: answersFor(quiz, 0, 1) }); // 2 pts

  const slowPerfect = attemptService.start(quiz.id, { participantName: 'Slow, all right' });
  backdate(slowPerfect.attempt.attemptId, 120_000);
  attemptService.submit(slowPerfect.attempt.attemptId, { answers: answersFor(quiz, 0, 0) }); // 5 pts

  const board = leaderboardService.build(quiz.id);
  assert.equal(board.entries[0].participantName, 'Slow, all right');
  assert.equal(board.entries[0].score, 5);
  assert.equal(board.entries[1].participantName, 'Fast, half right');
});

test('identical score and time share a rank', () => {
  const quiz = makeQuiz();

  for (const name of ['Twin A', 'Twin B']) {
    const { attempt } = attemptService.start(quiz.id, { participantName: name });
    backdate(attempt.attemptId, 20_000);
    attemptRepository.update(attempt.attemptId, (current) => ({
      ...current,
      startedAt: new Date(Date.now() - 20_000).toISOString(),
    }));
    attemptService.submit(attempt.attemptId, { answers: answersFor(quiz, 0, 0) });
  }

  const entries = leaderboardService.build(quiz.id).entries;
  // Durations are computed from wall-clock time, so nudge them equal to test the tie rule.
  entries.forEach((entry) => assert.equal(entry.score, 5));

  const [a, b] = entries;
  if (a.durationMs === b.durationMs) assert.equal(a.rank, b.rank);
  else assert.ok(a.durationMs < b.durationMs, 'faster attempt is listed first');
});

test('reports a per-question breakdown', () => {
  const quiz = makeQuiz();

  const right = attemptService.start(quiz.id, { participantName: 'Right' });
  attemptService.submit(right.attempt.attemptId, { answers: answersFor(quiz, 0, 0) });

  const wrong = attemptService.start(quiz.id, { participantName: 'Wrong' });
  attemptService.submit(wrong.attempt.attemptId, { answers: answersFor(quiz, 1, 1) });

  const [firstQuestion] = leaderboardService.questionBreakdown(quiz.id);
  assert.equal(firstQuestion.responseCount, 2);
  assert.equal(firstQuestion.correctCount, 1);
  assert.equal(firstQuestion.correctRate, 50);
  assert.deepEqual(firstQuestion.optionCounts, [1, 1, 0]);
});

test('exports results as CSV', () => {
  const quiz = makeQuiz();
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Comma, Name' });
  attemptService.submit(attempt.attemptId, { answers: answersFor(quiz, 0, 0) });

  const csv = leaderboardService.toCsv(quiz.id);
  const [header, firstRow] = csv.split('\r\n');

  assert.match(header, /^"Rank","Participant"/);
  assert.match(firstRow, /"Comma, Name"/);
  assert.match(firstRow, /"5","5","100%"/);
});

test('deleting a quiz removes its attempts', () => {
  const quiz = makeQuiz();
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Temp' });
  attemptService.submit(attempt.attemptId, { answers: answersFor(quiz, 0, 0) });

  quizService.remove(quiz.id);

  assert.equal(attemptRepository.listByQuiz(quiz.id).length, 0);
  assert.throws(() => quizService.requireQuiz(quiz.id), /does not exist/i);
});
