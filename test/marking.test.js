import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seguequiz-mark-'));
process.env.SEGUEQUIZ_DATA_DIR = dataDir;

const { quizService } = await import('../src/services/quizService.js');
const { attemptService } = await import('../src/services/attemptService.js');
const { leaderboardService } = await import('../src/services/leaderboardService.js');
const { storeUploadedImage } = await import('../src/store/mediaStore.js');
const { awardFor, needsMarking, isCorrect } = await import('../src/lib/questionTypes.js');

process.on('exit', () => fs.rmSync(dataDir, { recursive: true, force: true }));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const drawing = () => storeUploadedImage({ data: PNG.toString('base64') });

/** One choice question worth 2, one drawn question worth 6. */
function makeQuiz() {
  const quiz = quizService.create({ title: 'Mixed marking', timeLimitSeconds: 600 });

  quizService.addQuestion(quiz.id, {
    text: 'SI unit of force?',
    options: ['Newton', 'Joule'],
    correctIndex: 0,
    points: 2,
  });
  quizService.addQuestion(quiz.id, {
    type: 'draw',
    text: 'Draw the circuit',
    points: 6,
  });

  return quizService.update(quiz.id, { isPublished: true, allowRetakes: true, revealAnswers: true });
}

/* ---- What a drawn question is ------------------------------------------- */

test('a drawn question needs a person and has no answer key', () => {
  const quiz = makeQuiz();
  const drawn = quiz.questions[1];

  assert.equal(drawn.type, 'draw');
  assert.equal(needsMarking(drawn), true);
  assert.equal(drawn.options, undefined);
  assert.equal(drawn.correctIndex, undefined);
  assert.equal(drawn.acceptedAnswers, undefined);
});

test('a drawing is never automatically correct', () => {
  const drawn = { type: 'draw', points: 6 };
  // Whatever it contains, nothing here can judge it.
  assert.equal(isCorrect(drawn, '/media/anything.png'), false);
});

test('an unmarked drawing is worth nothing, and says so', () => {
  const drawn = { type: 'draw', points: 6 };

  assert.deepEqual(awardFor(drawn, '/media/x.png', null), { points: 0, pending: true });
  // Nothing drawn is not pending: it is already worth zero.
  assert.deepEqual(awardFor(drawn, null, null), { points: 0, pending: false });
});

test('a mark is clamped to what the question is worth', () => {
  const drawn = { type: 'draw', points: 6 };

  assert.equal(awardFor(drawn, '/media/x.png', { points: 99 }).points, 6);
  assert.equal(awardFor(drawn, '/media/x.png', { points: -4 }).points, 0);
  assert.equal(awardFor(drawn, '/media/x.png', { points: 3.6 }).points, 4);
  // A value that is not a number at all leaves it unmarked rather than zero.
  assert.equal(awardFor(drawn, '/media/x.png', { points: 'lots' }).pending, true);
});

/* ---- Submitting one ------------------------------------------------------ */

async function submitWithDrawing(quiz, name) {
  const { attempt } = attemptService.start(quiz.id, { participantName: name }, `device-${name}`);
  const [choiceQ, drawnQ] = quiz.questions;

  const { url } = await drawing();
  await attemptService.saveDrawing(attempt.attemptId, { questionId: drawnQ.id, data: PNG.toString('base64') });

  return {
    attemptId: attempt.attemptId,
    drawnQ,
    choiceQ,
    url,
    result: attemptService.submit(attempt.attemptId, { answers: { [choiceQ.id]: 0 } }),
  };
}

test('an attempt with a drawing is submitted with a real but partial score', async () => {
  const quiz = makeQuiz();
  const { result } = await submitWithDrawing(quiz, 'Ada');

  assert.equal(result.score, 2, 'the choice question is marked immediately');
  assert.equal(result.maxScore, 8);
  assert.equal(result.pendingMarkCount, 1, 'the drawing is owed a mark');
});

test('the drawing is stored as a URL, not inside the attempt', async () => {
  const quiz = makeQuiz();
  const { attemptId, drawnQ } = await submitWithDrawing(quiz, 'Bea');

  const paper = leaderboardService.attemptReview(quiz.id, attemptId);
  const row = paper.questions.find((question) => question.questionId === drawnQ.id);

  assert.match(row.drawingUrl, /^\/media\/[A-Za-z0-9_-]+\.png$/);
  assert.ok(row.drawingUrl.length < 100, 'an attempt holds an address, not an image');
  assert.equal(row.awaitingMarking, true);
});

