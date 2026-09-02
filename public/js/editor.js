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
const questionError = document.querySelector('#question-error');
const settingsError = document.querySelector('#settings-error');

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

let quiz = null;
let editingQuestionId = null;

/* ---- Rendering ---------------------------------------------------------- */

function renderQuestion(question, index) {
  const answers = question.options.map((option, optionIndex) =>
    el(
      'li',
      { class: `answer${optionIndex === question.correctIndex ? ' answer--correct' : ''}` },
      [
        el('span', { class: 'answer__marker', text: OPTION_LABELS[optionIndex] }),
        el('span', { text: option }),
      ],
    ),
  );

  return el('article', { class: 'question' }, [
    el('div', { class: 'question__head' }, [
      el('span', { class: 'question__index', text: `Q${index + 1}` }),
      el('span', { class: 'question__text', text: question.text }),
      el('span', { class: 'badge', text: `${question.points} pt${question.points === 1 ? '' : 's'}` }),
    ]),
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

function syncOptionControls() {
  document.querySelector('#add-option').disabled = optionRows.children.length >= MAX_OPTIONS;
}

function openQuestionDialog(question = null) {
  editingQuestionId = question?.id ?? null;
  dialogTitle.textContent = question ? 'Edit question' : 'Add question';
  hideNotice(questionError);

  document.querySelector('#question-text').value = question?.text ?? '';
  document.querySelector('#question-points').value = question?.points ?? 1;

  clear(optionRows);
  const options = question?.options ?? ['', ''];
  options.forEach((option, index) =>
    optionRows.append(optionRow(option, index === (question?.correctIndex ?? 0))),
  );

  syncOptionControls();
  dialog.showModal();
  document.querySelector('#question-text').focus();
}

document.querySelector('#add-question-button').addEventListener('click', () => openQuestionDialog());
document.querySelector('#cancel-question').addEventListener('click', () => dialog.close());

document.querySelector('#add-option').addEventListener('click', () => {
  if (optionRows.children.length >= MAX_OPTIONS) return;
  optionRows.append(optionRow());
  syncOptionControls();
  hideNotice(questionError);
});

document.querySelector('#question-form').addEventListener('submit', async (event) => {
  event.preventDefault();

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

  const payload = {
    text: document.querySelector('#question-text').value,
    options,
    correctIndex,
    points: Number(document.querySelector('#question-points').value || 1),
  };

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
