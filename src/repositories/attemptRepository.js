import { createStore } from '../store/index.js';

const toRow = (attempt) => ({
  id: attempt.id,
  quiz_id: attempt.quizId,
  participant_name: attempt.participantName,
  participant_key: attempt.participantKey,
  status: attempt.status,
  started_at: attempt.startedAt,
  deadline_at: attempt.deadlineAt,
  submitted_at: attempt.submittedAt ?? null,
  duration_ms: attempt.durationMs ?? null,
  timed_out: Boolean(attempt.timedOut),
  ended_reason: attempt.endedReason ?? null,
  answers: attempt.answers ?? {},
  score: attempt.score ?? 0,
  correct_count: attempt.correctCount ?? 0,
  max_score: attempt.maxScore ?? 0,
  answered_count: attempt.answeredCount ?? 0,
});

const asIso = (value) => (value ? new Date(value).toISOString() : null);

const fromRow = (row) => ({
  id: row.id,
  quizId: row.quiz_id,
  participantName: row.participant_name,
  participantKey: row.participant_key,
  status: row.status,
  startedAt: asIso(row.started_at),
  deadlineAt: asIso(row.deadline_at),
  submittedAt: asIso(row.submitted_at),
  durationMs: row.duration_ms,
  timedOut: row.timed_out,
  endedReason: row.ended_reason,
  answers: row.answers ?? {},
  score: row.score,
  correctCount: row.correct_count,
  maxScore: row.max_score,
  answeredCount: row.answered_count,
});

const store = createStore({ file: 'attempts.json', table: 'attempts', toRow, fromRow });

export const attemptRepository = {
  findById(id) {
    return store.findById(id);
  },

  listByQuiz(quizId) {
    return store.filter((attempt) => attempt.quizId === quizId);
  },

  listSubmittedByQuiz(quizId) {
    return store.filter((attempt) => attempt.quizId === quizId && attempt.status === 'submitted');
  },

  countByQuiz(quizId) {
    return store.filter((attempt) => attempt.quizId === quizId).length;
  },

  findSubmittedByParticipant(quizId, normalisedName) {
    return store.find(
      (attempt) =>
        attempt.quizId === quizId &&
        attempt.status === 'submitted' &&
        attempt.participantKey === normalisedName,
    );
  },

  findInProgressByParticipant(quizId, normalisedName) {
    return store.find(
      (attempt) =>
        attempt.quizId === quizId &&
        attempt.status === 'in_progress' &&
        attempt.participantKey === normalisedName,
    );
  },

  insert(attempt) {
    return store.insert(attempt);
  },

  update(id, updater) {
    return store.update(id, updater);
  },

  removeByQuiz(quizId) {
    return store.removeWhere((attempt) => attempt.quizId === quizId);
  },

  flushed() {
    return store.flushed();
  },
};