test('a submission cannot point a drawing at somebody else s URL', async () => {
  const quiz = makeQuiz();
  const [choiceQ, drawnQ] = quiz.questions;
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Mal' }, 'device-mal');

  const result = attemptService.submit(attempt.attemptId, {
    answers: { [choiceQ.id]: 0, [drawnQ.id]: 'https://evil.example/not-ours.png' },
  });

  assert.equal(result.answeredCount, 1, 'the foreign URL is dropped, not stored');
});

/* ---- Marking it ---------------------------------------------------------- */

test('awarding marks re-scores the attempt', async () => {
  const quiz = makeQuiz();
  const { attemptId, drawnQ } = await submitWithDrawing(quiz, 'Cal');

  const marked = attemptService.applyMark(attemptId, drawnQ.id, { points: 5, note: 'Missing switch' });

  assert.equal(marked.score, 7, '2 auto + 5 awarded');
  assert.equal(marked.pendingMarkCount, 0);

  const paper = leaderboardService.attemptReview(quiz.id, attemptId);
  const row = paper.questions.find((question) => question.questionId === drawnQ.id);
  assert.equal(row.pointsAwarded, 5);
  assert.equal(row.markNote, 'Missing switch');
  assert.equal(row.awaitingMarking, false);
  assert.equal(row.isCorrect, false, 'partial marks are not full marks');
});

test('full marks on a drawing count as correct', async () => {
  const quiz = makeQuiz();
  const { attemptId, drawnQ } = await submitWithDrawing(quiz, 'Dee');

  const marked = attemptService.applyMark(attemptId, drawnQ.id, { points: 6 });
  assert.equal(marked.score, 8);
  assert.equal(marked.correctCount, 2);
});

test('a mark above the question s worth is refused, not clamped silently', async () => {
  const quiz = makeQuiz();
  const { attemptId, drawnQ } = await submitWithDrawing(quiz, 'Eve');

  assert.throws(() => attemptService.applyMark(attemptId, drawnQ.id, { points: 9 }), /at most 6/);
});

test('a mark can be undone, putting it back in the queue', async () => {
  const quiz = makeQuiz();
  const { attemptId, drawnQ } = await submitWithDrawing(quiz, 'Fay');

  attemptService.applyMark(attemptId, drawnQ.id, { points: 6 });
  const cleared = attemptService.clearMark(attemptId, drawnQ.id);

  assert.equal(cleared.score, 2);
  assert.equal(cleared.pendingMarkCount, 1);
});

test('a question that marks itself cannot be marked by hand', async () => {
  const quiz = makeQuiz();
  const { attemptId, choiceQ } = await submitWithDrawing(quiz, 'Gus');

  assert.throws(
    () => attemptService.applyMark(attemptId, choiceQ.id, { points: 2 }),
    /marked automatically/,
  );
});

test('where a mark came from is recorded', async () => {
  const quiz = makeQuiz();
  const { attemptId, drawnQ } = await submitWithDrawing(quiz, 'Hal');

  attemptService.applyMark(attemptId, drawnQ.id, { points: 4, source: 'gemini' });
  let row = leaderboardService
    .attemptReview(quiz.id, attemptId)
    .questions.find((question) => question.questionId === drawnQ.id);
  assert.equal(row.markSource, 'gemini');

  attemptService.applyMark(attemptId, drawnQ.id, { points: 4 });
  row = leaderboardService
    .attemptReview(quiz.id, attemptId)
    .questions.find((question) => question.questionId === drawnQ.id);
  assert.equal(row.markSource, 'teacher', 'anything unrecognised is treated as a person');
});

/* ---- The queue and the board --------------------------------------------- */

test('the queue lists what is waiting, oldest submission first', async () => {
  const quiz = makeQuiz();
  await submitWithDrawing(quiz, 'Ivy');
  await submitWithDrawing(quiz, 'Jon');

  const queue = leaderboardService.markingQueue(quiz.id);

  assert.equal(queue.questions.length, 1);
  assert.equal(queue.items.length, 2);
  assert.equal(queue.remaining, 2);
  assert.deepEqual(
    queue.items.map((item) => item.participantName),
    ['Ivy', 'Jon'],
  );
  assert.equal(queue.items[0].maxPoints, 6);
  assert.equal(queue.items[0].mark, null);
});

