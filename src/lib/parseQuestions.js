/**
 * Turn pasted rows into questions.
 *
 * One question per line. The first cell is the question, every cell after it
 * is an option, and the correct one is marked with a leading asterisk:
 *
 *   Capital of France?<TAB>Berlin<TAB>*Paris<TAB>Madrid
 *
 * Tab-separated is the default because that is what copying cells out of Excel
 * or Google Sheets actually produces; comma-separated is accepted too, with
 * quoted cells so a question can contain a comma.
 *
 * Marking the answer inline rather than in a fixed column is what lets one
 * paste mix two-option and six-option questions.
 */

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

/** Split one line, honouring "quoted cells" so a delimiter can appear inside. */
function splitLine(line, delimiter) {
  const cells = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (quoted) {
      if (character === '"') {
        // A doubled quote inside a quoted cell is a literal quote.
        if (line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
    } else if (character === '"' && cell.trim() === '') {
      quoted = true;
    } else if (character === delimiter) {
      cells.push(cell);
      cell = '';
    } else {
      cell += character;
    }
  }

  cells.push(cell);
  return cells.map((value) => value.trim());
}

/** Tabs win when present, since that is what a spreadsheet paste looks like. */
function detectDelimiter(lines) {
  return lines.some((line) => line.includes('\t')) ? '\t' : ',';
}

export function parseBulkQuestions(input) {
  const lines = String(input ?? '')
    .split(/\r?\n/)
    .map((line, index) => ({ line, number: index + 1 }))
    // Blank lines and # comments let people annotate their paste.
    .filter(({ line }) => line.trim() !== '' && !line.trim().startsWith('#'));

  if (lines.length === 0) return { questions: [], errors: [] };

  const delimiter = detectDelimiter(lines.map(({ line }) => line));
  const questions = [];
  const errors = [];

  for (const { line, number } of lines) {
    const cells = splitLine(line, delimiter).filter((cell, index) => index === 0 || cell !== '');
    const [text, ...rawOptions] = cells;

    if (!text) {
      errors.push({ line: number, message: 'No question text.' });
      continue;
    }

    if (rawOptions.length < MIN_OPTIONS) {
      errors.push({
        line: number,
        message: `Only ${rawOptions.length} option(s); at least ${MIN_OPTIONS} are needed.`,
      });
      continue;
    }

    if (rawOptions.length > MAX_OPTIONS) {
      errors.push({
        line: number,
        message: `${rawOptions.length} options; at most ${MAX_OPTIONS} are allowed.`,
      });
      continue;
    }

    const marked = rawOptions
      .map((option, index) => (option.startsWith('*') ? index : -1))
      .filter((index) => index !== -1);

    if (marked.length === 0) {
      errors.push({ line: number, message: 'No correct answer marked. Put * before one option.' });
      continue;
    }

    if (marked.length > 1) {
      errors.push({
        line: number,
        message: `${marked.length} options marked correct; exactly one * is allowed.`,
      });
      continue;
    }

    const options = rawOptions.map((option) => option.replace(/^\*\s*/, '').trim());

    if (options.some((option) => option === '')) {
      errors.push({ line: number, message: 'An option is empty.' });
      continue;
    }

    questions.push({
      line: number,
      text,
      options,
      correctIndex: marked[0],
      points: 1,
    });
  }

  return { questions, errors };
}
