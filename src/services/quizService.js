import { config } from '../config.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { createId, createJoinCode } from '../lib/ids.js';
import { asArray, asBoolean, asInteger, asOptionalString, asString } from '../lib/validate.js';
import {
  CHOICE,
  QUESTION_TYPES,
  SHORT,
  hasOptions,
  isOwnMediaUrl,
  normaliseAnswerText,
  typeOf as questionTypeOf,
} from '../lib/questionTypes.js';
import { parseBulkQuestions } from '../lib/parseQuestions.js';
import { optionOrder, questionOrder } from '../lib/shuffle.js';
import { attemptRepository } from '../repositories/attemptRepository.js';
import { quizRepository } from '../repositories/quizRepository.js';

const { limits } = config;

/** Quiz ids double as join codes, so they must be short, readable and unique. */
function generateQuizId() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = createJoinCode(6);
    if (!quizRepository.exists(candidate)) return candidate;
  }
  throw conflict('Could not allocate a unique join code. Please try again.');
}

/** Multiple choice: a list of options with exactly one of them marked. */
function parseChoiceQuestion(payload) {
  const rawOptions = asArray(payload.options, 'options', {
    min: limits.minOptions,
    max: limits.maxOptions,
  });
  const options = rawOptions.map((option, index) =>
    asString(option, `option ${index + 1}`, { max: limits.optionMaxLength }),
  );

  const deduplicated = new Set(options.map((option) => option.toLowerCase()));
  if (deduplicated.size !== options.length) {
    throw badRequest('Each answer option must be different.');
  }

  const correctIndex = asInteger(payload.correctIndex, 'correctIndex', {
    min: 0,
    max: options.length - 1,
  });

  return { options, correctIndex };
}

/**
 * Short answer: the taker types, and any of the accepted spellings earns the
 * marks. Duplicates are rejected using the same normalisation that grades, so
 * a teacher cannot list "15 N" and "15  n" and come away believing they have
 * covered two cases when they have covered one.
 */
function parseShortQuestion(payload) {
  const rawAnswers = asArray(payload.acceptedAnswers, 'acceptedAnswers', {
    min: 1,
    max: limits.maxAcceptedAnswers,
  });
  const acceptedAnswers = rawAnswers.map((answer, index) =>
    asString(answer, `accepted answer ${index + 1}`, { max: limits.shortAnswerMaxLength }),
  );

  const deduplicated = new Set(acceptedAnswers.map(normaliseAnswerText));
  if (deduplicated.size !== acceptedAnswers.length) {
    throw badRequest('Two accepted answers are the same once spacing and case are ignored.');
  }

  return { acceptedAnswers };
}

function parseQuestionPayload(payload = {}) {
  const text = asString(payload.text, 'question', { max: limits.questionMaxLength });

  // Absent means choice, so anything written before types existed still saves.
  const type = payload.type === undefined || payload.type === null ? CHOICE : payload.type;
  if (!QUESTION_TYPES.includes(type)) {
    throw badRequest(`"type" must be one of: ${QUESTION_TYPES.join(', ')}.`);
  }

  const points =
    payload.points === undefined || payload.points === null || payload.points === ''
      ? 1
      : asInteger(payload.points, 'points', { min: limits.minPoints, max: limits.maxPoints });

  const specific = type === SHORT ? parseShortQuestion(payload) : parseChoiceQuestion(payload);

  return { text, type, ...specific, ...parseQuestionImage(payload), points };
}

/**
 * The diagram shown with a question, if there is one.
 *
 * Only a URL this application produced is accepted. Anything else would let
 * whoever writes a quiz have every taker's browser fetch a resource we have
 * not seen, from a host we do not control.
 */
function parseQuestionImage(payload) {
  const url = payload.imageUrl;
  if (url === undefined || url === null || url === '') return {};

  if (!isOwnMediaUrl(url, { supabaseUrl: config.supabase.url })) {
    throw badRequest('That image is not one uploaded to this quiz.');
  }

  // Describing the picture is what makes the question answerable by someone
  // using a screen reader, so it is asked for rather than silently optional.
  const imageAlt = asOptionalString(payload.imageAlt, 'imageAlt', {
    max: limits.imageAltMaxLength,
  });

  return { imageUrl: url, imageAlt: imageAlt ?? '' };
}

