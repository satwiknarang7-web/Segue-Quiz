import {
  api,
  clear,
  el,
  formatDateTime,
  formatDuration,
  formatTimeLimit,
  showError,
  toast,
} from './api.js';

const quizId = window.location.pathname.split('/').filter(Boolean)[1];
const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];
const REFRESH_INTERVAL_MS = 8_000;

// Whether to offer mark suggestions at all. Without a key the button would be
// a promise the server cannot keep, so it is not shown.
let aiAvailable = false;

const pageError = document.querySelector('#page-error');
const body = document.querySelector('#leaderboard-body');
const emptyState = document.querySelector('#leaderboard-empty');
const autoRefresh = document.querySelector('#auto-refresh');
const search = document.querySelector('#leaderboard-search');
const searchSummary = document.querySelector('#search-summary');

document.querySelector('#edit-link').href = `/quizzes/${quizId}`;
document.querySelector('#csv-link').href = `/api/quizzes/${quizId}/results.csv`;

let refreshTimer = null;

function renderStats({ quiz, stats }) {
  document.querySelector('#quiz-title').textContent = quiz.title;
  document.title = `${quiz.title} results · SegueQuiz`;
  document.querySelector('#quiz-meta').textContent = [
    quiz.isPublished ? 'Open for taking' : 'Draft — not open',
    `${quiz.questionCount} question${quiz.questionCount === 1 ? '' : 's'}`,
    `${quiz.totalPoints} points`,
    formatTimeLimit(quiz.timeLimitSeconds),
  ].join(' · ');

  const tiles = [
    ['Submitted', String(stats.submittedCount)],
    ['In progress', String(stats.inProgressCount)],
    ['Top score', `${stats.topScore}/${quiz.totalPoints}`],
    ['Average score', `${stats.averageScore}`],
    ['Average time', formatDuration(stats.averageDurationMs)],
  ];

  // Only worth a tile when there is something outstanding: on a quiz with no
  // drawn questions it would be a permanent zero.
  if (stats.awaitingMarkingCount > 0) {
    tiles.push(['Awaiting marking', String(stats.awaitingMarkingCount)]);
  }

  clear(document.querySelector('#stats')).append(
    ...tiles.map(([label, value]) =>
      el('div', { class: 'stat' }, [
        el('div', { class: 'stat__value', text: value }),
        el('div', { class: 'stat__label', text: label }),
      ]),
    ),
  );
}

function renderLeaderboard(allEntries) {
  clear(body);
  clear(emptyState);

  const term = search.value.trim().toLowerCase();
  const entries = term
    ? allEntries.filter((entry) => entry.participantName.toLowerCase().includes(term))
    : allEntries;

  searchSummary.textContent = term
    ? `${entries.length} of ${allEntries.length} shown`
    : '';

  if (allEntries.length === 0) {
    emptyState.append(
      el('div', { class: 'empty-state' }, [
        el('h3', { text: 'No submissions yet' }),
        el('p', { text: 'Results appear here as soon as somebody finishes the quiz.' }),
      ]),
    );
    return;
  }

  if (entries.length === 0) {
    emptyState.append(
      el('div', { class: 'empty-state' }, [
        el('h3', { text: 'Nobody matches that search' }),
        el('p', { text: `No participant name contains "${search.value.trim()}".` }),
      ]),
    );
    return;
  }

  entries.forEach((entry) => {
    body.append(
      el('tr', {}, [
        el('td', {}, [
          el('span', {
            class: `rank-medal${entry.rank <= 3 ? ` rank-medal--${entry.rank}` : ''}`,
            text: String(entry.rank),
          }),
        ]),
        el('td', {}, [
          el('div', { class: 'winner-name', text: entry.participantName }),
          entry.pendingMarkCount > 0
            ? el('span', { class: 'tie-note', text: 'Provisional — drawing not marked yet' })
            : null,
          entry.endedReason === 'left_quiz'
            ? el('span', { class: 'tie-note', text: 'Ended — left the quiz' })
            : entry.timedOut
              ? el('span', { class: 'tie-note', text: 'Ran out of time' })
              : null,
        ]),
        el('td', { class: 'numeric' }, [
          el('strong', { text: `${entry.score}` }),
          el('span', { class: 'meta', text: ` / ${entry.maxScore}` }),
          el('div', { class: 'tie-note', text: `${entry.percentage}%` }),
        ]),
        el('td', { class: 'numeric', text: `${entry.correctCount}/${entry.questionCount}` }),
        el('td', { class: 'numeric', text: formatDuration(entry.durationMs) }),
        el('td', { class: 'meta', text: formatDateTime(entry.submittedAt) }),
        el('td', {}, [
          el('button', {
            class: 'button button--ghost button--small',
            type: 'button',
            text: 'View',
            title: `See every answer ${entry.participantName} gave`,
            onClick: () => openReview(entry),
          }),
        ]),
        el('td', {}, [
          el('button', {
            class: 'button button--danger button--small',
            type: 'button',
            text: '×',
            title: `Remove ${entry.participantName}'s result so they can take the quiz again`,
            'aria-label': `Remove ${entry.participantName}'s result`,
            onClick: () => removeAttempt(entry),
          }),
        ]),
      ]),
    );
  });
}

