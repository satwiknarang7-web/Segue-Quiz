import { api, clear, el, formatTimeLimit, showError, toast } from './api.js';

const list = document.querySelector('#quiz-list');
const pageError = document.querySelector('#page-error');
const dialog = document.querySelector('#new-quiz-dialog');
const dialogError = document.querySelector('#dialog-error');
const form = document.querySelector('#new-quiz-form');

document.querySelector('#sign-out').addEventListener('click', async () => {
  await fetch('/api/auth/signout', { method: 'POST' });
  window.location.href = '/';
});

/** Show who is signed in, and flag a recovery code that was just spent. */
async function renderAccount() {
  try {
    const me = await fetch('/api/auth/me').then((response) => response.json());
    if (me.user) document.querySelector('#account-name').textContent = me.user.name;
  } catch {
    /* the header greeting is optional */
  }

  const remaining = window.sessionStorage.getItem('seguequiz:recovery-notice');
  if (remaining !== null) {
    window.sessionStorage.removeItem('seguequiz:recovery-notice');
    toast(`Signed in with a recovery code — ${remaining} left`);
  }
}

document.querySelector('#new-quiz-button').addEventListener('click', () => {
  dialogError.hidden = true;
  form.reset();
  dialog.showModal();
  document.querySelector('#quiz-title').focus();
});

document.querySelector('#cancel-new-quiz').addEventListener('click', () => dialog.close());

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const minutes = Number(document.querySelector('#quiz-minutes').value || 0);
  const seconds = Number(document.querySelector('#quiz-seconds').value || 0);
  const timeLimitSeconds = minutes * 60 + seconds;

  if (timeLimitSeconds < 10) {
    showError(dialogError, 'The time limit must be at least 10 seconds.');
    return;
  }

  const submitButton = document.querySelector('#submit-new-quiz');
  submitButton.disabled = true;

  try {
    const { quiz } = await api.createQuiz({
      title: document.querySelector('#quiz-title').value,
      description: document.querySelector('#quiz-description').value,
      timeLimitSeconds,
    });
    // Straight into the editor: a quiz without questions is not much use.
    window.location.href = `/quizzes/${quiz.id}`;
  } catch (error) {
    showError(dialogError, error.message);
    submitButton.disabled = false;
  }
});

function quizCard(quiz) {
  const status = quiz.isPublished
    ? el('span', { class: 'badge badge--live', text: 'Open' })
    : el('span', { class: 'badge badge--draft', text: 'Draft' });

  return el('article', { class: 'card stack' }, [
    el('div', { class: 'row' }, [
      status,
      el('span', { class: 'badge', text: `${quiz.questionCount} question${quiz.questionCount === 1 ? '' : 's'}` }),
      el('span', { class: 'badge', text: formatTimeLimit(quiz.timeLimitSeconds) }),
    ]),
    el('div', { class: 'stack stack--tight' }, [
      el('h2', { class: 'card__title', text: quiz.title }),
      quiz.description ? el('p', { class: 'meta', text: quiz.description }) : null,
    ]),
    el('div', { class: 'row' }, [
      el('span', { class: 'code-chip', text: quiz.id }),
      el('span', { class: 'spacer' }),
      el('span', {
        class: 'meta',
        text: `${quiz.attemptCount} attempt${quiz.attemptCount === 1 ? '' : 's'}`,
      }),
    ]),
    el('div', { class: 'row' }, [
      openControl(quiz),
      el('a', { class: 'button button--ghost button--small', href: `/quizzes/${quiz.id}`, text: 'Edit' }),
      el('a', {
        class: 'button button--ghost button--small',
        href: `/quizzes/${quiz.id}/results`,
        text: 'Leaderboard',
      }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'button button--danger button--small',
        type: 'button',
        onClick: () => deleteQuiz(quiz),
        text: 'Delete',
      }),
    ]),
  ]);
}

/**
 * The single most important action on a card: a quiz nobody can join is the
 * default state, so opening it must not be buried in a settings form.
 */
function openControl(quiz) {
  if (quiz.questionCount === 0) {
    return el('a', {
      class: 'button button--small',
      href: `/quizzes/${quiz.id}`,
      text: 'Add questions',
      title: 'A quiz needs at least one question before it can be opened.',
    });
  }

  return el('button', {
    class: `button button--small${quiz.isPublished ? ' button--ghost' : ''}`,
    type: 'button',
    text: quiz.isPublished ? 'Close quiz' : 'Open quiz',
    title: quiz.isPublished
      ? 'Stop accepting new attempts.'
      : 'Let participants join with the QR code or join code.',
    onClick: () => setPublished(quiz, !quiz.isPublished),
  });
}

async function setPublished(quiz, isPublished) {
  try {
    await api.updateQuiz(quiz.id, { isPublished });
    toast(isPublished ? 'Quiz is open — participants can join now' : 'Quiz closed');
    await render();
  } catch (error) {
    showError(pageError, error.message);
  }
}

async function deleteQuiz(quiz) {
  const confirmed = window.confirm(
    `Delete "${quiz.title}"? Its ${quiz.attemptCount} recorded attempt(s) will be removed too.`,
  );
  if (!confirmed) return;

  try {
    await api.deleteQuiz(quiz.id);
    toast('Quiz deleted');
    await render();
  } catch (error) {
    showError(pageError, error.message);
  }
}

async function render() {
  try {
    const { quizzes } = await api.listQuizzes();
    pageError.hidden = true;
    clear(list);

    if (quizzes.length === 0) {
      list.append(
        el('div', { class: 'card empty-state', style: 'grid-column: 1 / -1' }, [
          el('h3', { text: 'No quizzes yet' }),
          el('p', { text: 'Create your first quiz to get a join code and a QR code.' }),
        ]),
      );
      return;
    }

    quizzes.forEach((quiz) => list.append(quizCard(quiz)));
  } catch (error) {
    showError(pageError, error.message);
  }
}

renderAccount();
render();
