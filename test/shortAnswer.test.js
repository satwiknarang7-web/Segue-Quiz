import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seguequiz-short-'));
process.env.SEGUEQUIZ_DATA_DIR = dataDir;

const { quizService } = await import('../src/services/quizService.js');
const { attemptService } = await import('../src/services/attemptService.js');
const { leaderboardService } = await import('../src/services/leaderboardService.js');
const questionTypes = await import('../src/lib/questionTypes.js');

process.on('exit', () => fs.rmSync(dataDir, { recursive: true, force: true }));

const { isAnswered, isCorrect, normaliseAnswerText, reviewRow, typeOf } = questionTypes;

/* ---- The graded comparison ---------------------------------------------- */

const short = { type: 'short', text: 'q', points: 1, acceptedAnswers: ['15 N', 'fifteen newtons'] };
const choice = { text: 'q', points: 1, options: ['Newton', 'Joule'], correctIndex: 0 };

test('a question written before types existed is still multiple choice', () => {
  assert.equal(typeOf(choice), 'choice');
  assert.equal(typeOf({ ...choice, type: 'nonsense' }), 'choice');
  assert.equal(isCorrect(choice, 0), true);
  assert.equal(isCorrect(choice, 1), false);
});

test('option zero counts as answered, an empty string does not', () => {
  // The bug this guards: a truthiness check would treat both as unanswered.
  assert.equal(isAnswered(choice, 0), true);
  assert.equal(isAnswered(short, ''), false);
  assert.equal(isAnswered(short, '   '), false);
  assert.equal(isAnswered(short, '0'), true);
});

test('typing differences that are not knowledge differences are ignored', () => {
  for (const given of ['15 N', '15 n', '  15   N  ', '15 N\t']) {
    assert.equal(isCorrect(short, given), true, `${JSON.stringify(given)} should be accepted`);
  }
});

test('any listed spelling earns the marks', () => {
  assert.equal(isCorrect(short, 'fifteen newtons'), true);
  assert.equal(isCorrect(short, 'FIFTEEN NEWTONS'), true);
});

test('a different answer is still wrong', () => {
  assert.equal(isCorrect(short, '15 J'), false);
  assert.equal(isCorrect(short, '16 N'), false);
  assert.equal(isCorrect(short, ''), false);
  assert.equal(isCorrect(short, 'newton'), false, 'a substring is not the answer');
});

test('characters a phone or a word processor substitutes are folded', () => {
  // These are the ones that silently mark a right answer wrong, so each is
  // pinned rather than trusted to the normaliser's general shape.
  const apostrophe = { type: 'short', acceptedAnswers: ["Boyle's law"] };
  assert.equal(isCorrect(apostrophe, 'Boyle’s law'), true, 'curly apostrophe');

  const negative = { type: 'short', acceptedAnswers: ['-40'] };
  assert.equal(isCorrect(negative, '−40'), true, 'unicode minus');
  assert.equal(isCorrect(negative, '–40'), true, 'en dash');

  const quoted = { type: 'short', acceptedAnswers: ['the "big five"'] };
  assert.equal(isCorrect(quoted, 'the “big five”'), true, 'smart quotes');
});

test('normalisation does not throw away meaning', () => {
  // Case and spacing go; digits, units and punctuation that distinguishes
  // answers must survive, or two different answers would collide.
  assert.notEqual(normaliseAnswerText('3.5'), normaliseAnswerText('35'));
  assert.notEqual(normaliseAnswerText('H2O'), normaliseAnswerText('H2O2'));
  assert.notEqual(normaliseAnswerText('cat'), normaliseAnswerText('cats'));
});

/* ---- Authoring ----------------------------------------------------------- */

test('a typed question saves without options', () => {
  const quiz = quizService.create({ title: 'Typed', timeLimitSeconds: 300 });
  const updated = quizService.addQuestion(quiz.id, {
    type: 'short',
    text: 'SI unit of force?',
    acceptedAnswers: ['newton', 'N'],
    points: 2,
  });

  const [question] = updated.questions;
  assert.equal(question.type, 'short');
  assert.deepEqual(question.acceptedAnswers, ['newton', 'N']);
  assert.equal(question.options, undefined);
  assert.equal(question.correctIndex, undefined);
});

test('a typed question needs at least one accepted answer', () => {
  const quiz = quizService.create({ title: 'Typed', timeLimitSeconds: 300 });
  assert.throws(
    () => quizService.addQuestion(quiz.id, { type: 'short', text: 'q', acceptedAnswers: [] }),
    /at least 1 item/,
  );
});

test('accepted answers that only differ in case are refused', () => {
  const quiz = quizService.create({ title: 'Typed', timeLimitSeconds: 300 });
  assert.throws(
    () =>
      quizService.addQuestion(quiz.id, {
        type: 'short',
        text: 'q',
        // These grade identically, so listing both would suggest a coverage
        // that is not there.
        acceptedAnswers: ['15 N', '15  n'],
      }),
    /same once spacing and case are ignored/,
  );
});

test('an unknown type is refused rather than silently treated as choice', () => {
  const quiz = quizService.create({ title: 'Typed', timeLimitSeconds: 300 });
  assert.throws(
    () => quizService.addQuestion(quiz.id, { type: 'essay', text: 'q' }),
    /"type" must be one of/,
  );
});

/* ---- Taking one end to end ----------------------------------------------- */