test('an unanswered drawing is not put in the queue', () => {
  const quiz = makeQuiz();
  const [choiceQ] = quiz.questions;

  const { attempt } = attemptService.start(quiz.id, { participantName: 'Kim' }, 'device-kim');
  attemptService.submit(attempt.attemptId, { answers: { [choiceQ.id]: 0 } });

  const queue = leaderboardService.markingQueue(quiz.id);
  assert.ok(
    !queue.items.some((item) => item.participantName === 'Kim'),
    'nothing drawn is nothing to mark',
  );
});

test('a quiz with no drawn questions has no queue at all', () => {
  const quiz = quizService.create({ title: 'Plain', timeLimitSeconds: 300 });
  quizService.addQuestion(quiz.id, { text: 'q', options: ['a', 'b'], correctIndex: 0 });

  assert.deepEqual(leaderboardService.markingQueue(quiz.id), {
    questions: [],
    items: [],
    remaining: 0,
  });
});

test('the board says when its ranking is not final', async () => {
  const quiz = makeQuiz();
  const { attemptId, drawnQ } = await submitWithDrawing(quiz, 'Lee');

  let board = leaderboardService.build(quiz.id);
  assert.equal(board.stats.awaitingMarkingCount, 1);
  assert.equal(board.entries[0].pendingMarkCount, 1);

  attemptService.applyMark(attemptId, drawnQ.id, { points: 6 });

  board = leaderboardService.build(quiz.id);
  assert.equal(board.stats.awaitingMarkingCount, 0);
  assert.equal(board.entries[0].pendingMarkCount, 0);
});

test('marking changes the order, which is the point of flagging it', async () => {
  const quiz = makeQuiz();
  const weak = await submitWithDrawing(quiz, 'Mia');
  const strong = await submitWithDrawing(quiz, 'Noor');

  // Both sit on 2 until somebody looks at the drawings.
  attemptService.applyMark(weak.attemptId, weak.drawnQ.id, { points: 1 });
  attemptService.applyMark(strong.attemptId, strong.drawnQ.id, { points: 6 });

  const names = leaderboardService
    .build(quiz.id)
    .entries.filter((entry) => ['Mia', 'Noor'].includes(entry.participantName))
    .map((entry) => entry.participantName);

  assert.deepEqual(names, ['Noor', 'Mia'], 'the better drawing now ranks higher');
});

test('the breakdown reports marking progress, not options', async () => {
  // Regression: the breakdown assumed every question that was not typed had
  // options, so a drawn one threw and took the whole results page with it.
  const quiz = makeQuiz();
  const first = await submitWithDrawing(quiz, 'Pia');
  await submitWithDrawing(quiz, 'Quin');

  let summary = leaderboardService
    .questionBreakdown(quiz.id)
    .find((question) => question.questionId === first.drawnQ.id);

  assert.equal(summary.type, 'draw');
  assert.equal(summary.optionCounts, undefined, 'there are no options to count');
  assert.equal(summary.givenAnswers, undefined, 'and no text to group');
  assert.equal(summary.responseCount, 2);
  assert.equal(summary.markedCount, 0);
  assert.equal(summary.awaitingMarkingCount, 2);

  attemptService.applyMark(first.attemptId, first.drawnQ.id, { points: 3 });

  summary = leaderboardService
    .questionBreakdown(quiz.id)
    .find((question) => question.questionId === first.drawnQ.id);

  assert.equal(summary.markedCount, 1);
  assert.equal(summary.awaitingMarkingCount, 1);
  assert.equal(summary.averageMark, 3);
  assert.equal(summary.maxPoints, 6);
});

test('a quiz with all three question types builds a breakdown for each', async () => {
  const quiz = quizService.create({ title: 'All three', timeLimitSeconds: 300 });
  quizService.addQuestion(quiz.id, { text: 'Pick', options: ['a', 'b'], correctIndex: 0 });
  quizService.addQuestion(quiz.id, { type: 'short', text: 'Type', acceptedAnswers: ['x'] });
  quizService.addQuestion(quiz.id, { type: 'draw', text: 'Draw', points: 4 });
  quizService.update(quiz.id, { isPublished: true });

  const breakdown = leaderboardService.questionBreakdown(quiz.id);
  assert.deepEqual(
    breakdown.map((question) => question.type),
    ['choice', 'short', 'draw'],
  );
});