function parseQuizSettings(payload = {}, { partial = false } = {}) {
  const settings = {};

  if (!partial || payload.title !== undefined) {
    settings.title = asString(payload.title, 'title', { max: limits.titleMaxLength });
  }
  if (!partial || payload.description !== undefined) {
    settings.description = asOptionalString(payload.description, 'description', {
      max: limits.descriptionMaxLength,
    });
  }
  if (!partial || payload.timeLimitSeconds !== undefined) {
    settings.timeLimitSeconds = asInteger(payload.timeLimitSeconds, 'timeLimitSeconds', {
      min: limits.minTimeLimitSeconds,
      max: limits.maxTimeLimitSeconds,
    });
  }
  if (payload.isPublished !== undefined) {
    settings.isPublished = asBoolean(payload.isPublished, 'isPublished');
  }
  if (payload.allowRetakes !== undefined) {
    settings.allowRetakes = asBoolean(payload.allowRetakes, 'allowRetakes');
  }
  if (payload.endOnLeave !== undefined) {
    settings.endOnLeave = asBoolean(payload.endOnLeave, 'endOnLeave');
  }
  if (payload.shuffleQuestions !== undefined) {
    settings.shuffleQuestions = asBoolean(payload.shuffleQuestions, 'shuffleQuestions');
  }
  if (payload.shuffleOptions !== undefined) {
    settings.shuffleOptions = asBoolean(payload.shuffleOptions, 'shuffleOptions');
  }
  if (payload.revealAnswers !== undefined) {
    settings.revealAnswers = asBoolean(payload.revealAnswers, 'revealAnswers');
  }

  return settings;
}

/** Quizzes created before this setting existed still enforce it. */
const endsOnLeave = (quiz) => quiz.endOnLeave !== false;

function requireQuiz(quizId) {
  const quiz = quizRepository.findById(String(quizId ?? '').toUpperCase());
  if (!quiz) throw notFound('That quiz does not exist.');
  return quiz;
}

/**
 * Editing is limited to the maker who created the quiz. Someone else's quiz
 * reads as "does not exist" rather than "forbidden", so the join codes of
 * other makers cannot be probed.
 */
function requireOwnedQuiz(quizId, ownerId) {
  const quiz = requireQuiz(quizId);
  if (quiz.ownerId !== ownerId) throw notFound('That quiz does not exist.');
  return quiz;
}

function touch(quiz) {
  return { ...quiz, updatedAt: new Date().toISOString() };
}

