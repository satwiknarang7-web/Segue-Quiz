import { config } from '../config.js';
import { badRequest, conflict, gone, notFound } from '../lib/errors.js';
import { createId } from '../lib/ids.js';
import { toOriginalOption } from '../lib/shuffle.js';
import {
  awardFor,
  hasOptions,
  isAnswered,
  needsMarking,
  normaliseAnswerText,
  reviewRow,
} from '../lib/questionTypes.js';
import { asInteger, asString } from '../lib/validate.js';
import { isOwnMediaUrl } from '../lib/questionTypes.js';
import { attemptRepository } from '../repositories/attemptRepository.js';
import { storeUploadedImage } from '../store/mediaStore.js';
import { quizService } from './quizService.js';

const { limits, submitGraceMs } = config;

const normaliseName = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Grade a set of answers.
 *
 * Everything that can be marked by comparison is. A drawing cannot be, so it
 * counts towards pendingMarkCount instead, and the score is what is earned so
 * far rather than a final one. Nothing here waits for a person: an attempt is
 * always submitted with a score, it is just not necessarily the last word.
 */
function grade(quiz, answers, marks = {}) {
  let score = 0;
  let correctCount = 0;
  let pendingMarkCount = 0;

  for (const question of quiz.questions) {
    const answer = answers[question.id];
    const award = awardFor(question, answer, marks[question.id]);

    score += award.points;
    if (award.pending) pendingMarkCount += 1;
    if (!award.pending && award.points === question.points && isAnswered(question, answer)) {
      correctCount += 1;
    }
  }

  return {
    score,
    correctCount,
    pendingMarkCount,
    maxScore: quizService.totalPoints(quiz),
    answeredCount: Object.keys(answers).length,
  };
}

/**
 * Read one submitted answer into the form it is stored in, or null for "not
 * answered". Throws if the value is the wrong shape for the question's type.
 *
 * A blank typed answer is not an answer: it is stored as absent, so that
 * clearing a text box leaves the same state as never having touched it.
 */
function readAnswer(quiz, question, value, attemptId) {
  if (value === null || value === undefined) return null;

  if (needsMarking(question)) {
    // A drawing is stored as the image it was saved to. Only an image this
    // application stored counts, so a submission cannot point the marking
    // screen at somebody else's URL.
    const url = String(value);
    if (!isOwnMediaUrl(url, { supabaseUrl: config.supabase.url })) return null;
    return url;
  }

  if (!hasOptions(question)) {
    const text = asString(value, 'answer', { max: config.limits.shortAnswerMaxLength, min: 0 });
    return normaliseAnswerText(text) === '' ? null : text;
  }

  const displayed = asInteger(value, 'answer', { min: 0, max: question.options.length - 1 });
  // Store against the answer key's order, never the order it was shown in.
  return toOriginalOption(quiz, attemptId, question, displayed);
}

/** Only accept answers for questions that exist, in a shape that type allows. */
function sanitiseAnswers(quiz, rawAnswers, attemptId = null) {
  if (rawAnswers === undefined || rawAnswers === null) return {};
  if (typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) {
    throw badRequest('"answers" must be an object of questionId to answer.');
  }

  const answers = {};
  for (const [questionId, value] of Object.entries(rawAnswers)) {
    const question = quiz.questions.find((candidate) => candidate.id === questionId);
    if (!question) continue; // silently drop stale questions rather than failing a submission
    const answer = readAnswer(quiz, question, value, attemptId);
    if (answer !== null) answers[questionId] = answer;
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
  const result = grade(quiz, attempt.answers, attempt.marks ?? {});
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
  const marks = attempt.marks ?? {};
  return quiz.questions.map((question, index) =>
    reviewRow(question, index, attempt.answers[question.id], marks[question.id]),
  );
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
      marks: {},
      score: 0,
      correctCount: 0,
      pendingMarkCount: 0,
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
  /**
   * Store a drawing and record it as the answer.
   *
   * The image goes to the media store and the attempt keeps only its URL. Put
   * inline, a class's drawings would sit in the attempts record - which is held
   * in memory in full - and the leaderboard would drag every one of them into
   * every read.
   */
  async saveDrawing(attemptId, payload = {}) {
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
    if (!needsMarking(question)) throw badRequest('That question is not answered by drawing.');

    const { url } = await storeUploadedImage(payload);

    const updated = attemptRepository.update(attempt.id, (current) => ({
      ...current,
      answers: { ...current.answers, [questionId]: url },
    }));

    return { url, answers: updated.answers };
  },

  /**
   * Record a person's decision on one drawing, and re-grade the attempt.
   *
   * The score is stored rather than computed on read because the leaderboard
   * sorts on it, and a sort that recomputed every attempt's marks on every
   * refresh would do that work for a whole class each time.
   */
  applyMark(attemptId, questionId, { points, note = '', source = 'teacher' } = {}) {
    const attempt = attemptRepository.findById(attemptId);
    if (!attempt) throw notFound('That attempt does not exist.');
    if (attempt.status !== 'submitted') {
      throw badRequest('That attempt has not been submitted yet.');
    }

    const quiz = quizService.requireQuiz(attempt.quizId);
    const question = quiz.questions.find((candidate) => candidate.id === questionId);
    if (!question) throw notFound('That question does not exist.');
    if (!needsMarking(question)) throw badRequest('That question is marked automatically.');

    const awarded = asInteger(points, 'points', { min: 0, max: question.points });

    const marks = {
      ...(attempt.marks ?? {}),
      [questionId]: {
        points: awarded,
        note: String(note ?? '').slice(0, 500),
        // Recorded so a mark a person actually looked at is distinguishable
        // from one that was accepted wholesale.
        source: source === 'gemini' ? 'gemini' : 'teacher',
        markedAt: new Date().toISOString(),
      },
    };

    return attemptRepository.update(attempt.id, (current) => ({
      ...current,
      marks,
      ...grade(quiz, current.answers, marks),
    }));
  },

  /**
   * One attempt, checked to belong to the quiz asking for it.
   *
   * The quiz id is not decoration: without it, holding any attempt id would
   * reach an attempt on somebody else's quiz through an owner's own session.
   */
  rawAttempt(attemptId, quizId) {
    const attempt = attemptRepository.findById(attemptId);
    if (!attempt || attempt.quizId !== quizId) throw notFound('That attempt does not exist.');
    return attempt;
  },

  /** Undo a mark, putting the drawing back in the queue. */
  clearMark(attemptId, questionId) {
    const attempt = attemptRepository.findById(attemptId);
    if (!attempt) throw notFound('That attempt does not exist.');

    const quiz = quizService.requireQuiz(attempt.quizId);
    const marks = { ...(attempt.marks ?? {}) };
    delete marks[questionId];

    return attemptRepository.update(attempt.id, (current) => ({
      ...current,
      marks,
      ...grade(quiz, current.answers, marks),
    }));
  },

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

    // "optionIndex" is what clients sent before typed answers existed. Still
    // read, so an attempt already open during a deploy keeps autosaving.
    const submitted = payload.answer !== undefined ? payload.answer : payload.optionIndex;
    const answer = readAnswer(quiz, question, submitted, attempt.id);

    const answers = { ...attempt.answers };
    if (answer === null) {
      delete answers[questionId];
    } else {
      answers[questionId] = answer;
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
      // A taker is told their score is not the last word, so a low number on
      // the screen does not read as a mark they have already been given.
      pendingMarkCount: attempt.pendingMarkCount ?? 0,
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
