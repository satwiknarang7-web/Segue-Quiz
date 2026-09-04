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
  // Strokes are kept per question so moving between questions and back does
  // not lose a drawing. They are points, not pixels, so undo can rebuild the
  // picture without keeping a stack of images.
  strokes: {},
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
  renderQuestionImage(question);

  updateProgress();

  const optionList = clear(document.querySelector('#option-list'));

  if (question.type === 'short') {
    optionList.append(buildShortAnswer(question));
    finishQuestionRender(total);
    return;
  }

  if (question.type === 'draw') {
    optionList.append(buildDrawingPad(question));
    finishQuestionRender(total);
    return;
  }

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

  finishQuestionRender(total);
}

/** The parts of the question screen that are the same whatever the type is. */
function finishQuestionRender(total) {
  const onLastQuestion = state.index === total - 1;
  document.querySelector('#previous-button').disabled = state.index === 0;
  document.querySelector('#next-button').disabled = onLastQuestion;

  // Submit sits next to Next the whole way through, so give it the weight of
  // the primary action only once there is nothing left to answer. Before that
  // it is still reachable, just not the thing the eye lands on.
  const submitButton = document.querySelector('#submit-button');
  submitButton.className = onLastQuestion ? 'button' : 'button button--ghost';

  renderNavigator();
}

/** The diagram a question is asked about, if it has one. */
function renderQuestionImage(question) {
  const figure = document.querySelector('#question-figure');

  if (!question.imageUrl) {
    figure.hidden = true;
    figure.removeAttribute('src');
    return;
  }

  figure.src = question.imageUrl;
  figure.alt = question.imageAlt || '';
  figure.hidden = false;
}

/** Progress and the navigator, without rebuilding the answer area. */
function updateProgress() {
  const total = state.quiz.questions.length;
  const answered = Object.keys(state.answers).length;
  document.querySelector('#progress-fill').style.width = `${(answered / total) * 100}%`;
  document.querySelector('#progress-label').textContent = `${answered}/${total}`;
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

/**
 * A typed answer, which cannot re-render the question on each keystroke the
 * way clicking an option does - that would take the focus and the caret with
 * it. So the box owns its own value and only nudges the progress display.
 *
 * Saving is debounced, because a keystroke is not a decision. It is a safety
 * net in any case: submitting sends the whole answer set, so nothing typed is
 * lost even if the last autosave never went out.
 */
function buildShortAnswer(question) {
  let timer;

  const input = el('input', {
    class: 'short-answer',
    type: 'text',
    value: state.answers[question.id] ?? '',
    maxlength: '200',
    placeholder: 'Type your answer',
    'aria-label': 'Your answer',
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'done',
  });

  const store = () => {
    const value = input.value.trim();
    if (value === '') delete state.answers[question.id];
    else state.answers[question.id] = value;
    updateProgress();
  };

  input.addEventListener('input', () => {
    store();
    clearTimeout(timer);
    timer = setTimeout(() => saveAnswer(question, state.answers[question.id] ?? null), 700);
  });

  // Leaving the box is a decision, so it should not have to wait out the timer.
  input.addEventListener('blur', () => {
    clearTimeout(timer);
    store();
    saveAnswer(question, state.answers[question.id] ?? null);
  });

  // Enter would otherwise do nothing visible on a phone keyboard.
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
    }
  });

  return input;
}

async function selectOption(question, optionIndex) {
  state.answers[question.id] = optionIndex;
  renderQuestion();
  await saveAnswer(question, optionIndex);
}