export const quizService = {
  requireQuiz,
  requireOwnedQuiz,
  endsOnLeave,

  totalPoints(quiz) {
    return quiz.questions.reduce((sum, question) => sum + question.points, 0);
  },

  /** Everything the maker's dashboard needs, without the full question list. */
  listSummaries(ownerId) {
    return quizRepository
      .list()
      .filter((quiz) => quiz.ownerId === ownerId)
      .map((quiz) => ({
        id: quiz.id,
        title: quiz.title,
        description: quiz.description,
        timeLimitSeconds: quiz.timeLimitSeconds,
        isPublished: quiz.isPublished,
        allowRetakes: quiz.allowRetakes,
        endOnLeave: endsOnLeave(quiz),
        shuffleQuestions: Boolean(quiz.shuffleQuestions),
        shuffleOptions: Boolean(quiz.shuffleOptions),
        revealAnswers: Boolean(quiz.revealAnswers),
        questionCount: quiz.questions.length,
        totalPoints: quizService.totalPoints(quiz),
        attemptCount: attemptRepository.listSubmittedByQuiz(quiz.id).length,
        createdAt: quiz.createdAt,
        updatedAt: quiz.updatedAt,
      }));
  },

  create(payload, ownerId) {
    const settings = parseQuizSettings(payload);
    const now = new Date().toISOString();

    return quizRepository.insert({
      id: generateQuizId(),
      ownerId,
      title: settings.title,
      description: settings.description,
      timeLimitSeconds: settings.timeLimitSeconds,
      isPublished: settings.isPublished ?? false,
      allowRetakes: settings.allowRetakes ?? false,
      endOnLeave: settings.endOnLeave ?? true,
      shuffleQuestions: settings.shuffleQuestions ?? false,
      shuffleOptions: settings.shuffleOptions ?? false,
      revealAnswers: settings.revealAnswers ?? false,
      questions: [],
      createdAt: now,
      updatedAt: now,
    });
  },

  /**
   * Add many questions from one pasted block.
   *
   * All or nothing: if any line is bad the whole paste is refused, because a
   * half-imported quiz is harder to repair than one that was never imported.
   * `dryRun` runs exactly the same parse and validation but saves nothing,
   * which is what the preview uses - so what you preview is what you get.
   */
  addQuestionsFromText(quizId, text, ownerId, { dryRun = false } = {}) {
    const quiz = requireOwnedQuiz(quizId, ownerId);
    const { questions, errors } = parseBulkQuestions(text);

    // Run each one through the same validation a typed question gets, so the
    // preview catches duplicate options and over-long text too.
    const parsed = [];
    for (const question of questions) {
      try {
        parsed.push({ line: question.line, ...parseQuestionPayload(question) });
      } catch (error) {
        errors.push({ line: question.line, message: error.message });
      }
    }

    errors.sort((a, b) => a.line - b.line);

    if (dryRun) return { questions: parsed, errors, added: 0 };

    if (errors.length > 0) {
      throw badRequest(
        `${errors.length} line(s) could not be read. Fix them and paste again.`,
        errors,
      );
    }
    if (parsed.length === 0) throw badRequest('Nothing to import.');

    let latest = quiz;
    for (const question of parsed) {
      latest = quizService.addQuestion(quiz.id, question, ownerId);
    }
    return { quiz: latest, questions: parsed, errors: [], added: parsed.length };
  },

  update(quizId, payload, ownerId) {
    const quiz = requireOwnedQuiz(quizId, ownerId);
    const settings = parseQuizSettings(payload, { partial: true });

    if (settings.isPublished === true && quiz.questions.length === 0) {
      throw badRequest('Add at least one question before publishing this quiz.');
    }

    return quizRepository.update(quiz.id, (current) => touch({ ...current, ...settings }));
  },

  /**
   * Wipe every attempt at a quiz, keeping the quiz itself.
   *
   * This is how the same quiz gets run with a second group: it clears the
   * leaderboard and, with it, the record of who has already taken it, so the
   * one-attempt rule starts from scratch.
   */
  clearResults(quizId, ownerId) {
    const quiz = requireOwnedQuiz(quizId, ownerId);
    const removed = attemptRepository.removeByQuiz(quiz.id);
    return { quizId: quiz.id, removed };
  },

  /**
   * Delete one attempt from a quiz's leaderboard.
   *
   * Both the one-attempt checks look for a *submitted* attempt, so removing
   * somebody's record is also what lets that person - and only that person -
   * take the quiz again.
   */
  removeAttempt(quizId, attemptId, ownerId) {
    const quiz = requireOwnedQuiz(quizId, ownerId);
    const attempt = attemptRepository.findById(attemptId);

    // Checking the quiz matches stops an id from another quiz being deleted
    // through a quiz this maker happens to own.
    if (!attempt || attempt.quizId !== quiz.id) throw notFound('That attempt does not exist.');

    attemptRepository.remove(attempt.id);
    return { attemptId: attempt.id, participantName: attempt.participantName };
  },

  remove(quizId, ownerId) {
    const quiz = requireOwnedQuiz(quizId, ownerId);
    attemptRepository.removeByQuiz(quiz.id);
    quizRepository.remove(quiz.id);
  },

  addQuestion(quizId, payload, ownerId) {
    const quiz = requireOwnedQuiz(quizId, ownerId);
    const question = { id: createId(), ...parseQuestionPayload(payload) };

    return quizRepository.update(quiz.id, (current) =>
      touch({ ...current, questions: [...current.questions, question] }),
    );
  },

  updateQuestion(quizId, questionId, payload, ownerId) {
    const quiz = requireOwnedQuiz(quizId, ownerId);
    if (!quiz.questions.some((question) => question.id === questionId)) {
      throw notFound('That question does not exist.');
    }
    const parsed = parseQuestionPayload(payload);

    return quizRepository.update(quiz.id, (current) =>
      touch({
        ...current,
        questions: current.questions.map((question) =>
          question.id === questionId ? { ...question, ...parsed } : question,
        ),
      }),
    );
  },

  removeQuestion(quizId, questionId, ownerId) {
    const quiz = requireOwnedQuiz(quizId, ownerId);
    if (!quiz.questions.some((question) => question.id === questionId)) {
      throw notFound('That question does not exist.');
    }

    return quizRepository.update(quiz.id, (current) => {
      const questions = current.questions.filter((question) => question.id !== questionId);
      // A published quiz with no questions cannot be taken, so unpublish it.
      return touch({ ...current, questions, isPublished: questions.length > 0 && current.isPublished });
    });
  },

  moveQuestion(quizId, questionId, direction, ownerId) {
    const quiz = requireOwnedQuiz(quizId, ownerId);
    const index = quiz.questions.findIndex((question) => question.id === questionId);
    if (index === -1) throw notFound('That question does not exist.');

    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= quiz.questions.length) return quiz;

    return quizRepository.update(quiz.id, (current) => {
      const questions = [...current.questions];
      [questions[index], questions[target]] = [questions[target], questions[index]];
      return touch({ ...current, questions });
    });
  },

  /**
   * Quizzes created before accounts existed have no owner. The first account
   * to be created adopts them, so nothing is stranded by the upgrade.
   */
  adoptOwnerless(ownerId) {
    const orphans = quizRepository.list().filter((quiz) => !quiz.ownerId);
    for (const quiz of orphans) {
      quizRepository.update(quiz.id, (current) => ({ ...current, ownerId }));
    }
    return orphans.length;
  },

  /** The quiz as a participant may see it: no correct answers, no points give-away. */
  /**
   * `attemptId` decides the shuffle. It is required whenever a quiz shuffles,
   * because the order has to be reproducible for that one attempt - a refresh
   * must not rearrange options underneath answers already saved.
   */
  toParticipantView(quiz, attemptId = null) {
    const shuffleQuestions = Boolean(quiz.shuffleQuestions) && attemptId;
    const shuffleOptions = Boolean(quiz.shuffleOptions) && attemptId;

    const order = shuffleQuestions
      ? questionOrder(attemptId, quiz.questions.length)
      : quiz.questions.map((_, index) => index);

    return {
      id: quiz.id,
      title: quiz.title,
      description: quiz.description,
      timeLimitSeconds: quiz.timeLimitSeconds,
      endOnLeave: endsOnLeave(quiz),
      questionCount: quiz.questions.length,
      totalPoints: quizService.totalPoints(quiz),
      questions: order.map((questionIndex) => {
        const question = quiz.questions[questionIndex];

        // The participant sees options in their own order; the index they send
        // back is translated to the answer key's order before anything is stored.
        const base = {
          id: question.id,
          type: questionTypeOf(question),
          text: question.text,
          points: question.points,
          ...(question.imageUrl
            ? { imageUrl: question.imageUrl, imageAlt: question.imageAlt ?? '' }
            : {}),
        };

        // Typed answers have nothing to shuffle and no options to leak.
        if (!hasOptions(question)) return base;

        const options = shuffleOptions
          ? optionOrder(attemptId, question.id, question.options.length).map(
              (optionIndex) => question.options[optionIndex],
            )
          : question.options;

        return { ...base, options };
      }),
    };
  },
};
