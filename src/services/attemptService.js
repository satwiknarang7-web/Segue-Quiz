import { config } from '../config.js';
import { badRequest, conflict, gone, notFound } from '../lib/errors.js';
import { createId } from '../lib/ids.js';
import { toOriginalOption } from '../lib/shuffle.js';
import { asInteger, asString } from '../lib/validate.js';
import { attemptRepository } from '../repositories/attemptRepository.js';
import { quizService } from './quizService.js';

const { limits, submitGraceMs } = config;

const normaliseName = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** Grade a set of answers against the quiz's answer key. */
function grade(quiz, answers) {
  let score = 0;
  let correctCount = 0;

  for (const question of quiz.questions) {
    if (answers[question.id] === question.correctIndex) {
      score += question.points;
      correctCount += 1;
    }
  }

  return {
    score,
    correctCount,
    maxScore: quizService.totalPoints(quiz),
    answeredCount: Object.keys(answers).length,
  };
}

/** Only accept answers for questions that exist, with an in-range option. */
function sanitiseAnswers(quiz, rawAnswers, attemptId = null) {
  if (rawAnswers === undefined || rawAnswers === null) return {};
  if (typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) {
    throw badRequest('"answers" must be an object of questionId to option index.');
  }

  const answers = {};
  for (const [questionId, value] of Object.entries(rawAnswers)) {
    if (value === null || value === undefined) continue;
    const question = quiz.questions.find((candidate) => candidate.id === questionId);
    if (!question) continue; // silently drop stale questions rather than failing a submission
    const displayed = asInteger(value, 'answer', { min: 0, max: question.options.length - 1 });
    // Store against the answer key's order, never the order it was shown in.
    answers[questionId] = toOriginalOption(quiz, attemptId, question, displayed);
  }
  return answers;
}

/**
 * End an attempt for good.
 *
 * `reason` is one of:
 *   submitted  - the participant pressed submit
 *   timed_out  - the clock ran out, here or while they were away
 *   left_quiz  - they switched tab or app, and the quiz forbids that
 */
function finalise(attempt, quiz, { at = Date.now(), reason = 'submitted' } = {}) {
  const startedMs = Date.parse(attempt.startedAt);
  const limitMs = quiz.timeLimitSeconds * 1000;
  const elapsedMs = Math.max(0, at - startedMs);
  // Nobody can beat the clock by submitting late, so time is capped at the limit.
  const durationMs = Math.min(elapsedMs, limitMs);
  const result = grade(quiz, attempt.answers);
  const ranOut = elapsedMs > limitMs + submitGraceMs;
  const endedReason = reason === 'submitted' && ranOut ? 'timed_out' : reason;

  return attemptRepository.update(attempt.id, (current) => ({
    ...current,
    status: 'submitted',
    submittedAt: new Date(startedMs + durationMs).toISOString(),
    durationMs,
    timedOut: endedReason === 'timed_out',
    endedReason,
    ...result,
  }));
}

/** A taker's own paper: their pick against the answer key, question by question. */
function buildReview(quiz, attempt) {
  return quiz.questions.map((question, index) => {
    const chosen = attempt.answers[question.id];
    const answered = chosen !== undefined && chosen !== null;

    return {
      number: index + 1,
      text: question.text,
      options: question.options,
      correctIndex: question.correctIndex,
      chosenIndex: answered ? chosen : null,
      isCorrect: answered && chosen === question.correctIndex,
      points: question.points,
      pointsAwarded: answered && chosen === question.correctIndex ? question.points : 0,
    };
  });
}

/** Public shape of an attempt in progress - never leaks the answer key. */
function toAttemptState(attempt, quiz) {
  const remainingMs = Math.max(0, Date.parse(attempt.deadlineAt) - Date.now());
  return {
    attemptId: attempt.id,
    quizId: attempt.quizId,
    participantName: attempt.participantName,
    status: attempt.status,
    startedAt: attempt.startedAt,
    deadlineAt: attempt.deadlineAt,
    remainingMs,
    timeLimitSeconds: quiz.timeLimitSeconds,
    answers: attempt.answers,
  };
}

