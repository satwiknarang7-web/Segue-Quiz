import { api, clear, el, formatDuration, formatTimeLimit, showError, toast } from './api.js';

const quizId = window.location.pathname.split('/').filter(Boolean)[1];
const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

const views = {
  intro: document.querySelector('#intro-view'),
  quiz: document.querySelector('#quiz-view'),
  result: document.querySelector('#result-view'),
};

const pageError = document.querySelector('#page-error');
const timerNode = document.querySelector('#timer');

const state = {
  quiz: null,
  attemptId: null,
  answers: {},
  index: 0,
  endsAt: 0,
  submitting: false,
  ticker: null,
  endOnLeave: false,
  endedByLeaving: false,
};

function showView(name) {
  for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
}

/* ---- Step 1: intro ------------------------------------------------------ */

async function loadIntro() {
  try {
    const intro = await api.getIntro(quizId);
    document.title = `${intro.title} · SegueQuiz`;
    document.querySelector('#intro-title').textContent = intro.title;

    const description = document.querySelector('#intro-description');
    description.textContent = intro.description || '';
    description.hidden = !intro.description;

    clear(document.querySelector('#intro-badges')).append(
      el('span', {
        class: 'badge',
        text: `${intro.questionCount} question${intro.questionCount === 1 ? '' : 's'}`,
      }),
      el('span', { class: 'badge', text: formatTimeLimit(intro.timeLimitSeconds) }),
      el('span', { class: 'badge', text: `${intro.totalPoints} points` }),
    );

    document.querySelector('#leave-warning').hidden = !intro.endOnLeave;
    document.querySelector('#one-attempt-note').hidden = intro.allowRetakes;

    showView('intro');

    if (!intro.isPublished || intro.questionCount === 0) {
      const message = intro.questionCount === 0
        ? 'This quiz has no questions yet.'
        : 'This quiz is not open yet. Ask the organiser to open it.';
      showError(document.querySelector('#start-error'), message);
      document.querySelector('#start-button').disabled = true;
    }
  } catch (error) {
    showError(pageError, error.message);
  }
}

document.querySelector('#start-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  const startError = document.querySelector('#start-error');
  const startButton = document.querySelector('#start-button');
  startError.hidden = true;
  startButton.disabled = true;

  try {
    const { attempt, quiz, resumed } = await api.startAttempt(
      quizId,
      document.querySelector('#participant-name').value,
    );

    state.quiz = quiz;
    state.attemptId = attempt.attemptId;
    state.answers = attempt.answers ?? {};
    // Trust the server's remaining time, then run the countdown locally.
    state.endsAt = Date.now() + attempt.remainingMs;

    // Resuming after a refresh: pick up at the first unanswered question.
    const firstUnanswered = quiz.questions.findIndex((question) => !(question.id in state.answers));
    state.index = resumed && firstUnanswered !== -1 ? firstUnanswered : 0;

    state.endOnLeave = quiz.endOnLeave !== false;
    document.querySelector('#leave-reminder').hidden = !state.endOnLeave;

    showView('quiz');
    renderQuestion();
    startTicker();
    if (state.endOnLeave) watchForLeaving();

    if (resumed) toast('Welcome back — your timer kept running.');
  } catch (error) {
    showError(startError, error.message);
    startButton.disabled = false;
  }
});

/* ---- Step 2: the quiz --------------------------------------------------- */

function startTicker() {
  clearInterval(state.ticker);
  tick();
  state.ticker = setInterval(tick, 250);
}

function tick() {
  const remaining = Math.max(0, state.endsAt - Date.now());
  const seconds = Math.ceil(remaining / 1000);
  timerNode.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  timerNode.classList.toggle('timer--warning', remaining <= 60_000 && remaining > 15_000);
  timerNode.classList.toggle('timer--critical', remaining <= 15_000);

  if (remaining === 0) {
    clearInterval(state.ticker);
    submit({ automatic: true });
  }
}

function renderQuestion() {
  const question = state.quiz.questions[state.index];
  const total = state.quiz.questions.length;

  document.querySelector('#question-position').textContent = `Question ${state.index + 1} of ${total}`;
  document.querySelector('#question-prompt').textContent = question.text;

  const answered = Object.keys(state.answers).length;
  document.querySelector('#progress-fill').style.width = `${(answered / total) * 100}%`;
  document.querySelector('#progress-label').textContent = `${answered}/${total}`;

  const optionList = clear(document.querySelector('#option-list'));
  question.options.forEach((option, index) => {
    const selected = state.answers[question.id] === index;
    optionList.append(
      el(
        'button',
        {
          class: `option${selected ? ' option--selected' : ''}`,
          type: 'button',
          'aria-pressed': selected ? 'true' : 'false',
          onClick: () => selectOption(question, index),
        },
        [
          el('span', { class: 'option__key', text: OPTION_LABELS[index] }),
          el('span', { text: option }),
        ],
      ),
    );
  });

  document.querySelector('#previous-button').disabled = state.index === 0;
  document.querySelector('#next-button').disabled = state.index === total - 1;

  renderNavigator();
}

function renderNavigator() {
  const navigator = clear(document.querySelector('#navigator'));
  state.quiz.questions.forEach((question, index) => {
    navigator.append(
      el('button', {
        type: 'button',
        text: String(index + 1),
        'aria-label': `Go to question ${index + 1}`,
        dataset: {
          answered: String(question.id in state.answers),
          current: String(index === state.index),
        },
        onClick: () => {
          state.index = index;
          renderQuestion();
        },
      }),
    );
  });
}

