import { api, clear, el, formatTimeLimit, hideNotice, showError, toast } from './api.js';

const quizId = window.location.pathname.split('/').filter(Boolean)[1];

const pageError = document.querySelector('#page-error');
const questionList = document.querySelector('#question-list');
const questionCount = document.querySelector('#question-count');
const heading = document.querySelector('#quiz-heading');
const subheading = document.querySelector('#quiz-subheading');

const dialog = document.querySelector('#question-dialog');
const dialogTitle = document.querySelector('#question-dialog-title');
const optionRows = document.querySelector('#option-rows');
const answerRows = document.querySelector('#answer-rows');
const MAX_ACCEPTED_ANSWERS = 12;
const questionError = document.querySelector('#question-error');
const settingsError = document.querySelector('#settings-error');

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

let quiz = null;
let editingQuestionId = null;

/* ---- Rendering ---------------------------------------------------------- */

/** The answer key as the author sees it, which depends on the type. */
function renderAnswerKey(question) {
  if (question.type === 'draw') {
    return [
      el('li', { class: 'answer' }, [
        el('span', { class: 'answer__marker', text: '✎' }),
        el('span', { text: 'Marked by you after the quiz' }),
      ]),
    ];
  }

  if (question.type === 'short') {
    const [first, ...rest] = question.acceptedAnswers ?? [];
    return [
      el('li', { class: 'answer answer--correct' }, [
        el('span', { class: 'answer__marker', text: '✓' }),
        el('span', { class: 'answer-key', text: first ?? '' }),
      ]),
      // The alternatives matter to whoever is checking the key, but they are
      // the same answer, so they read as one line rather than several rows.
      rest.length > 0
        ? el('li', { class: 'answer' }, [
            el('span', { class: 'answer__marker', text: '' }),
            el('span', { class: 'answer-key', text: `also: ${rest.join(', ')}` }),
          ])
        : null,
    ].filter(Boolean);
  }

  return question.options.map((option, optionIndex) =>
    el(
      'li',
      { class: `answer${optionIndex === question.correctIndex ? ' answer--correct' : ''}` },
      [
        el('span', { class: 'answer__marker', text: OPTION_LABELS[optionIndex] }),
        el('span', { text: option }),
      ],
    ),
  );
}

function renderQuestion(question, index) {
  const answers = renderAnswerKey(question);

  return el('article', { class: 'question' }, [
    el('div', { class: 'question__head' }, [
      el('span', { class: 'question__index', text: `Q${index + 1}` }),
      el('span', { class: 'question__text', text: question.text }),
      question.type === 'short' ? el('span', { class: 'badge', text: 'Typed' }) : null,
      question.type === 'draw' ? el('span', { class: 'badge', text: 'Drawn' }) : null,
      el('span', { class: 'badge', text: `${question.points} pt${question.points === 1 ? '' : 's'}` }),
    ]),
    question.imageUrl
      ? el('img', {
          class: 'question__figure',
          src: question.imageUrl,
          alt: question.imageAlt || '',
          loading: 'lazy',
        })
      : null,
    el('ul', { class: 'answer-list' }, answers),
    el('div', { class: 'row' }, [
      el('button', {
        class: 'button button--ghost button--small',
        type: 'button',
        text: 'Edit',
        onClick: () => openQuestionDialog(question),
      }),
      el('button', {
        class: 'button button--ghost button--small',
        type: 'button',
        text: '↑',
        'aria-label': 'Move up',
        disabled: index === 0,
        onClick: () => moveQuestion(question.id, 'up'),
      }),
      el('button', {
        class: 'button button--ghost button--small',
        type: 'button',
        text: '↓',
        'aria-label': 'Move down',
        disabled: index === quiz.questions.length - 1,
        onClick: () => moveQuestion(question.id, 'down'),
      }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'button button--danger button--small',
        type: 'button',
        text: 'Delete',
        onClick: () => deleteQuestion(question),
      }),
    ]),
  ]);
}

function render() {
  heading.textContent = quiz.title;
  document.title = `${quiz.title} · SegueQuiz`;

  const points = quiz.questions.reduce((sum, question) => sum + question.points, 0);
  subheading.textContent = [
    quiz.isPublished ? 'Open for taking' : 'Draft — not yet open',
    `${quiz.questions.length} question${quiz.questions.length === 1 ? '' : 's'}`,
    `${points} point${points === 1 ? '' : 's'}`,
    formatTimeLimit(quiz.timeLimitSeconds),
  ].join(' · ');

  renderPublishToggle();
  questionCount.textContent = String(quiz.questions.length);
  clear(questionList);

  if (quiz.questions.length === 0) {
    questionList.append(
      el('div', { class: 'empty-state' }, [
        el('h3', { text: 'No questions yet' }),
        el('p', { text: 'Add a question to make this quiz playable.' }),
      ]),
    );
    return;
  }

  quiz.questions.forEach((question, index) => questionList.append(renderQuestion(question, index)));
}