const reviewDialog = document.querySelector('#review-dialog');
document.querySelector('#review-close').addEventListener('click', () => reviewDialog.close());

/** Open one participant's paper: every question, their pick, the right answer. */
async function openReview(entry) {
  try {
    const paper = await api.getAttemptReview(quizId, entry.attemptId);

    document.querySelector('#review-title').textContent = paper.participantName;
    document.querySelector('#review-summary').textContent = [
      `${paper.score}/${paper.maxScore} points`,
      `${paper.correctCount} of ${paper.questions.length} correct`,
      formatDuration(paper.durationMs),
      paper.endedReason === 'left_quiz'
        ? 'ended early - left the quiz'
        : paper.endedReason === 'timed_out'
          ? 'ran out of time'
          : 'submitted',
    ].join(' · ');

    const container = clear(document.querySelector('#review-questions'));

    paper.questions.forEach((question) => {
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

      container.append(
        el('div', { class: 'review-q' }, [
          el('div', { class: 'review-q__head' }, [
            el('span', { class: 'question__index meta', text: `Q${question.number}` }),
            el('span', { class: 'breakdown__text', text: question.text }),
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
          el('p', {
            class: 'tie-note',
            text: `${question.pointsAwarded} of ${question.points} point${question.points === 1 ? '' : 's'}`,
          }),
        ]),
      );
    });

    reviewDialog.showModal();
  } catch (error) {
    showError(pageError, error.message);
  }
}

/**
 * Removing one result is how a single person is let back in: the one-attempt
 * checks look for a submitted attempt, so deleting theirs frees them without
 * affecting anybody else on the board.
 */
async function removeAttempt(entry) {
  const confirmed = window.confirm(
    [
      `Remove ${entry.participantName}'s result?`,
      '',
      `Their score of ${entry.score}/${entry.maxScore} is deleted and cannot be recovered.`,
      'They will be able to take the quiz again; nobody else is affected.',
    ].join('\n'),
  );
  if (!confirmed) return;

  try {
    await api.deleteAttempt(quizId, entry.attemptId);
    toast(`Removed ${entry.participantName} — they can retake it now`);
    await refresh();
  } catch (error) {
    showError(pageError, error.message);
  }
}

let latest = null;

/**
 * Clearing is how the same quiz gets run with a second group, so the
 * confirmation has to be explicit: it also resets who has already taken it,
 * which is what lets everyone start again.
 */
document.querySelector('#clear-results').addEventListener('click', async () => {
  const submitted = latest?.stats?.submittedCount ?? 0;
  const running = latest?.stats?.inProgressCount ?? 0;

  if (submitted === 0 && running === 0) {
    toast('The leaderboard is already empty');
    return;
  }

  const lines = [
    `Clear the leaderboard for "${latest?.quiz?.title ?? 'this quiz'}"?`,
    '',
    `This deletes ${submitted} submitted attempt(s) and cannot be undone.`,
  ];
  if (running > 0) {
    lines.push(`${running} attempt(s) are still in progress and will be ended.`);
  }
  lines.push('', 'Everyone will be able to take the quiz again.');

  if (!window.confirm(lines.join('\n'))) return;

  const button = document.querySelector('#clear-results');
  button.disabled = true;

  try {
    const { removed } = await api.clearResults(quizId);
    toast(`Cleared ${removed} attempt(s)`);
    await refresh();
  } catch (error) {
    showError(pageError, error.message);
  } finally {
    button.disabled = false;
  }
});

function renderBreakdown(breakdown) {
  const container = clear(document.querySelector('#breakdown'));

  if (breakdown.length === 0) {
    container.append(el('p', { class: 'meta', text: 'This quiz has no questions yet.' }));
    return;
  }

  breakdown.forEach((question, index) => {
    if (question.type === 'short') {
      container.append(renderTypedBreakdown(question, index));
      return;
    }

    if (question.type === 'draw') {
      container.append(renderDrawnBreakdown(question, index));
      return;
    }

    const maxCount = Math.max(1, ...question.optionCounts);

    container.append(
      el('div', { class: 'breakdown__item' }, [
        el('div', { class: 'breakdown__head' }, [
          el('span', { class: 'question__index meta', text: `Q${index + 1}` }),
          el('span', { class: 'breakdown__text', text: question.text }),
          el('span', {
            class: 'badge',
            text: `${question.correctRate}% correct`,
          }),
        ]),
        ...question.options.map((option, optionIndex) => {
          const count = question.optionCounts[optionIndex];
          const isCorrect = optionIndex === question.correctIndex;
          return el('div', { class: `option-bar${isCorrect ? ' option-bar--correct' : ''}` }, [
            el('span', { class: 'option-bar__label', text: OPTION_LABELS[optionIndex] }),
            el('div', { class: 'option-bar__track' }, [
              el('div', {
                class: 'option-bar__fill',
                style: `width: ${(count / maxCount) * 100}%`,
              }),
            ]),
            el('span', { class: 'meta numeric', text: `${count}` }),
          ]);
        }),
        el('p', {
          class: 'tie-note',
          text: `${question.responseCount} answered · correct option: ${
            OPTION_LABELS[question.correctIndex]
          }. ${question.options[question.correctIndex]}`,
        }),
      ]),
    );
  });
}

/** The answer part of one person's reviewed question, which differs by type. */
function reviewAnswerRows(question) {
  if (question.type === 'draw') {
    const awarded = `${question.pointsAwarded} of ${question.points}`;
    const fromSuggestion = question.markSource === 'gemini' ? ' (from a suggestion)' : '';

    return [
      question.drawingUrl
        ? el('img', { class: 'review-figure', src: question.drawingUrl, alt: 'Their drawing' })
        : el('div', { class: 'review-opt', text: 'Nothing was drawn.' }),
      el('div', {
        class: 'meta',
        text: question.awaitingMarking ? 'Not marked yet.' : awarded + fromSuggestion,
      }),
      question.markNote ? el('div', { class: 'meta', text: question.markNote }) : null,
    ].filter(Boolean);
  }

  if (question.type !== 'short') {
    return question.options.map((option, index) =>
      el(
        'div',
        {
          class: 'review-opt',
          dataset: {
            correct: String(index === question.correctIndex),
            chosen: String(index === question.chosenIndex),
          },
        },
        [
          el('span', { text: `${OPTION_LABELS[index]}. ${option}` }),
          index === question.correctIndex
            ? el('span', { class: 'review-opt__tag', text: 'correct answer' })
            : null,
          index === question.chosenIndex && index !== question.correctIndex
            ? el('span', { class: 'review-opt__tag', text: 'their answer' })
            : null,
        ],
      ),
    );
  }

  return [
    el(
      'div',
      {
        class: 'review-opt',
        dataset: { correct: String(question.isCorrect), chosen: 'true' },
      },
      [
        el('span', { text: question.givenAnswer ?? '(nothing written)' }),
        el('span', { class: 'review-opt__tag', text: 'their answer' }),
      ],
    ),
    el(
      'div',
      { class: 'review-opt', dataset: { correct: 'true', chosen: 'false' } },
      [
        el('span', { text: (question.acceptedAnswers ?? []).join(' / ') }),
        el('span', { class: 'review-opt__tag', text: 'accepted' }),
      ],
    ),
  ];
}

/**
 * A typed question has no fixed options to chart, so the breakdown shows what
 * people actually wrote, commonest first. A wrong spelling appearing near the
 * top is usually the sign that an accepted answer is missing rather than that
 * a class got it wrong, which is the thing worth noticing here.
 */
function renderTypedBreakdown(question, index) {
  const given = question.givenAnswers ?? [];
  const maxCount = Math.max(1, ...given.map((entry) => entry.count));

  return el('div', { class: 'breakdown__item' }, [
    el('div', { class: 'breakdown__head' }, [
      el('span', { class: 'question__index meta', text: `Q${index + 1}` }),
      el('span', { class: 'breakdown__text', text: question.text }),
      el('span', { class: 'badge', text: 'Typed' }),
      el('span', { class: 'badge', text: `${question.correctRate}% correct` }),
    ]),
    ...given.map((entry) =>
      el('div', { class: `option-bar${entry.isCorrect ? ' option-bar--correct' : ''}` }, [
        el('span', { class: 'option-bar__label', text: entry.isCorrect ? '✓' : '✕' }),
        // The written answer takes the place the option letter holds above it,
        // so both kinds of breakdown read left to right the same way.
        el('span', { class: 'given-answer', title: entry.text, text: entry.text }),
        el('div', { class: 'option-bar__track' }, [
          el('div', {
            class: 'option-bar__fill',
            style: `width: ${(entry.count / maxCount) * 100}%`,
          }),
        ]),
        el('span', { class: 'meta numeric', text: `${entry.count}` }),
      ]),
    ),
    given.length === 0
      ? el('p', { class: 'meta', text: 'Nobody has answered this one yet.' })
      : null,
    el('p', {
      class: 'tie-note',
      text: `${question.responseCount} answered · accepted: ${(question.acceptedAnswers ?? []).join(', ')}`,
    }),
  ]);
}

async function refresh() {
  try {
    const data = await api.getResults(quizId);
    latest = data;
    pageError.hidden = true;

    renderStats(data);
    renderLeaderboard(data.entries);
    renderBreakdown(data.breakdown);
    await refreshMarking();
  } catch (error) {
    showError(pageError, error.message);
    stopAutoRefresh();
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = null;
}

search.addEventListener('input', () => {
  if (latest) renderLeaderboard(latest.entries);
});

autoRefresh.addEventListener('change', () => {
  if (autoRefresh.checked) startAutoRefresh();
  else stopAutoRefresh();
});

// Do not poll a tab nobody is looking at.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAutoRefresh();
  else if (autoRefresh.checked) {
    refresh();
    startAutoRefresh();
  }
});

refresh();
startAutoRefresh();

/* ---- Marking drawn answers ----------------------------------------------- */

const markingSection = document.querySelector('#marking-section');
const markingList = document.querySelector('#marking-list');
const markingError = document.querySelector('#marking-error');
const showDone = document.querySelector('#marking-show-done');

// Kept so that awarding a mark can redraw one row without refetching the page
// and losing whatever the teacher was part way through typing elsewhere.
let markingQueue = { items: [], remaining: 0, questions: [] };

showDone.addEventListener('change', renderMarking);

async function refreshMarking() {
  try {
    markingQueue = await api.getMarkingQueue(quizId);
  } catch {
    // A quiz with no drawn questions is the normal case; a failure here should
    // not take the rest of the results page down with it.
    markingQueue = { items: [], remaining: 0, questions: [] };
  }
  renderMarking();
}

function renderMarking() {
  markingSection.hidden = markingQueue.questions.length === 0;
  if (markingSection.hidden) return;

  const { remaining } = markingQueue;
  document.querySelector('#marking-remaining').textContent =
    remaining === 0 ? 'All marked' : `${remaining} to mark`;

  const items = showDone.checked
    ? markingQueue.items
    : markingQueue.items.filter((item) => !item.mark);

  const list = clear(markingList);

  if (items.length === 0) {
    list.append(
      el('p', {
        class: 'meta',
        text:
          markingQueue.items.length === 0
            ? 'Nobody has drawn an answer yet.'
            : 'Everything is marked. Tick the box above to see them again.',
      }),
    );
    return;
  }

  for (const item of items) list.append(renderMarkItem(item));
}

function renderMarkItem(item) {
  const pointsInput = el('input', {
    class: 'mark-points',
    type: 'number',
    min: '0',
    max: String(item.maxPoints),
    value: item.mark ? String(item.mark.points) : '',
    placeholder: `0-${item.maxPoints}`,
    'aria-label': `Points out of ${item.maxPoints}`,
  });

  const noteInput = el('input', {
    type: 'text',
    maxlength: '500',
    value: item.mark?.note ?? '',
    placeholder: 'A note for them (optional)',
    'aria-label': 'Note',
  });

  const suggestionBox = el('div', { class: 'stack stack--tight' });

  const award = async (source) => {
    const points = Number(pointsInput.value);
    if (!Number.isFinite(points) || pointsInput.value === '') {
      showError(markingError, 'Enter the points to award.');
      return;
    }

    try {
      await api.applyMark(quizId, item.attemptId, item.questionId, {
        points,
        note: noteInput.value,
        source,
      });
      markingError.hidden = true;
      toast(`Marked ${item.participantName}`);
      await refresh();
    } catch (error) {
      showError(markingError, error.message);
    }
  };

  const suggest = async (button) => {
    button.disabled = true;
    button.textContent = 'Looking…';

    try {
      const { suggestion } = await api.suggestMark(quizId, item.attemptId, item.questionId);
      markingError.hidden = true;

      // Filled in, never awarded. The teacher still has to press the button,
      // so nothing is recorded that a person has not looked at.
      pointsInput.value = String(suggestion.points);

      clear(suggestionBox).append(
        el('div', { class: 'mark-suggestion' }, [
          el('strong', { text: `Suggested: ${suggestion.points} of ${item.maxPoints}` }),
          el('span', { text: suggestion.reason }),
          el('span', {
            class: 'meta',
            text: 'A suggestion from Gemini. Check the drawing yourself before awarding it.',
          }),
        ]),
      );
    } catch (error) {
      showError(markingError, error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Suggest a mark';
    }
  };

  const suggestButton = el('button', {
    class: 'button button--ghost button--small',
    type: 'button',
    text: 'Suggest a mark',
    onClick: () => suggest(suggestButton),
  });

  return el('div', { class: 'mark-item', dataset: { marked: String(Boolean(item.mark)) } }, [
    el('div', { class: 'row' }, [
      el('span', { class: 'winner-name', text: item.participantName }),
      el('span', { class: 'meta', text: `Q${item.questionNumber} · ${item.questionText}` }),
      el('span', { class: 'spacer' }),
      el('span', {
        class: 'badge',
        text: item.mark ? `${item.mark.points} / ${item.maxPoints}` : `out of ${item.maxPoints}`,
      }),
    ]),

    el('img', { class: 'mark-drawing', src: item.drawingUrl, alt: `Drawing by ${item.participantName}`, loading: 'lazy' }),

    suggestionBox,

    el('div', { class: 'row' }, [
      pointsInput,
      noteInput,
      aiAvailable ? suggestButton : null,
      el('button', {
        class: 'button button--small',
        type: 'button',
        text: item.mark ? 'Update mark' : 'Award marks',
        onClick: () => award('teacher'),
      }),
      item.mark
        ? el('button', {
            class: 'button button--ghost button--small',
            type: 'button',
            text: 'Unmark',
            onClick: async () => {
              try {
                await api.clearMark(quizId, item.attemptId, item.questionId);
                await refresh();
              } catch (error) {
                showError(markingError, error.message);
              }
            },
          })
        : null,
    ]),
  ]);
}

api
  .aiStatus()
  .then(({ available }) => {
    aiAvailable = available;
    renderMarking();
  })
  .catch(() => {
    // Leaving it off is the safe default: marking works without suggestions.
  });

/**
 * A drawn question has nothing to chart until a person has marked it, so the
 * breakdown reports the marking rather than the answers.
 */
function renderDrawnBreakdown(question, index) {
  const waiting = question.awaitingMarkingCount ?? 0;

  return el('div', { class: 'breakdown__item' }, [
    el('div', { class: 'breakdown__head' }, [
      el('span', { class: 'question__index meta', text: `Q${index + 1}` }),
      el('span', { class: 'breakdown__text', text: question.text }),
      el('span', { class: 'badge', text: 'Drawn' }),
      el('span', {
        class: 'badge',
        text: waiting > 0 ? `${waiting} to mark` : 'All marked',
      }),
    ]),
    el('p', {
      class: 'tie-note',
      text: [
        `${question.responseCount} drawn`,
        `${question.markedCount ?? 0} marked`,
        question.markedCount
          ? `average ${question.averageMark} of ${question.maxPoints}`
          : 'nothing marked yet',
      ].join(' · '),
    }),
  ]);
}