export const attemptService = {
  /** Auto-submit attempts whose timer ran out while the participant was away. */
  finaliseExpired(quizId) {
    const quiz = quizService.requireQuiz(quizId);
    const cutoff = Date.now() - submitGraceMs;

    for (const attempt of attemptRepository.listByQuiz(quiz.id)) {
      if (attempt.status !== 'in_progress') continue;
      if (Date.parse(attempt.deadlineAt) > cutoff) continue;
      finalise(attempt, quiz, { at: Date.parse(attempt.deadlineAt), reason: 'timed_out' });
    }
  },

  start(quizId, payload = {}, deviceId = null) {
    const quiz = quizService.requireQuiz(quizId);

    if (!quiz.isPublished) throw conflict('This quiz is not open yet.');
    if (quiz.questions.length === 0) throw conflict('This quiz has no questions yet.');

    const participantName = asString(payload.participantName, 'participantName', {
      max: limits.participantNameMaxLength,
    });
    const participantKey = normaliseName(participantName);

    attemptService.finaliseExpired(quiz.id);

    // A refresh must not hand out a fresh timer, and neither must retyping a
    // different name. Resume whatever this browser already has running before
    // any other check, so an attempt in flight is always continued.
    const running =
      attemptRepository.findInProgressByDevice(quiz.id, deviceId) ??
      attemptRepository.findInProgressByParticipant(quiz.id, participantKey);

    if (running) {
      return {
        attempt: toAttemptState(running, quiz),
        quiz: quizService.toParticipantView(quiz, running.id),
        resumed: true,
      };
    }

    if (!quiz.allowRetakes) {
      // Two independent checks. The name stops the same person signing in
      // again; the device stops them simply typing a different name.
      if (attemptRepository.findSubmittedByParticipant(quiz.id, participantKey)) {
        throw conflict(`"${participantName}" has already taken this quiz.`);
      }
      if (attemptRepository.findSubmittedByDevice(quiz.id, deviceId)) {
        throw conflict('This device has already taken the quiz. Each person gets one attempt.');
      }
    }

    const startedAt = new Date();
    const attempt = attemptRepository.insert({
      id: createId(),
      quizId: quiz.id,
      participantName,
      participantKey,
      deviceId,
      status: 'in_progress',
      startedAt: startedAt.toISOString(),
      deadlineAt: new Date(startedAt.getTime() + quiz.timeLimitSeconds * 1000).toISOString(),
      submittedAt: null,
      durationMs: null,
      timedOut: false,
      endedReason: null,
      answers: {},
      score: 0,
      correctCount: 0,
      maxScore: quizService.totalPoints(quiz),
      answeredCount: 0,
    });

    return {
      attempt: toAttemptState(attempt, quiz),
      quiz: quizService.toParticipantView(quiz, attempt.id),
    };
  },

  getState(attemptId) {
    const attempt = attemptRepository.findById(attemptId);
    if (!attempt) throw notFound('That attempt does not exist.');
    const quiz = quizService.requireQuiz(attempt.quizId);
    return toAttemptState(attempt, quiz);
  },

  /** Autosave a single answer so a closed tab does not lose the whole attempt. */
  saveAnswer(attemptId, payload = {}) {
    const attempt = attemptRepository.findById(attemptId);
    if (!attempt) throw notFound('That attempt does not exist.');
    if (attempt.status !== 'in_progress') throw gone('This attempt has already been submitted.');

    const quiz = quizService.requireQuiz(attempt.quizId);

    if (Date.now() > Date.parse(attempt.deadlineAt) + submitGraceMs) {
      finalise(attempt, quiz, { at: Date.parse(attempt.deadlineAt), reason: 'timed_out' });
      throw gone('Time is up - this attempt was submitted automatically.');
    }

    const questionId = asString(payload.questionId, 'questionId', { max: 100 });
    const question = quiz.questions.find((candidate) => candidate.id === questionId);
    if (!question) throw notFound('That question does not exist.');

    const answers = { ...attempt.answers };
    if (payload.optionIndex === null) {
      delete answers[questionId];
    } else {
      const displayed = asInteger(payload.optionIndex, 'optionIndex', {
        min: 0,
        max: question.options.length - 1,
      });
      // The participant clicked position N of what they were shown; translate
      // it to the answer key's order so scoring never sees the shuffle.
      answers[questionId] = toOriginalOption(quiz, attempt.id, question, displayed);
    }

    const updated = attemptRepository.update(attempt.id, (current) => ({ ...current, answers }));
    return toAttemptState(updated, quiz);
  },

  submit(attemptId, payload = {}) {
    const attempt = attemptRepository.findById(attemptId);
    if (!attempt) throw notFound('That attempt does not exist.');

    const quiz = quizService.requireQuiz(attempt.quizId);

    if (attempt.status === 'submitted') {
      // Submitting twice (e.g. the timer and the button race) returns the same result.
      return attemptService.toResult(attempt, quiz);
    }

    // Answers already saved are in the answer key's order; the ones arriving
    // with the submission are in the order this attempt was shown, so they
    // need the same translation saveAnswer applies.
    const answers = { ...attempt.answers, ...sanitiseAnswers(quiz, payload.answers, attempt.id) };
    const withAnswers = attemptRepository.update(attempt.id, (current) => ({ ...current, answers }));

    const deadlineMs = Date.parse(attempt.deadlineAt);
    const lateBy = Date.now() - deadlineMs;
    const finalised =
      lateBy > submitGraceMs
        ? finalise(withAnswers, quiz, { at: deadlineMs, reason: 'timed_out' })
        : finalise(withAnswers, quiz);

    return attemptService.toResult(finalised, quiz);
  },

  /**
   * The participant navigated away - switched tab, switched app, or locked the
   * phone - and this quiz does not allow that. Whatever they had answered is
   * scored, and the attempt is closed immediately.
   */
  abandon(attemptId) {
    const attempt = attemptRepository.findById(attemptId);
    if (!attempt) throw notFound('That attempt does not exist.');

    const quiz = quizService.requireQuiz(attempt.quizId);

    // Idempotent: a beacon and a later reload can both arrive.
    if (attempt.status === 'submitted') return attemptService.toResult(attempt, quiz);

    // Never credit more time than the clock allowed.
    const at = Math.min(Date.now(), Date.parse(attempt.deadlineAt));
    return attemptService.toResult(finalise(attempt, quiz, { at, reason: 'left_quiz' }), quiz);
  },

  /** What the participant sees after submitting. */
  toResult(attempt, quiz) {
    return {
      attemptId: attempt.id,
      quizId: attempt.quizId,
      quizTitle: quiz.title,
      participantName: attempt.participantName,
      score: attempt.score,
      maxScore: attempt.maxScore,
      correctCount: attempt.correctCount,
      questionCount: quiz.questions.length,
      answeredCount: attempt.answeredCount,
      durationMs: attempt.durationMs,
      timedOut: attempt.timedOut,
      endedReason: attempt.endedReason,
      submittedAt: attempt.submittedAt,
      // Only present when the quiz reveals answers. Withheld from the payload
      // entirely rather than hidden in the page, so a taker who opens the
      // network tab learns nothing the quiz did not choose to tell them.
      ...(quiz.revealAnswers ? { review: buildReview(quiz, attempt) } : {}),
    };
  },
};