/** Opening the quiz is a one-click action here, not a checkbox you must remember to save. */
function renderPublishToggle() {
  const button = document.querySelector('#publish-toggle');
  button.hidden = false;

  if (quiz.questions.length === 0) {
    button.textContent = 'Add a question to open';
    button.className = 'button button--ghost';
    button.disabled = true;
    return;
  }

  button.disabled = false;
  button.textContent = quiz.isPublished ? 'Close quiz' : 'Open quiz';
  button.className = quiz.isPublished ? 'button button--ghost' : 'button';
}

document.querySelector('#publish-toggle').addEventListener('click', async () => {
  const button = document.querySelector('#publish-toggle');
  button.disabled = true;

  try {
    const { quiz: updated } = await api.updateQuiz(quizId, { isPublished: !quiz.isPublished });
    quiz = updated;
    render();
    renderSettings();
    await renderShare();
    toast(quiz.isPublished ? 'Quiz is open — participants can join now' : 'Quiz closed');
  } catch (error) {
    showError(pageError, error.message);
    renderPublishToggle();
  }
});

function renderSettings() {
  document.querySelector('#setting-title').value = quiz.title;
  document.querySelector('#setting-description').value = quiz.description ?? '';
  document.querySelector('#setting-minutes').value = Math.floor(quiz.timeLimitSeconds / 60);
  document.querySelector('#setting-seconds').value = quiz.timeLimitSeconds % 60;
  document.querySelector('#setting-published').checked = quiz.isPublished;
  document.querySelector('#setting-retakes').checked = quiz.allowRetakes;
  document.querySelector('#setting-end-on-leave').checked = quiz.endOnLeave !== false;
  document.querySelector('#setting-shuffle-questions').checked = Boolean(quiz.shuffleQuestions);
  document.querySelector('#setting-shuffle-options').checked = Boolean(quiz.shuffleOptions);
  document.querySelector('#setting-reveal-answers').checked = Boolean(quiz.revealAnswers);
}

async function renderShare() {
  const share = await api.getShare(quizId);

  document.querySelector('#join-code').textContent = share.joinCode;
  document.querySelector('#join-url').textContent = share.joinUrl;
  // Cache-bust so the QR refreshes if the server's base URL changes.
  document.querySelector('#qr-image').src = `${share.qrSvgUrl}?v=${Date.now()}`;
  document.querySelector('#download-qr').href = share.qrPngUrl;
  document.querySelector('#download-qr').download = `seguequiz-${share.joinCode}.png`;
  document.querySelector('#results-link').href = `/quizzes/${quizId}/results`;

  document.querySelector('#share-hint').textContent = share.isPublished
    ? 'Participants can scan this now.'
    : 'Press "Open quiz" above before sharing this code.';

  document.querySelector('#copy-link').onclick = async () => {
    try {
      await navigator.clipboard.writeText(share.joinUrl);
      toast('Join link copied');
    } catch {
      window.prompt('Copy this link:', share.joinUrl);
    }
  };
}

/* ---- Bulk paste --------------------------------------------------------- */

const bulkDialog = document.querySelector('#bulk-dialog');
const bulkText = document.querySelector('#bulk-text');
const bulkError = document.querySelector('#bulk-error');
const bulkImport = document.querySelector('#bulk-import');
const bulkPreview = document.querySelector('#bulk-preview');

let previewTimer = null;

// The panel only appears when the server has a key, so a maker is never
// offered a button that cannot work.
async function showAiPanelIfAvailable() {
  try {
    const { available } = await api.aiStatus();
    document.querySelector('#ai-panel').hidden = !available;
  } catch {
    document.querySelector('#ai-panel').hidden = true;
  }
}