async function selectOption(question, optionIndex) {
  state.answers[question.id] = optionIndex;
  renderQuestion();

  try {
    // Autosave, so a dropped connection or closed tab does not lose answers.
    await api.saveAnswer(state.attemptId, question.id, optionIndex);
  } catch (error) {
    if (error.status === 410) {
      clearInterval(state.ticker);
      await submit({ automatic: true });
      return;
    }
    showError(pageError, `Could not save that answer: ${error.message}`);
  }
}

document.querySelector('#next-button').addEventListener('click', () => {
  if (state.index < state.quiz.questions.length - 1) {
    state.index += 1;
    renderQuestion();
  }
});

document.querySelector('#previous-button').addEventListener('click', () => {
  if (state.index > 0) {
    state.index -= 1;
    renderQuestion();
  }
});

/**
 * Submitting is final, so it goes through a dialog rather than straight
 * through. A browser confirm() was too easy to dismiss without reading, and
 * could not name which questions were still blank.
 */
const submitDialog = document.querySelector('#submit-dialog');

document.querySelector('#submit-button').addEventListener('click', () => {
  const total = state.quiz.questions.length;
  const answered = Object.keys(state.answers).length;

  const blank = state.quiz.questions
    .map((question, index) => (question.id in state.answers ? null : index + 1))
    .filter((number) => number !== null);

  document.querySelector('#submit-summary').textContent =
    `You have answered ${answered} of ${total} question${total === 1 ? '' : 's'}.`;

  const warning = document.querySelector('#submit-unanswered');
  if (blank.length > 0) {
    warning.textContent =
      blank.length === 1
        ? `Question ${blank[0]} is still blank and will score nothing.`
        : `Questions ${blank.join(', ')} are still blank and will score nothing.`;
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }

  submitDialog.showModal();
});

document.querySelector('#submit-cancel').addEventListener('click', () => submitDialog.close());

document.querySelector('#submit-confirm').addEventListener('click', () => {
  submitDialog.close();
  submit({ automatic: false });
});

async function submit({ automatic }) {
  if (state.submitting) return;
  state.submitting = true;

  // The clock can run out while the confirmation is open; do not leave a
  // dialog asking about a decision that has already been taken.
  if (submitDialog.open) submitDialog.close();
  clearInterval(state.ticker);
  document.querySelector('#submit-button').disabled = true;

  try {
    const { result } = await api.submitAttempt(state.attemptId, state.answers);
    renderResult(result, automatic);
  } catch (error) {
    state.submitting = false;
    document.querySelector('#submit-button').disabled = false;
    showError(pageError, error.message);
  }
}

/* ---- Leaving the quiz ---------------------------------------------------- */

/**
 * Switching tab, switching app or locking the phone all surface as the page
 * becoming hidden. The attempt is ended server-side straight away.
 *
 * The report goes out with sendBeacon because a hidden page may be frozen or
 * killed before a normal fetch completes; a beacon is handed to the browser
 * to deliver regardless.
 */
function watchForLeaving() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') reportLeaving();
    else if (state.endedByLeaving) showLeftResult();
  });

  // Fires on navigation away and on mobile app switches that skip visibilitychange.
  window.addEventListener('pagehide', reportLeaving);
}

function reportLeaving() {
  if (!state.endOnLeave || state.endedByLeaving || state.submitting || !state.attemptId) return;

  state.endedByLeaving = true;
  clearInterval(state.ticker);

  const url = `/api/attempts/${state.attemptId}/abandon`;
  const payload = new Blob(['{}'], { type: 'application/json' });

  if (!navigator.sendBeacon || !navigator.sendBeacon(url, payload)) {
    // keepalive lets the request outlive the page when sendBeacon is unavailable.
    fetch(url, { method: 'POST', body: '{}', keepalive: true }).catch(() => {});
  }
}

/** They came back. Fetch the finalised attempt and show what it scored. */
async function showLeftResult() {
  if (state.submitting) return;
  state.submitting = true;

  try {
    // Submitting an already-finished attempt returns its stored result.
    const { result } = await api.submitAttempt(state.attemptId, state.answers);
    renderResult(result, false);
  } catch (error) {
    showError(pageError, error.message);
  }
}

/* ---- Step 3: result ----------------------------------------------------- */

function renderResult(result, automatic) {
  showView('result');
  window.scrollTo({ top: 0 });

  document.querySelector('#result-name').textContent = result.participantName;
  document.querySelector('#result-score').textContent = `${result.score} / ${result.maxScore}`;
  document.querySelector('#result-detail').textContent = result.quizTitle;
  document.querySelector('#result-correct').textContent =
    `${result.correctCount}/${result.questionCount}`;
  document.querySelector('#result-time').textContent = formatDuration(result.durationMs);
  document.querySelector('#result-percent').textContent =
    `${result.maxScore ? Math.round((result.score / result.maxScore) * 100) : 0}%`;

  const note = document.querySelector('#result-note');
  if (result.endedReason === 'left_quiz') {
    note.textContent =
      'Your attempt was ended because you left the quiz. Only the answers you had already given were counted.';
    note.className = 'notice notice--error';
    note.hidden = false;
  } else if (result.timedOut || automatic) {
    note.textContent = 'Time ran out, so your answers were submitted automatically.';
    note.className = 'notice notice--info';
    note.hidden = false;
  }

}

/* ---- Boot --------------------------------------------------------------- */

// Warn before an accidental refresh mid-attempt.
window.addEventListener('beforeunload', (event) => {
  if (state.attemptId && !state.submitting && !state.endedByLeaving) event.preventDefault();
});

loadIntro();
