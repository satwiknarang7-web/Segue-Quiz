import test from 'node:test';
import assert from 'node:assert/strict';

const { generateQuestions, isConfigured, toPasteFormat } = await import('../src/lib/gemini.js');

/** A stand-in Gemini that records what it was asked and replies as told. */
function fakeGemini(reply, { status = 200 } = {}) {
  const calls = [];

  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply,
      text: async () => (typeof reply === 'string' ? reply : JSON.stringify(reply)),
    };
  };

  return { fetchImpl, calls };
}

const wrapInSteps = (payload) => ({
  steps: [{ content: [{ text: JSON.stringify(payload) }] }],
});

const TWO_QUESTIONS = {
  questions: [
    { text: 'Capital of France?', options: ['Berlin', 'Paris', 'Madrid'], correctIndex: 1 },
    { text: 'Two plus two?', options: ['3', '4'], correctIndex: 1 },
  ],
};

test.beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-key';
});

/* ---- Configuration ---- */

test('the feature reports itself off without a key', () => {
  delete process.env.GEMINI_API_KEY;
  assert.equal(isConfigured(), false);

  process.env.GEMINI_API_KEY = 'test-key';
  assert.equal(isConfigured(), true);
});

test('generating without a key fails clearly rather than calling out', async () => {
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(generateQuestions({ topic: 'anything' }), /GEMINI_API_KEY is not set/);
});

/* ---- The request ---- */

test('the key travels in the header, never in the URL', async () => {
  const { fetchImpl, calls } = fakeGemini(wrapInSteps(TWO_QUESTIONS));
  await generateQuestions({ topic: 'Photosynthesis', count: 2 }, { fetchImpl });

  const [call] = calls;
  assert.equal(call.headers['x-goog-api-key'], 'test-key');
  assert.ok(!call.url.includes('test-key'), 'a key in the URL would end up in logs');
  assert.match(call.url, /\/v1beta\/interactions$/);
});

test('it asks for JSON against a schema rather than hoping for prose', async () => {
  const { fetchImpl, calls } = fakeGemini(wrapInSteps(TWO_QUESTIONS));
  await generateQuestions({ topic: 'Photosynthesis' }, { fetchImpl });

  const { body } = calls[0];
  assert.equal(body.response_format.mime_type, 'application/json');
  assert.equal(body.response_format.schema.properties.questions.type, 'array');
  assert.ok(body.model, 'a model must be named');
});

test('the topic, count and difficulty reach the prompt', async () => {
  const { fetchImpl, calls } = fakeGemini(wrapInSteps(TWO_QUESTIONS));
  await generateQuestions(
    { topic: 'The water cycle', count: 7, difficulty: 'easy', notes: 'avoid trick questions' },
    { fetchImpl },
  );

  const { input } = calls[0].body;
  assert.match(input, /Write 7 quiz questions/);
  assert.match(input, /The water cycle/);
  assert.match(input, /easy difficulty/);
  assert.match(input, /avoid trick questions/);
});

test('the count is clamped to something sane', async () => {
  const { fetchImpl, calls } = fakeGemini(wrapInSteps(TWO_QUESTIONS));

  await generateQuestions({ topic: 'x', count: 500 }, { fetchImpl });
  assert.match(calls[0].body.input, /Write 25 quiz questions/);

  await generateQuestions({ topic: 'x', count: -3 }, { fetchImpl });
  assert.match(calls[1].body.input, /Write 1 quiz questions/);
});

/* ---- Reading the reply ---- */

test('reads the reply from either documented shape', async () => {
  const viaSteps = fakeGemini(wrapInSteps(TWO_QUESTIONS));
  const fromSteps = await generateQuestions({ topic: 'x' }, { fetchImpl: viaSteps.fetchImpl });
  assert.equal(fromSteps.length, 2);

  const viaOutputText = fakeGemini({ output_text: JSON.stringify(TWO_QUESTIONS) });
  const fromOutput = await generateQuestions({ topic: 'x' }, { fetchImpl: viaOutputText.fetchImpl });
  assert.deepEqual(fromOutput, fromSteps);
});

test('text that is not JSON at all is reported as such', async () => {
  // Deliberately not passed through wrapInSteps, which would JSON-encode it
  // and thereby make it valid JSON.
  const { fetchImpl } = fakeGemini({
    steps: [{ content: [{ text: 'Sure! Here are your questions:' }] }],
  });
  await assert.rejects(generateQuestions({ topic: 'x' }, { fetchImpl }), /usable JSON/);
});

test('valid JSON with no questions in it is reported separately', async () => {
  const { fetchImpl } = fakeGemini(wrapInSteps({ questions: [] }));
  await assert.rejects(generateQuestions({ topic: 'x' }, { fetchImpl }), /no questions/);
});

test('an empty reply is reported', async () => {
  const { fetchImpl } = fakeGemini({ steps: [] });
  await assert.rejects(generateQuestions({ topic: 'x' }, { fetchImpl }), /no text in it/);
});

test('questions of the wrong shape are dropped, not half-built', async () => {
  const { fetchImpl } = fakeGemini(
    wrapInSteps({
      questions: [
        { text: 'Fine', options: ['a', 'b'], correctIndex: 0 },
        { text: 'No options' },
        { options: ['a', 'b'], correctIndex: 0 },
        { text: 'Bad index', options: ['a', 'b'], correctIndex: 'first' },
      ],
    }),
  );

  const questions = await generateQuestions({ topic: 'x' }, { fetchImpl });
  assert.equal(questions.length, 1);
  assert.equal(questions[0].text, 'Fine');
});