document.querySelector('#ai-generate').addEventListener('click', async () => {
  const button = document.querySelector('#ai-generate');
  const aiError = document.querySelector('#ai-error');
  const topic = document.querySelector('#ai-topic').value.trim();

  aiError.hidden = true;

  if (topic.length < 3) {
    showError(aiError, 'Say what the quiz should be about first.');
    return;
  }

  button.disabled = true;
  button.textContent = 'Drafting…';

  try {
    const { text, count } = await api.generateQuestions(quizId, {
      topic,
      count: Number(document.querySelector('#ai-count').value) || 10,
      difficulty: document.querySelector('#ai-difficulty').value,
      style: document.querySelector('#ai-style').value,
    });

    // Straight into the review box, never straight into the quiz.
    const box = document.querySelector('#bulk-text');
    box.value = box.value.trim() ? [box.value.trim(), text].join('\n') : text;
    box.dispatchEvent(new Event('input', { bubbles: true }));

    toast(`Drafted ${count} question${count === 1 ? '' : 's'} — check them before importing`);
  } catch (error) {
    showError(aiError, error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Draft questions';
  }
});

document.querySelector('#bulk-add-button').addEventListener('click', () => {
  bulkText.value = '';
  bulkError.hidden = true;
  bulkPreview.hidden = true;
  bulkImport.disabled = true;
  document.querySelector('#ai-topic').value = '';
  document.querySelector('#ai-error').hidden = true;
  showAiPanelIfAvailable();

  bulkDialog.showModal();
  bulkText.focus();
});

document.querySelector('#bulk-cancel').addEventListener('click', () => bulkDialog.close());

// The preview is a dry run of the real import, so what is shown here is
// exactly what would be created - the parsing lives in one place only.
bulkText.addEventListener('input', () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshBulkPreview, 250);
});

async function refreshBulkPreview() {
  const text = bulkText.value.trim();

  if (text === '') {
    bulkPreview.hidden = true;
    bulkImport.disabled = true;
    return;
  }

  try {
    const { questions, errors } = await api.addQuestionsFromText(quizId, bulkText.value, true);

    const label = document.querySelector('#bulk-preview-label');
    label.textContent = errors.length
      ? `${questions.length} ready, ${errors.length} line(s) to fix`
      : `${questions.length} question${questions.length === 1 ? '' : 's'} ready to import`;

    const list = clear(document.querySelector('#bulk-preview-list'));

    for (const question of questions) {
      list.append(
        el('div', { class: 'bulk-row' }, [
          el('span', { class: 'bulk-row__line', text: `L${question.line}` }),
          el('span', {
            text:
              question.type === 'short'
                ? `${question.text}  —  typed, accepts: ${question.acceptedAnswers.join(', ')}`
                : `${question.text}  —  ${question.options.length} options, answer: ${
                    question.options[question.correctIndex]
                  }`,
          }),
        ]),
      );
    }

    for (const problem of errors) {
      list.append(
        el('div', { class: 'bulk-row', dataset: { bad: 'true' } }, [
          el('span', { class: 'bulk-row__line', text: `L${problem.line}` }),
          el('span', { text: problem.message }),
        ]),
      );
    }

    bulkPreview.hidden = false;
    bulkError.hidden = true;
    // Refuse the import while anything is broken: a half-imported quiz is
    // more annoying to repair than one that never imported.
    bulkImport.disabled = errors.length > 0 || questions.length === 0;
  } catch (error) {
    showError(bulkError, error.message);
    bulkImport.disabled = true;
  }
}

bulkImport.addEventListener('click', async () => {
  bulkImport.disabled = true;

  try {
    const { quiz: updated, added } = await api.addQuestionsFromText(quizId, bulkText.value, false);
    quiz = updated;
    render();
    bulkDialog.close();
    toast(`Added ${added} question${added === 1 ? '' : 's'}`);
  } catch (error) {
    showError(bulkError, error.message);
    bulkImport.disabled = false;
  }
});

/* ---- Question dialog ---------------------------------------------------- */

function optionRow(value = '', isCorrect = false) {
  const radio = el('input', {
    type: 'radio',
    name: 'correct-option',
    aria: 'Correct answer',
    'aria-label': 'Mark as the correct answer',
  });
  radio.checked = isCorrect;

  const input = el('input', {
    type: 'text',
    maxlength: '200',
    placeholder: 'Answer option',
    value,
  });

  const remove = el('button', {
    class: 'button button--ghost button--small remove-option',
    type: 'button',
    text: '✕',
    'aria-label': 'Remove this option',
    onClick: () => {
      if (optionRows.children.length <= MIN_OPTIONS) {
        showError(questionError, `A question needs at least ${MIN_OPTIONS} options.`);
        return;
      }
      const wasChecked = radio.checked;
      row.remove();
      if (wasChecked) optionRows.querySelector('input[type="radio"]').checked = true;
      syncOptionControls();
    },
  });

  const row = el('div', { class: 'option-row' }, [radio, input, remove]);
  return row;
}