function makeMixedQuiz() {
  const quiz = quizService.create({ title: 'Mixed', timeLimitSeconds: 600 });

  quizService.addQuestion(quiz.id, {
    text: 'SI unit of force?',
    options: ['Newton', 'Joule', 'Pascal'],
    correctIndex: 0,
    points: 2,
  });
  quizService.addQuestion(quiz.id, {
    type: 'short',
    text: 'Chemical symbol for gold?',
    acceptedAnswers: ['Au', 'aurum'],
    points: 3,
  });

  return quizService.update(quiz.id, { isPublished: true, allowRetakes: true, revealAnswers: true });
}

test('a mixed quiz scores both kinds of question together', () => {
  const quiz = makeMixedQuiz();
  const [choiceQ, shortQ] = quiz.questions;

  const { attempt } = attemptService.start(quiz.id, { participantName: 'Ada' }, 'device-a');
  const result = attemptService.submit(attempt.attemptId, {
    answers: { [choiceQ.id]: 0, [shortQ.id]: '  au  ' },
  });

  assert.equal(result.score, 5, 'both questions earn their points');
  assert.equal(result.maxScore, 5);
  assert.equal(result.correctCount, 2);
});

test('a blank typed answer is stored as unanswered, not as a wrong answer', () => {
  const quiz = makeMixedQuiz();
  const [choiceQ, shortQ] = quiz.questions;

  const { attempt } = attemptService.start(quiz.id, { participantName: 'Bea' }, 'device-b');
  const result = attemptService.submit(attempt.attemptId, {
    answers: { [choiceQ.id]: 0, [shortQ.id]: '   ' },
  });

  assert.equal(result.answeredCount, 1, 'whitespace is not an answer');
  assert.equal(result.score, 2);
});

test('takers never receive the accepted answers with the questions', () => {
  const quiz = makeMixedQuiz();
  const view = quizService.toParticipantView(quiz, 'attempt-1');
  const serialised = JSON.stringify(view);

  assert.ok(!serialised.includes('aurum'), 'the answer key must not reach the browser');
  assert.ok(!serialised.includes('acceptedAnswers'));
  assert.ok(!serialised.includes('correctIndex'));

  const typed = view.questions.find((question) => question.type === 'short');
  assert.ok(typed, 'the type has to travel, so the client knows what to render');
  assert.equal(typed.options, undefined, 'a typed question has no options to show');
});

test('autosaving a typed answer keeps it, and clearing it removes it', () => {
  const quiz = makeMixedQuiz();
  const shortQ = quiz.questions[1];

  const { attempt } = attemptService.start(quiz.id, { participantName: 'Cal' }, 'device-c');

  attemptService.saveAnswer(attempt.attemptId, { questionId: shortQ.id, answer: 'Au' });
  assert.equal(attemptService.getState(attempt.attemptId).answers[shortQ.id], 'Au');

  attemptService.saveAnswer(attempt.attemptId, { questionId: shortQ.id, answer: '' });
  assert.ok(!(shortQ.id in attemptService.getState(attempt.attemptId).answers), 'clearing means unanswered');
});

test('shuffling options leaves a typed question alone', () => {
  const quiz = quizService.update(makeMixedQuiz().id, {
    shuffleQuestions: true,
    shuffleOptions: true,
  });
  const shortQ = quiz.questions.find((question) => question.type === 'short');

  const { attempt } = attemptService.start(quiz.id, { participantName: 'Dee' }, 'device-d');
  const result = attemptService.submit(attempt.attemptId, { answers: { [shortQ.id]: 'aurum' } });

  assert.equal(result.score, 3, 'a typed answer has no positions to translate');
});

/* ---- Review and breakdown ------------------------------------------------ */

test('a review row carries what each type needs and nothing it does not', () => {
  const choiceRow = reviewRow(choice, 0, 1);
  assert.equal(choiceRow.type, 'choice');
  assert.equal(choiceRow.chosenIndex, 1);
  assert.deepEqual(choiceRow.options, ['Newton', 'Joule']);
  assert.equal(choiceRow.acceptedAnswers, undefined);

  const shortRow = reviewRow(short, 1, '15 n');
  assert.equal(shortRow.type, 'short');
  assert.equal(shortRow.isCorrect, true);
  assert.equal(shortRow.givenAnswer, '15 n', 'shown as they wrote it, not normalised');
  assert.equal(shortRow.correctAnswer, '15 N');
  assert.deepEqual(shortRow.acceptedAnswers, ['15 N', 'fifteen newtons']);
  assert.equal(shortRow.options, undefined);

  assert.equal(reviewRow(short, 2, '').givenAnswer, null, 'unanswered is null, not empty text');
});

test('the breakdown groups what people wrote by how it grades', () => {
  const quiz = makeMixedQuiz();
  const shortQ = quiz.questions[1];

  const answers = ['Au', 'au', ' AU ', 'Ag', 'gold'];
  answers.forEach((given, index) => {
    const { attempt } = attemptService.start(
      quiz.id,
      { participantName: `P${index}` },
      `device-${index}`,
    );
    attemptService.submit(attempt.attemptId, { answers: { [shortQ.id]: given } });
  });

  const summary = leaderboardService
    .questionBreakdown(quiz.id)
    .find((question) => question.questionId === shortQ.id);

  assert.equal(summary.type, 'short');
  assert.equal(summary.optionCounts, undefined, 'there are no fixed options to count');
  assert.equal(summary.responseCount, 5);
  assert.equal(summary.correctCount, 3, 'the three spellings of Au all count');

  const [top] = summary.givenAnswers;
  assert.equal(top.count, 3, 'Au, au and AU are one group');
  assert.equal(top.isCorrect, true);

  const wrong = summary.givenAnswers.filter((entry) => !entry.isCorrect).map((entry) => entry.text);
  assert.deepEqual(wrong.sort(), ['Ag', 'gold']);
});
