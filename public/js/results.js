import { api, clear, el, formatDateTime, formatDuration, formatTimeLimit, showError } from './api.js';

const quizId = window.location.pathname.split('/').filter(Boolean)[1];
const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];
const REFRESH_INTERVAL_MS = 8_000;

const pageError = document.querySelector('#page-error');
const body = document.querySelector('#leaderboard-body');
const emptyState = document.querySelector('#leaderboard-empty');
const autoRefresh = document.querySelector('#auto-refresh');

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

  clear(document.querySelector('#stats')).append(
    ...tiles.map(([label, value]) =>
      el('div', { class: 'stat' }, [
        el('div', { class: 'stat__value', text: value }),
        el('div', { class: 'stat__label', text: label }),
      ]),
    ),
  );
}

function renderLeaderboard(entries) {
  clear(body);
  clear(emptyState);

  if (entries.length === 0) {
    emptyState.append(
      el('div', { class: 'empty-state' }, [
        el('h3', { text: 'No submissions yet' }),
        el('p', { text: 'Results appear here as soon as somebody finishes the quiz.' }),
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
      ]),
    );
  });
}

function renderBreakdown(breakdown) {
  const container = clear(document.querySelector('#breakdown'));

  if (breakdown.length === 0) {
    container.append(el('p', { class: 'meta', text: 'This quiz has no questions yet.' }));
    return;
  }

  breakdown.forEach((question, index) => {
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

async function refresh() {
  try {
    const data = await api.getResults(quizId);
    pageError.hidden = true;

    renderStats(data);
    renderLeaderboard(data.entries);
    renderBreakdown(data.breakdown);
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