/** Autosave, so a dropped connection or a closed tab does not lose answers. */
async function saveAnswer(question, answer) {
  try {
    await api.saveAnswer(state.attemptId, question.id, answer);
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

/**
 * Shows the taker their own paper, but only when the quiz reveals answers.
 * The server withholds `review` entirely otherwise, so there is nothing to
 * find in the response either way.
 */
function renderOwnReview(result) {
  const section = document.querySelector('#result-review');
  const locked = document.querySelector('#result-locked');

  if (!Array.isArray(result.review)) {
    section.hidden = true;
    locked.hidden = false;
    return;
  }

  locked.hidden = true;
  const list = clear(document.querySelector('#result-review-list'));

  for (const question of result.review) {
    // A drawing nobody has marked yet is neither right nor wrong, and showing
    // it as wrong would be a lie the taker cannot check.
    const state = question.awaitingMarking
      ? 'pending'
      : question.givenAnswer === null
        ? 'blank'
        : question.isCorrect
          ? 'correct'
          : 'wrong';
    const verdict = {
      correct: 'Correct',
      wrong: 'Wrong',
      blank: 'Not answered',
      pending: 'To be marked',
    }[state];

    list.append(
      el('div', { class: 'review-q' }, [
        el('div', { class: 'review-q__head' }, [
          el('span', { class: 'meta', text: `Q${question.number}` }),
          el('span', { text: question.text }),
          el('span', { class: 'review-q__verdict', dataset: { state }, text: verdict }),
        ]),
        question.imageUrl
          ? el('img', {
              class: 'review-figure',
              src: question.imageUrl,
              alt: question.imageAlt || '',
              loading: 'lazy',
            })
          : null,
        ...reviewAnswerRows(question),
      ]),
    );
  }

  section.hidden = false;
}

/** The answer part of one reviewed question, which differs by type. */
function reviewAnswerRows(question) {
  if (question.type === 'draw') {
    const rows = [
      question.drawingUrl
        ? el('img', { class: 'review-figure', src: question.drawingUrl, alt: 'Your drawing' })
        : el('div', { class: 'review-opt', text: 'You did not draw anything.' }),
      el('div', {
        class: 'meta',
        text: question.awaitingMarking
          ? 'Waiting to be marked by the quiz host.'
          : `Marked ${question.pointsAwarded} of ${question.points}.`,
      }),
    ];

    if (question.markNote) rows.push(el('div', { class: 'meta', text: question.markNote }));
    return rows;
  }

  if (question.type !== 'short') {
    return question.options.map((option, index) =>
      el('div', {
        class: 'review-opt',
        dataset: {
          correct: String(index === question.correctIndex),
          chosen: String(index === question.chosenIndex),
        },
        text: [
          `${OPTION_LABELS[index]}. ${option}`,
          index === question.correctIndex ? '  (correct answer)' : '',
          index === question.chosenIndex && index !== question.correctIndex ? '  (your answer)' : '',
        ].join(''),
      }),
    );
  }

  const rows = [
    el('div', {
      class: 'review-opt',
      dataset: { correct: String(question.isCorrect), chosen: 'true' },
      text: `You wrote: ${question.givenAnswer ?? '(nothing)'}`,
    }),
  ];

  if (question.isCorrect) return rows;

  rows.push(
    el('div', {
      class: 'review-opt',
      dataset: { correct: 'true', chosen: 'false' },
      text: `Answer: ${question.correctAnswer}`,
    }),
  );

  // Seeing the other spellings that would have passed is what tells a taker
  // whether they were wrong or just unlucky in how they wrote it.
  const others = (question.acceptedAnswers ?? []).slice(1);
  if (others.length > 0) {
    rows.push(el('div', { class: 'meta', text: `Also accepted: ${others.join(', ')}` }));
  }

  return rows;
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

  renderOwnReview(result);

  // Say so before the score is read as final. A drawing has to be looked at by
  // a person, and until then the number on the screen counts it as zero.
  const pending = document.querySelector('#result-pending');
  if (pending) {
    const count = result.pendingMarkCount ?? 0;
    pending.textContent =
      count === 1
        ? 'One of your answers is a drawing, which the quiz host still has to mark. Your score will go up once they have.'
        : `${count} of your answers are drawings, which the quiz host still has to mark. Your score will go up once they have.`;
    pending.hidden = count === 0;
  }

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

/* ---- Drawn answers ------------------------------------------------------- */

// The canvas is a fixed size whatever the screen is, so a drawing made on a
// phone and one made on a laptop arrive at the same resolution and the teacher
// marking them sees the same thing.
const PAD_WIDTH = 1000;
const PAD_HEIGHT = 700;

/**
 * A sketch pad for one question.
 *
 * What is saved is the picture, but what is kept while drawing is the strokes,
 * because undo needs to rebuild the image rather than step back through copies
 * of it. Saving is debounced and happens after a stroke ends: mid-stroke is
 * never a finished thought, and a phone drawing a long curve would otherwise
 * post continuously.
 */
function buildDrawingPad(question) {
  const strokes = (state.strokes[question.id] ??= []);
  let saveTimer;
  let resumed = null;

  const canvas = el('canvas', {
    class: 'pad__canvas',
    width: String(PAD_WIDTH),
    height: String(PAD_HEIGHT),
    'aria-label': 'Drawing area',
  });
  const context = canvas.getContext('2d');

  const redraw = () => {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, PAD_WIDTH, PAD_HEIGHT);

    // Anything drawn before a reload comes back as a picture underneath, so a
    // dropped connection does not cost the work already done.
    if (resumed) context.drawImage(resumed, 0, 0, PAD_WIDTH, PAD_HEIGHT);

    context.strokeStyle = '#101828';
    context.lineWidth = 4;
    context.lineCap = 'round';
    context.lineJoin = 'round';

    for (const stroke of strokes) {
      if (stroke.length === 0) continue;
      context.beginPath();
      context.moveTo(stroke[0].x, stroke[0].y);
      for (const point of stroke.slice(1)) context.lineTo(point.x, point.y);
      // A single tap is a dot, which lineTo alone would not draw.
      if (stroke.length === 1) context.lineTo(stroke[0].x + 0.1, stroke[0].y);
      context.stroke();
    }
  };

  // Restore a drawing saved earlier in this attempt.
  const savedUrl = state.answers[question.id];
  if (typeof savedUrl === 'string' && savedUrl !== '' && strokes.length === 0) {
    const image = new Image();
    image.onload = () => {
      resumed = image;
      redraw();
    };
    image.src = savedUrl;
  }

  /** Where a pointer is, in the canvas's own coordinates rather than the screen's. */
  const pointAt = (event) => {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * PAD_WIDTH,
      y: ((event.clientY - bounds.top) / bounds.height) * PAD_HEIGHT,
    };
  };

  let drawing = false;

  canvas.addEventListener('pointerdown', (event) => {
    drawing = true;
    canvas.setPointerCapture(event.pointerId);
    strokes.push([pointAt(event)]);
    redraw();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!drawing) return;
    strokes[strokes.length - 1].push(pointAt(event));
    redraw();
  });

  const endStroke = () => {
    if (!drawing) return;
    drawing = false;
    updateAnswered();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDrawing, 800);
  };

  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', endStroke);

  /**
   * A drawing counts as answered as soon as there is one, so the progress
   * bar and the navigator do not have to wait for a round trip to agree with
   * what is on the screen.
   */
  function updateAnswered() {
    const hasContent = strokes.length > 0 || resumed !== null;
    if (hasContent) state.answers[question.id] ??= 'pending';
    else delete state.answers[question.id];
    updateProgress();
  }

  async function saveDrawing() {
    try {
      const dataUrl = canvas.toDataURL('image/png');
      const { url } = await api.saveDrawing(state.attemptId, question.id, dataUrl);
      state.answers[question.id] = url;
      pageError.hidden = true;
    } catch (error) {
      if (error.status === 410) {
        clearInterval(state.ticker);
        await submit({ automatic: true });
        return;
      }
      showError(pageError, `Could not save that drawing: ${error.message}`);
    }
  }

  const undo = el('button', {
    class: 'button button--ghost button--small',
    type: 'button',
    text: 'Undo',
    onClick: () => {
      strokes.pop();
      redraw();
      updateAnswered();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveDrawing, 400);
    },
  });

  const clearAll = el('button', {
    class: 'button button--ghost button--small',
    type: 'button',
    text: 'Start again',
    onClick: () => {
      strokes.length = 0;
      resumed = null;
      redraw();
      updateAnswered();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveDrawing, 400);
    },
  });

  redraw();

  return el('div', { class: 'pad' }, [
    canvas,
    el('div', { class: 'row' }, [
      el('span', { class: 'meta', text: 'Draw your answer above.' }),
      el('span', { class: 'spacer' }),
      undo,
      clearAll,
    ]),
  ]);
}