/** One accepted spelling of a typed answer. */
function answerRow(value = '') {
  const input = el('input', {
    type: 'text',
    maxlength: '200',
    placeholder: 'An answer that should be marked right',
    value,
  });

  const remove = el('button', {
    class: 'button button--ghost button--small remove-option',
    type: 'button',
    text: '✕',
    'aria-label': 'Remove this accepted answer',
    onClick: () => {
      if (answerRows.children.length <= 1) {
        showError(questionError, 'A typed question needs at least one accepted answer.');
        return;
      }
      row.remove();
      syncOptionControls();
    },
  });

  const row = el('div', { class: 'option-row' }, [input, remove]);
  return row;
}

/* ---- The diagram on a question ---- */

// Held here rather than read back off the preview, so that cancelling the
// dialog cannot leave a half-attached image behind.
let questionImageUrl = null;

function renderImagePicker() {
  const preview = document.querySelector('#image-preview');
  const alt = document.querySelector('#image-alt');
  const remove = document.querySelector('#image-remove');
  const file = document.querySelector('#image-file');

  const attached = Boolean(questionImageUrl);
  preview.hidden = !attached;
  alt.hidden = !attached;
  remove.hidden = !attached;
  file.hidden = attached;
  // What may be uploaded stops being useful once something has been.
  document.querySelector('#image-hint').hidden = attached;

  if (attached) preview.src = questionImageUrl;
}

function setQuestionImage(url, altText = '') {
  questionImageUrl = url;
  document.querySelector('#image-alt').value = altText;
  document.querySelector('#image-file').value = '';
  renderImagePicker();
}

async function uploadQuestionImage(file) {
  const hint = document.querySelector('#image-hint');
  hint.textContent = 'Uploading…';

  try {
    // FileReader gives a data: URL; the server accepts that form directly, so
    // there is no prefix stripping to get wrong on either side.
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('That file could not be read.'));
      reader.readAsDataURL(file);
    });

    const { url } = await api.uploadImage(quizId, dataUrl);
    setQuestionImage(url, document.querySelector('#image-alt').value);
    hint.textContent = 'PNG, JPEG, GIF or WebP, up to 3 MB.';
  } catch (error) {
    hint.textContent = 'PNG, JPEG, GIF or WebP, up to 3 MB.';
    document.querySelector('#image-file').value = '';
    showError(questionError, error.message);
  }
}

document.querySelector('#image-file').addEventListener('change', (event) => {
  const [file] = event.target.files ?? [];
  if (file) uploadQuestionImage(file);
});

document.querySelector('#image-remove').addEventListener('click', () => {
  setQuestionImage(null);
  hideNotice(questionError);
});

function currentQuestionType() {
  return document.querySelector('input[name="question-type"]:checked')?.value ?? 'choice';
}

/** Show the fields the chosen type needs, and only those. */
function syncQuestionType() {
  const type = currentQuestionType();
  // A drawing has no answer key at all, so neither block applies.
  document.querySelector('#choice-fields').hidden = type !== 'choice';
  document.querySelector('#short-fields').hidden = type !== 'short';
  document.querySelector('#draw-note').hidden = type !== 'draw';
  hideNotice(questionError);
  syncOptionControls();
}

function syncOptionControls() {
  document.querySelector('#add-option').disabled = optionRows.children.length >= MAX_OPTIONS;
  document.querySelector('#add-answer').disabled = answerRows.children.length >= MAX_ACCEPTED_ANSWERS;
}

function openQuestionDialog(question = null) {
  editingQuestionId = question?.id ?? null;
  dialogTitle.textContent = question ? 'Edit question' : 'Add question';
  hideNotice(questionError);

  document.querySelector('#question-text').value = question?.text ?? '';
  document.querySelector('#question-points').value = question?.points ?? 1;

  const type = ['short', 'draw'].includes(question?.type) ? question.type : 'choice';
  document.querySelector(`input[name="question-type"][value="${type}"]`).checked = true;

  clear(optionRows);
  const options = question?.type === 'short' ? ['', ''] : (question?.options ?? ['', '']);
  options.forEach((option, index) =>
    optionRows.append(optionRow(option, index === (question?.correctIndex ?? 0))),
  );

  clear(answerRows);
  const accepted = question?.acceptedAnswers?.length ? question.acceptedAnswers : [''];
  accepted.forEach((answer) => answerRows.append(answerRow(answer)));

  setQuestionImage(question?.imageUrl ?? null, question?.imageAlt ?? '');
  syncQuestionType();
  dialog.showModal();
  document.querySelector('#question-text').focus();
}

document.querySelector('#add-question-button').addEventListener('click', () => openQuestionDialog());
document.querySelector('#cancel-question').addEventListener('click', () => dialog.close());

for (const radio of document.querySelectorAll('input[name="question-type"]')) {
  radio.addEventListener('change', syncQuestionType);
}

