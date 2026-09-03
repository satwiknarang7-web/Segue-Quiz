import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seguequiz-shuffle-'));
process.env.SEGUEQUIZ_DATA_DIR = dataDir;

const { quizService } = await import('../src/services/quizService.js');
const { attemptService } = await import('../src/services/attemptService.js');
const { seededOrder, optionOrder } = await import('../src/lib/shuffle.js');

process.on('exit', () => fs.rmSync(dataDir, { recursive: true, force: true }));

const CORRECT = {
  'Capital of France?': 'Paris',
  'Two plus two?': '4',
  'Largest ocean?': 'Pacific',
};

/** Distinct option text, so a reordering is actually visible. */
function makeQuiz(settings = {}) {
  const quiz = quizService.create({ title: 'Shuffled', timeLimitSeconds: 600, ...settings });

  quizService.addQuestion(quiz.id, {
    text: 'Capital of France?',
    options: ['Berlin', 'Paris', 'Madrid', 'Rome'],
    correctIndex: 1,
    points: 3,
  });
  quizService.addQuestion(quiz.id, {
    text: 'Two plus two?',
    options: ['3', '4', '5', '6'],
    correctIndex: 1,
    points: 2,
  });
  quizService.addQuestion(quiz.id, {
    text: 'Largest ocean?',
    options: ['Atlantic', 'Indian', 'Pacific', 'Arctic'],
    correctIndex: 2,
    points: 1,
  });

  return quizService.update(quiz.id, { isPublished: true, allowRetakes: true });
}

/** Answer every question by the text that is right, wherever it now sits. */
function answerAll(attemptId, view, textFor) {
  for (const question of view.questions) {
    attemptService.saveAnswer(attemptId, {
      questionId: question.id,
      optionIndex: question.options.indexOf(textFor[question.text]),
    });
  }
}

/* ---- The permutation itself ---- */

test('the same seed always gives the same order', () => {
  assert.deepEqual(seededOrder('abc', 8), seededOrder('abc', 8));
  assert.notDeepEqual(seededOrder('abc', 8), seededOrder('abd', 8));
});

test('an order is a permutation - nothing lost, nothing duplicated', () => {
  for (const seed of ['a', 'b', 'attempt-1:questions', 'x'.repeat(50)]) {
    const order = seededOrder(seed, 6);
    assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  }
});

test('attempts are spread across the possible arrangements', () => {
  // Any two given attempts may coincide - with four options there are only
  // 24 permutations, so a clash is expected about 4% of the time. What
  // matters is that the spread is wide and roughly even, not that any
  // particular pair differs.
  const seen = new Map();
  for (let index = 0; index < 2400; index += 1) {
    const key = optionOrder(`attempt-${index}`, 'question-1', 4).join('');
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  assert.equal(seen.size, 24, 'every permutation of four options should occur');

  const counts = [...seen.values()];
  const expected = 2400 / 24;
  assert.ok(
    Math.min(...counts) > expected * 0.6 && Math.max(...counts) < expected * 1.4,
    `distribution too lumpy: ${Math.min(...counts)}..${Math.max(...counts)} around ${expected}`,
  );
});

/* ---- What the participant sees ---- */

test('the arrangement is stable across reloads', () => {
  const quiz = makeQuiz({ shuffleQuestions: true, shuffleOptions: true });
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Ana' }, 'device-a');

  const first = quizService.toParticipantView(quiz, attempt.attemptId);
  const second = quizService.toParticipantView(quiz, attempt.attemptId);

  assert.deepEqual(first, second, 'a refresh must not rearrange anything');

  assert.deepEqual(
    [...first.questions.map((q) => q.text)].sort(),
    [...quiz.questions.map((q) => q.text)].sort(),
    'same questions, whatever the order',
  );

  const paris = first.questions.find((q) => q.text === 'Capital of France?');
  assert.deepEqual([...paris.options].sort(), ['Berlin', 'Madrid', 'Paris', 'Rome']);
});

test('the answer key never reaches the participant, shuffled or not', () => {
  const quiz = makeQuiz({ shuffleQuestions: true, shuffleOptions: true });
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Bo' }, 'device-b');
  const view = quizService.toParticipantView(quiz, attempt.attemptId);
  assert.ok(!JSON.stringify(view).includes('correctIndex'));
});

/* ---- Scoring: where a mistake would silently mark people wrong ---- */

test('the right option scores, whatever position it was shown in', () => {
  const quiz = makeQuiz({ shuffleQuestions: true, shuffleOptions: true });
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Cy' }, 'device-c');

  answerAll(attempt.attemptId, quizService.toParticipantView(quiz, attempt.attemptId), CORRECT);

  const result = attemptService.submit(attempt.attemptId, {});
  assert.equal(result.score, 6, '3 + 2 + 1 for all three right');
  assert.equal(result.correctCount, 3);
});

test('a wrong pick still scores zero under shuffling', () => {
  const quiz = makeQuiz({ shuffleQuestions: true, shuffleOptions: true });
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Di' }, 'device-d');

  answerAll(attempt.attemptId, quizService.toParticipantView(quiz, attempt.attemptId), {
    'Capital of France?': 'Berlin',
    'Two plus two?': '5',
    'Largest ocean?': 'Arctic',
  });

  const result = attemptService.submit(attempt.attemptId, {});
  assert.equal(result.score, 0);
  assert.equal(result.correctCount, 0);
});

test('answers arriving with the submission are translated too', () => {
  const quiz = makeQuiz({ shuffleOptions: true });
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Eli' }, 'device-e');
  const view = quizService.toParticipantView(quiz, attempt.attemptId);

  // Nothing autosaved - it all arrives at once, in the order it was displayed.
  const answers = Object.fromEntries(
    view.questions.map((q) => [q.id, q.options.indexOf(CORRECT[q.text])]),
  );

  const result = attemptService.submit(attempt.attemptId, { answers });
  assert.equal(result.score, 6, 'a bulk submission needs the same translation as autosaves');
});

test('what is stored is the authored index, not the displayed one', () => {
  const quiz = makeQuiz({ shuffleOptions: true });
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Fay' }, 'device-f');
  const view = quizService.toParticipantView(quiz, attempt.attemptId);

  const question = view.questions.find((q) => q.text === 'Capital of France?');
  const displayedIndex = question.options.indexOf('Paris');

  attemptService.saveAnswer(attempt.attemptId, {
    questionId: question.id,
    optionIndex: displayedIndex,
  });
  const result = attemptService.submit(attempt.attemptId, {});

  // Paris is authored at index 1. Whatever position it was shown in, that is
  // what has to be on record, or the breakdown and CSV would disagree.
  assert.equal(result.score, 3);
  const authored = quizService.requireQuiz(quiz.id).questions.find(
    (q) => q.text === 'Capital of France?',
  );
  assert.equal(authored.options[authored.correctIndex], 'Paris');
});

test('shuffling off leaves everything exactly as authored', () => {
  const quiz = makeQuiz();
  const { attempt } = attemptService.start(quiz.id, { participantName: 'Gus' }, 'device-g');
  const view = quizService.toParticipantView(quiz, attempt.attemptId);

  assert.deepEqual(
    view.questions.map((q) => q.text),
    quiz.questions.map((q) => q.text),
  );
  assert.deepEqual(view.questions[0].options, quiz.questions[0].options);
});
