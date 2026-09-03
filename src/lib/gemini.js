/**
 * Draft quiz questions with Gemini.
 *
 * Plain fetch against the Interactions API, so the project keeps its zero
 * dependencies. The key is server-side only and never reaches a browser.
 *
 * The model is asked for structured JSON rather than prose, because parsing a
 * model's free text is the part that breaks quietly. Even so, nothing it
 * returns is trusted: every question goes through the same validation a typed
 * one does, and a person reviews the draft before it becomes a quiz.
 */

const ENDPOINT =
  process.env.GEMINI_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

const MIN_COUNT = 1;
const MAX_COUNT = 25;

/** The shape the model must return. */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correctIndex: { type: 'integer' },
        },
        required: ['text', 'options', 'correctIndex'],
      },
    },
  },
  required: ['questions'],
};

export const isConfigured = () => Boolean(process.env.GEMINI_API_KEY);

function buildPrompt({ topic, count, difficulty, notes }) {
  const lines = [
    `Write ${count} multiple-choice quiz questions about: ${topic}.`,
    '',
    'Rules:',
    '- Each question has between 3 and 5 options, exactly one of them correct.',
    '- correctIndex is the zero-based position of the correct option.',
    '- Wrong options must be plausible, not obviously silly.',
    '- Vary which position the correct answer sits in.',
    '- Keep each question to one sentence where possible.',
    '- Do not number the questions, and do not repeat a question.',
    '- Ask only about things that are settled and checkable, not opinion.',
  ];

  if (difficulty) lines.push(`- Aim for ${difficulty} difficulty.`);
  if (notes) lines.push('', `Extra instructions from the teacher: ${notes}`);

  return lines.join('\n');
}

/** The two documented shapes for where the generated text ends up. */
function extractText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim() !== '') {
    return payload.output_text;
  }

  const fromSteps = (payload?.steps ?? [])
    .flatMap((step) => step?.content ?? [])
    .map((part) => part?.text)
    .filter((text) => typeof text === 'string' && text.trim() !== '')
    .join('');

  if (fromSteps) return fromSteps;

  throw new Error('Gemini returned a response with no text in it.');
}

export async function generateQuestions(
  { topic, count = 10, difficulty = '', notes = '' },
  { fetchImpl = fetch, signal } = {},
) {
  if (!isConfigured()) {
    throw new Error('Question generation is switched off: GEMINI_API_KEY is not set.');
  }

  const wanted = Math.min(MAX_COUNT, Math.max(MIN_COUNT, Number(count) || 10));

  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        input: buildPrompt({ topic, count: wanted, difficulty, notes }),
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: RESPONSE_SCHEMA,
        },
      }),
    });
  } catch (error) {
    // No response at all: DNS, firewall, or the endpoint being unreachable.
    // "fetch failed" on its own is useless to whoever sees it.
    throw new Error(`Could not reach Gemini (${error.message}). Check the server's connection.`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // Say which failure it is: a bad key and a rate limit need different fixes.
    if (response.status === 401 || response.status === 403) {
      throw new Error('Gemini rejected the API key. Check GEMINI_API_KEY.');
    }
    if (response.status === 429) {
      throw new Error('Gemini is rate limiting this key. Wait a moment and try again.');
    }
    throw new Error(`Gemini request failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const text = extractText(await response.json());

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Gemini did not return usable JSON. Try again, or reword the topic.');
  }

  const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
  if (questions.length === 0) throw new Error('Gemini returned no questions. Try a clearer topic.');

  // Shape only. Real validation happens where a typed question is validated.
  return questions
    .filter(
      (question) =>
        typeof question?.text === 'string' &&
        Array.isArray(question?.options) &&
        Number.isInteger(question?.correctIndex),
    )
    .map((question) => ({
      text: question.text.trim(),
      options: question.options.map((option) => String(option).trim()),
      correctIndex: question.correctIndex,
    }));
}

/**
 * Render drafts in the same pasted-text format the bulk importer reads, so an
 * AI draft and a spreadsheet paste land in exactly the same review box.
 */
export function toPasteFormat(questions) {
  return questions
    .map(({ text, options, correctIndex }) =>
      [text, ...options.map((option, index) => (index === correctIndex ? `*${option}` : option))]
        // Tabs are the separator, so strip any the model produced.
        .map((cell) => cell.replace(/\t/g, ' '))
        .join('\t'),
    )
    .join('\n');
}
