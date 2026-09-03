import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seguequiz-reveal-'));
process.env.SEGUEQUIZ_DATA_DIR = dataDir;

const { quizService } = await import('../src/services/quizService.js');
const { attemptService } = await import('../src/services/attemptService.js');

process.on('exit', () => fs.rmSync(dataDir, { recursive: true, force: true }));

function makeQuiz(settings = {}) {
  const quiz = quizService.create({ title: 'Reveal', timeLimitSeconds: 300, ...settings });

  quizService.addQuestion(quiz.id, {
    text: 'Capital of France?',
    options: ['Berlin', 'Paris', 'Madrid'],
    correctIndex: 1,
    points: 2,
  });
  quizService.addQuestion(quiz.id, {
    text: 'Two plus two?',
    options: ['3', '4'],
    correctIndex: 1,
    points: 1,
  });

  return quizService.update(quiz.id, { isPublished: true, allowRetakes: true });
}

function sit(quiz, name, picks) {
  const { attempt, quiz: view } = attemptService.start(quiz.id, { participantName: name }, name);
  view.questions.forEach((question, index) => {
    if (picks[index] === null) return;
    attemptService.saveAnswer(attempt.attemptId, {
      questionId: question.id,
      optionIndex: picks[index],
    });
  });
  return attemptService.submit(attempt.attemptId, {});
}

/* ---- Off by default ---- */

test('answers are withheld by default, not merely hidden in the page', () => {
  const quiz = makeQuiz();
  const result = sit(quiz, 'Ana', [1, 1]);

  assert.equal(result.review, undefined, 'no review key at all');
  assert.ok(
    !JSON.stringify(result).includes('correctIndex'),
    'the answer key must not be anywhere in the payload',
  );
  // The score itself is still theirs to see.
  assert.equal(result.score, 3);
});

test('a quiz is created with revealing off', () => {
  assert.equal(makeQuiz().revealAnswers, false);
});

/* ---- On ---- */

test('turning it on returns the taker their own paper', () => {
  const quiz = makeQuiz({ revealAnswers: true });
  const result = sit(quiz, 'Bo', [0, 1]); // first wrong, second right

  assert.ok(Array.isArray(result.review));
  assert.equal(result.review.length, 2);

  const [first, second] = result.review;
  assert.equal(first.text, 'Capital of France?');
  assert.equal(first.isCorrect, false);
  assert.equal(first.chosenIndex, 0);
  assert.equal(first.correctIndex, 1);
  assert.equal(first.pointsAwarded, 0);

  assert.equal(second.isCorrect, true);
  assert.equal(second.pointsAwarded, 1);
});

test('an unanswered question reads as blank, not as wrong', () => {
  const quiz = makeQuiz({ revealAnswers: true });
  const result = sit(quiz, 'Cy', [null, 1]);

  const [first] = result.review;
  assert.equal(first.chosenIndex, null);
  assert.equal(first.isCorrect, false);
  assert.equal(first.pointsAwarded, 0);
});

test('the review survives shuffling and reads in the authored order', () => {
  const quiz = makeQuiz({ revealAnswers: true, shuffleQuestions: true, shuffleOptions: true });
  const { attempt, quiz: view } = attemptService.start(
    quiz.id,
    { participantName: 'Di' },
    'device-di',
  );

  // Answer correctly by text, whatever position each option landed in.
  const correct = { 'Capital of France?': 'Paris', 'Two plus two?': '4' };
  for (const question of view.questions) {
    attemptService.saveAnswer(attempt.attemptId, {
      questionId: question.id,
      optionIndex: question.options.indexOf(correct[question.text]),
    });
  }

  const result = attemptService.submit(attempt.attemptId, {});

  assert.equal(result.score, 3);
  assert.deepEqual(
    result.review.map((q) => q.text),
    ['Capital of France?', 'Two plus two?'],
    'the paper reads in the authored order, not the shuffled one',
  );
  assert.ok(result.review.every((q) => q.isCorrect));
  assert.equal(result.review[0].options[result.review[0].correctIndex], 'Paris');
});

test('the setting can be turned on and off after the fact', () => {
  const quiz = makeQuiz();
  assert.equal(sit(quiz, 'Eve', [1, 1]).review, undefined);

  quizService.update(quiz.id, { revealAnswers: true });
  assert.ok(Array.isArray(sit(quiz, 'Fay', [1, 1]).review));

  quizService.update(quiz.id, { revealAnswers: false });
  assert.equal(sit(quiz, 'Gus', [1, 1]).review, undefined);
});

test('an attempt ended by leaving still gets a review when revealing is on', () => {
  const quiz = makeQuiz({ revealAnswers: true });
  const { attempt, quiz: view } = attemptService.start(
    quiz.id,
    { participantName: 'Hal' },
    'device-hal',
  );
  attemptService.saveAnswer(attempt.attemptId, {
    questionId: view.questions[0].id,
    optionIndex: 1,
  });

  const result = attemptService.abandon(attempt.attemptId);

  assert.equal(result.endedReason, 'left_quiz');
  assert.ok(Array.isArray(result.review));
  assert.equal(result.review[1].chosenIndex, null, 'the question they never reached is blank');
});