/* ---- Failures a teacher would see ---- */

test('a rejected key and a rate limit say different things', async () => {
  const bad = fakeGemini('forbidden', { status: 403 });
  await assert.rejects(generateQuestions({ topic: 'x' }, { fetchImpl: bad.fetchImpl }), /API key/);

  const limited = fakeGemini('slow down', { status: 429 });
  await assert.rejects(
    generateQuestions({ topic: 'x' }, { fetchImpl: limited.fetchImpl }),
    /rate limiting/,
  );
});

/* ---- Handing over to the importer ---- */

test('drafts render in the same format the paste box reads', async () => {
  const { fetchImpl } = fakeGemini(wrapInSteps(TWO_QUESTIONS));
  const text = toPasteFormat(await generateQuestions({ topic: 'x' }, { fetchImpl }));

  assert.equal(text.split('\n').length, 2);
  assert.equal(text.split('\n')[0], 'Capital of France?\tBerlin\t*Paris\tMadrid');
});

test('a tab in generated text cannot break the row it sits in', () => {
  const text = toPasteFormat([
    { text: 'Has\ta tab', options: ['also\there', 'clean'], correctIndex: 1 },
  ]);

  assert.equal(text.split('\t').length, 3, 'exactly question + two options');
  assert.match(text, /Has a tab/);
});

test('drafts survive the round trip through the real importer', async () => {
  const { parseBulkQuestions } = await import('../src/lib/parseQuestions.js');
  const { fetchImpl } = fakeGemini(wrapInSteps(TWO_QUESTIONS));

  const text = toPasteFormat(await generateQuestions({ topic: 'x' }, { fetchImpl }));
  const { questions, errors } = parseBulkQuestions(text);

  assert.deepEqual(errors, [], 'a draft must never produce a broken paste');
  assert.equal(questions.length, 2);
  assert.equal(questions[0].options[questions[0].correctIndex], 'Paris');
  assert.equal(questions[1].options[questions[1].correctIndex], '4');
});

/* ---- Both question types ------------------------------------------------- */

const MIXED = {
  questions: [
    { type: 'choice', text: 'Capital of France?', options: ['Berlin', 'Paris'], correctIndex: 1 },
    { type: 'short', text: 'Symbol for gold?', acceptedAnswers: ['Au', 'aurum'] },
  ],
};

test('a drafted typed question keeps its accepted answers', async () => {
  const { fetchImpl } = fakeGemini(wrapInSteps(MIXED));
  const questions = await generateQuestions({ topic: 'x' }, { fetchImpl });

  assert.equal(questions.length, 2);
  assert.deepEqual(questions[1], {
    type: 'short',
    text: 'Symbol for gold?',
    acceptedAnswers: ['Au', 'aurum'],
  });
  assert.equal(questions[1].options, undefined, 'a typed question carries no options');
});

test('a question with no type is read as multiple choice', async () => {
  // Older drafts and a model that drops the field must still be usable.
  const { fetchImpl } = fakeGemini(wrapInSteps(TWO_QUESTIONS));
  const questions = await generateQuestions({ topic: 'x' }, { fetchImpl });
  assert.ok(questions.every((question) => question.type === 'choice'));
});

test('the requested style reaches the prompt', async () => {
  const { fetchImpl, calls } = fakeGemini(wrapInSteps(MIXED));

  await generateQuestions({ topic: 'x', style: 'short' }, { fetchImpl });
  assert.match(calls[0].body.input, /Every question must be type "short"/);

  await generateQuestions({ topic: 'x', style: 'choice' }, { fetchImpl });
  assert.match(calls[1].body.input, /Every question must be type "choice"/);

  await generateQuestions({ topic: 'x' }, { fetchImpl });
  assert.match(calls[2].body.input, /Mix both types/, 'mixed is the default');
});

test('a typed question with no usable answers is dropped', async () => {
  const { fetchImpl } = fakeGemini(
    wrapInSteps({
      questions: [
        { type: 'short', text: 'Fine', acceptedAnswers: ['yes'] },
        { type: 'short', text: 'No answers', acceptedAnswers: [] },
        { type: 'short', text: 'Blank answers', acceptedAnswers: ['  ', ''] },
        { type: 'short', acceptedAnswers: ['no text'] },
      ],
    }),
  );

  const questions = await generateQuestions({ topic: 'x' }, { fetchImpl });
  assert.equal(questions.length, 1);
  assert.equal(questions[0].text, 'Fine');
});

test('a choice question pointing outside its own options is dropped', async () => {
  const { fetchImpl } = fakeGemini(
    wrapInSteps({
      questions: [{ type: 'choice', text: 'Bad', options: ['a', 'b'], correctIndex: 7 }],
    }),
  );

  await assert.rejects(generateQuestions({ topic: 'x' }, { fetchImpl }), /none were usable/);
});

test('a mixed draft round-trips through the real importer', async () => {
  const { parseBulkQuestions } = await import('../src/lib/parseQuestions.js');
  const { fetchImpl } = fakeGemini(wrapInSteps(MIXED));

  const text = toPasteFormat(await generateQuestions({ topic: 'x' }, { fetchImpl }));
  const { questions, errors } = parseBulkQuestions(text);

  assert.deepEqual(errors, [], 'a draft must never produce a broken paste');
  assert.deepEqual(
    questions.map((question) => question.type),
    ['choice', 'short'],
  );
  assert.deepEqual(questions[1].acceptedAnswers, ['Au', 'aurum']);
});