document.querySelector('#add-answer').addEventListener('click', () => {
  if (answerRows.children.length >= MAX_ACCEPTED_ANSWERS) return;
  answerRows.append(answerRow());
  syncOptionControls();
  hideNotice(questionError);
});

document.querySelector('#add-option').addEventListener('click', () => {
  if (optionRows.children.length >= MAX_OPTIONS) return;
  optionRows.append(optionRow());
  syncOptionControls();
  hideNotice(questionError);
});

document.querySelector('#question-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  const type = currentQuestionType();
  const payload = {
    type,
    text: document.querySelector('#question-text').value,
    points: Number(document.querySelector('#question-points').value || 1),
    imageUrl: questionImageUrl ?? '',
    imageAlt: document.querySelector('#image-alt').value,
  };

  if (type === 'draw') {
    // Nothing else to collect: the answer key is a person, later.
  } else if (type === 'short') {
    const accepted = [...answerRows.children]
      .map((row) => row.querySelector('input[type="text"]').value.trim())
      .filter((answer) => answer !== '');

    if (accepted.length === 0) {
      showError(questionError, 'Give at least one answer that should be marked right.');
      return;
    }
    payload.acceptedAnswers = accepted;
  } else {
    const rows = [...optionRows.children];
    const options = rows.map((row) => row.querySelector('input[type="text"]').value.trim());
    const correctIndex = rows.findIndex((row) => row.querySelector('input[type="radio"]').checked);

    if (options.some((option) => option === '')) {
      showError(questionError, 'Every option needs text.');
      return;
    }
    if (correctIndex === -1) {
      showError(questionError, 'Select which option is correct.');
      return;
    }
    payload.options = options;
    payload.correctIndex = correctIndex;
  }

  const saveButton = document.querySelector('#save-question');
  saveButton.disabled = true;

  try {
    const response = editingQuestionId
      ? await api.updateQuestion(quizId, editingQuestionId, payload)
      : await api.addQuestion(quizId, payload);

    quiz = response.quiz;
    render();
    renderSettings();
    dialog.close();
    toast(editingQuestionId ? 'Question updated' : 'Question added');
  } catch (error) {
    showError(questionError, error.message);
  } finally {
    saveButton.disabled = false;
  }
});

/* ---- Actions ------------------------------------------------------------ */

async function moveQuestion(questionId, direction) {
  try {
    const { quiz: updated } = await api.moveQuestion(quizId, questionId, direction);
    quiz = updated;
    render();
  } catch (error) {
    showError(pageError, error.message);
  }
}

async function deleteQuestion(question) {
  if (!window.confirm(`Delete this question?\n\n${question.text}`)) return;
  try {
    const { quiz: updated } = await api.deleteQuestion(quizId, question.id);
    quiz = updated;
    render();
    renderSettings();
    toast('Question deleted');
  } catch (error) {
    showError(pageError, error.message);
  }
}

document.querySelector('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  hideNotice(settingsError);

  const minutes = Number(document.querySelector('#setting-minutes').value || 0);
  const seconds = Number(document.querySelector('#setting-seconds').value || 0);
  const timeLimitSeconds = minutes * 60 + seconds;

  if (timeLimitSeconds < 10) {
    showError(settingsError, 'The time limit must be at least 10 seconds.');
    return;
  }

  const saveButton = document.querySelector('#save-settings');
  saveButton.disabled = true;

  try {
    const { quiz: updated } = await api.updateQuiz(quizId, {
      title: document.querySelector('#setting-title').value,
      description: document.querySelector('#setting-description').value,
      timeLimitSeconds,
      isPublished: document.querySelector('#setting-published').checked,
      allowRetakes: document.querySelector('#setting-retakes').checked,
      endOnLeave: document.querySelector('#setting-end-on-leave').checked,
      shuffleQuestions: document.querySelector('#setting-shuffle-questions').checked,
      shuffleOptions: document.querySelector('#setting-shuffle-options').checked,
      revealAnswers: document.querySelector('#setting-reveal-answers').checked,
    });
    quiz = updated;
    render();
    renderSettings();
    await renderShare();
    toast('Settings saved');
  } catch (error) {
    showError(settingsError, error.message);
    renderSettings();
  } finally {
    saveButton.disabled = false;
  }
});

/* ---- Boot --------------------------------------------------------------- */

async function load() {
  try {
    const response = await api.getQuiz(quizId);
    quiz = response.quiz;
    render();
    renderSettings();
    await renderShare();
  } catch (error) {
    heading.textContent = 'Quiz not found';
    subheading.textContent = '';
    showError(pageError, error.message);
  }
}

load();
