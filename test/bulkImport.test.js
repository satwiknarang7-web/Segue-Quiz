import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seguequiz-bulk-'));
process.env.SEGUEQUIZ_DATA_DIR = dataDir;

const { quizService } = await import('../src/services/quizService.js');
const { parseBulkQuestions } = await import('../src/lib/parseQuestions.js');

process.on('exit', () => fs.rmSync(dataDir, { recursive: true, force: true }));

const OWNER = 'owner-1';
const newQuiz = () => quizService.create({ title: 'Bulk', timeLimitSeconds: 300 }, OWNER);

/* ---- Parsing ---- */

test('reads a spreadsheet paste, which is tab separated', () => {
  const { questions, errors } = parseBulkQuestions(
    [
      'Capital of France?\tBerlin\t*Paris\tMadrid\tRome',
      'Two plus two?\t3\t*4\t5',
      'Water is wet\t*True\tFalse',
    ].join('\n'),
  );

  assert.equal(errors.length, 0);
  assert.equal(questions.length, 3);
  assert.deepEqual(questions[0].options, ['Berlin', 'Paris', 'Madrid', 'Rome']);
  assert.equal(questions[0].correctIndex, 1);
  // One paste can mix two-option and four-option questions.
  assert.equal(questions[2].options.length, 2);
});

test('reads comma separated too, with quotes for commas inside a cell', () => {
  const { questions, errors } = parseBulkQuestions('"Two plus two, roughly?",3,"*4, exactly",5');

  assert.equal(errors.length, 0);
  assert.equal(questions[0].text, 'Two plus two, roughly?');
  assert.equal(questions[0].options[1], '4, exactly');
  assert.equal(questions[0].correctIndex, 1);
});

test('blank lines and # comments are skipped, and line numbers stay true', () => {
  const { questions, errors } = parseBulkQuestions(
    ['# from the Friday session', '', 'Q one\t*A\tB', '', 'Q two\t*C\tD'].join('\n'),
  );

  assert.equal(errors.length, 0);
  assert.deepEqual(questions.map((q) => q.line), [3, 5], 'reported lines match the paste');
});

test('every kind of bad line is reported against its own line number', () => {
  const { questions, errors } = parseBulkQuestions(
    [
      'No answer marked\tA\tB',
      'Too few options\tOnly one',
      'Two answers marked\t*A\t*B',
      '\tA\t*B',
    ].join('\n'),
  );

  assert.equal(questions.length, 0);
  assert.deepEqual(errors.map((e) => e.line), [1, 2, 3, 4]);
  assert.match(errors[0].message, /no correct answer/i);
  assert.match(errors[1].message, /at least 2/i);
  assert.match(errors[2].message, /exactly one/i);
  assert.match(errors[3].message, /no question text/i);
});

test('trailing empty columns from a spreadsheet are ignored', () => {
  const { questions, errors } = parseBulkQuestions('Q\t*A\tB\t\t\t');
  assert.equal(errors.length, 0);
  assert.deepEqual(questions[0].options, ['A', 'B']);
});

/* ---- Importing ---- */

test('a dry run reports what would happen and saves nothing', () => {
  const quiz = newQuiz();
  const result = quizService.addQuestionsFromText(quiz.id, 'Q one\t*A\tB', OWNER, { dryRun: true });

  assert.equal(result.questions.length, 1);
  assert.equal(result.added, 0);
  assert.equal(quizService.requireQuiz(quiz.id).questions.length, 0, 'nothing was written');
});

test('a good paste imports every question in order', () => {
  const quiz = newQuiz();
  const result = quizService.addQuestionsFromText(
    quiz.id,
    ['First\t*A\tB', 'Second\tC\t*D', 'Third\t*E\tF\tG'].join('\n'),
    OWNER,
  );

  assert.equal(result.added, 3);

  const stored = quizService.requireQuiz(quiz.id);
  assert.deepEqual(stored.questions.map((q) => q.text), ['First', 'Second', 'Third']);
  assert.equal(stored.questions[1].options[stored.questions[1].correctIndex], 'D');
  assert.equal(stored.questions[2].options.length, 3);
});

