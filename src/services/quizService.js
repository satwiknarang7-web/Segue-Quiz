import { config } from '../config.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { createId, createJoinCode } from '../lib/ids.js';
import { asArray, asBoolean, asInteger, asOptionalString, asString } from '../lib/validate.js';
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

function parseQuestionPayload(payload = {}) {
  const text = asString(payload.text, 'question', { max: limits.questionMaxLength });

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

  const points =
    payload.points === undefined || payload.points === null || payload.points === ''
      ? 1
      : asInteger(payload.points, 'points', { min: limits.minPoints, max: limits.maxPoints });

  return { text, options, correctIndex, points };
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
      questions: [],
      createdAt: now,
      updatedAt: now,
    });
  },

  /**
   * Create a quiz and all of its questions in one go, for importing a
   * ready-made set. Every question goes through the same validation as one
   * typed into the editor.
   */
  createWithQuestions({ quiz: settings, questions }, ownerId) {
    const quiz = quizService.create(settings, ownerId);
    let latest = quiz;

    for (const question of questions) {
      latest = quizService.addQuestion(quiz.id, question, ownerId);
    }
    return latest;
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
  toParticipantView(quiz) {
    return {
      id: quiz.id,
      title: quiz.title,
      description: quiz.description,
      timeLimitSeconds: quiz.timeLimitSeconds,
      endOnLeave: endsOnLeave(quiz),
      questionCount: quiz.questions.length,
      totalPoints: quizService.totalPoints(quiz),
      questions: quiz.questions.map((question) => ({
        id: question.id,
        text: question.text,
        options: question.options,
        points: question.points,
      })),
    };
  },
};
