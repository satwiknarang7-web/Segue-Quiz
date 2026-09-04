import { createStore } from '../store/index.js';

const toRow = (attempt) => ({
  id: attempt.id,
  quiz_id: attempt.quizId,
  participant_name: attempt.participantName,
  participant_key: attempt.participantKey,
  device_id: attempt.deviceId ?? null,
  status: attempt.status,
  started_at: attempt.startedAt,
  deadline_at: attempt.deadlineAt,
  submitted_at: attempt.submittedAt ?? null,
  duration_ms: attempt.durationMs ?? null,
  timed_out: Boolean(attempt.timedOut),
  ended_reason: attempt.endedReason ?? null,
  answers: attempt.answers ?? {},
  marks: attempt.marks ?? {},
  score: attempt.score ?? 0,
  correct_count: attempt.correctCount ?? 0,
  max_score: attempt.maxScore ?? 0,
  answered_count: attempt.answeredCount ?? 0,
  pending_mark_count: attempt.pendingMarkCount ?? 0,
});

const asIso = (value) => (value ? new Date(value).toISOString() : null);

const fromRow = (row) => ({
  id: row.id,
  quizId: row.quiz_id,
  participantName: row.participant_name,
  participantKey: row.participant_key,
  deviceId: row.device_id ?? null,
  status: row.status,
  startedAt: asIso(row.started_at),
  deadlineAt: asIso(row.deadline_at),
  submittedAt: asIso(row.submitted_at),
  durationMs: row.duration_ms,
  timedOut: row.timed_out,
  endedReason: row.ended_reason,
  answers: row.answers ?? {},
  marks: row.marks ?? {},
  score: row.score,
  correctCount: row.correct_count,
  maxScore: row.max_score,
  answeredCount: row.answered_count,
  pendingMarkCount: row.pending_mark_count ?? 0,
});

const store = createStore({
  file: 'attempts.json',
  table: 'attempts',
  toRow,
  fromRow,
  // Added by 0002_attempt_device.sql and 0005_marking.sql. Checked at start-up
  // so a database that predates a migration fails there, rather than when
  // somebody is halfway through marking a class.
  requiredColumns: ['id', 'device_id', 'marks', 'pending_mark_count'],
});

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

  /** Any finished attempt from this browser, whatever name was typed. */
  findSubmittedByDevice(quizId, deviceId) {
    if (!deviceId) return null;
    return store.find(
      (attempt) =>
        attempt.quizId === quizId &&
        attempt.status === 'submitted' &&
        attempt.deviceId === deviceId,
    );
  },

  /** An attempt this browser still has running, whatever name was typed. */
  findInProgressByDevice(quizId, deviceId) {
    if (!deviceId) return null;
    return store.find(
      (attempt) =>
        attempt.quizId === quizId &&
        attempt.status === 'in_progress' &&
        attempt.deviceId === deviceId,
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

  remove(id) {
    return store.remove(id);
  },

  removeByQuiz(quizId) {
    return store.removeWhere((attempt) => attempt.quizId === quizId);
  },

  flushed() {
    return store.flushed();
  },
};