test('one bad line refuses the whole paste, importing nothing', () => {
  const quiz = newQuiz();
  quizService.addQuestionsFromText(quiz.id, 'Existing\t*A\tB', OWNER);

  assert.throws(
    () =>
      quizService.addQuestionsFromText(
        quiz.id,
        ['Good one\t*A\tB', 'Bad one - no answer\tA\tB', 'Another good\t*C\tD'].join('\n'),
        OWNER,
      ),
    /1 line\(s\) could not be read/,
  );

  // The two good lines must NOT have been added: half an import is worse.
  assert.equal(
    quizService.requireQuiz(quiz.id).questions.length,
    1,
    'only the question added before the failed paste should remain',
  );
});

test('the same validation a typed question gets is applied', () => {
  const quiz = newQuiz();

  // Duplicate options are rejected by parseQuestionPayload, not by the parser,
  // so this proves the paste goes through the normal validation too.
  const dry = quizService.addQuestionsFromText(quiz.id, 'Q\t*Same\tSame', OWNER, { dryRun: true });
  assert.equal(dry.questions.length, 0);
  assert.match(dry.errors[0].message, /different/i);
});

test('importing is owner-only', () => {
  const quiz = newQuiz();
  assert.throws(
    () => quizService.addQuestionsFromText(quiz.id, 'Q\t*A\tB', 'someone-else'),
    /does not exist/i,
  );
});

test('an empty paste is refused rather than silently doing nothing', () => {
  const quiz = newQuiz();
  assert.throws(() => quizService.addQuestionsFromText(quiz.id, '   ', OWNER), /nothing to import/i);
});

/* ---- Typed questions ----------------------------------------------------- */

test('a line starting with = becomes a typed question', () => {
  const { questions, errors } = parseBulkQuestions('=SI unit of force?\tnewton\tN');

  assert.deepEqual(errors, []);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].type, 'short');
  assert.equal(questions[0].text, 'SI unit of force?', 'the marker is not part of the question');
  assert.deepEqual(questions[0].acceptedAnswers, ['newton', 'N']);
  assert.equal(questions[0].options, undefined);
});

test('one paste can mix both types', () => {
  const { questions, errors } = parseBulkQuestions(
    ['Capital of France?\tBerlin\t*Paris', '=Chemical symbol for gold?\tAu'].join('\n'),
  );

  assert.deepEqual(errors, []);
  assert.deepEqual(
    questions.map((question) => question.type),
    ['choice', 'short'],
  );
});

test('a forgotten asterisk is still an error, not a typed question', () => {
  // The whole reason the marker is explicit: this is the commonest mistake in
  // a paste, and turning it into a question of the wrong type would hide it.
  const { questions, errors } = parseBulkQuestions('Capital of France?\tBerlin\tParis');

  assert.equal(questions.length, 0);
  assert.match(errors[0].message, /No correct answer marked/);
});

test('a typed question with nothing after it is reported', () => {
  const { errors } = parseBulkQuestions('=A question with no answer');
  assert.match(errors[0].message, /at least one answer/);
});

test('accepted answers that grade the same are refused in a paste too', () => {
  const { errors } = parseBulkQuestions('=Force unit?\t15 N\t15   n');
  assert.match(errors[0].message, /same once spacing and case are ignored/);
});

test('a typed paste survives into a real quiz', () => {
  const quiz = newQuiz();
  const { added } = quizService.addQuestionsFromText(
    quiz.id,
    '=Chemical symbol for gold?\tAu\taurum',
    OWNER,
  );

  assert.equal(added, 1);
  const [question] = quizService.requireQuiz(quiz.id).questions;
  assert.equal(question.type, 'short');
  assert.deepEqual(question.acceptedAnswers, ['Au', 'aurum']);
});
