import { notFound } from '../lib/errors.js';
import {
  hasOptions,
  isAnswered,
  isCorrect,
  normaliseAnswerText,
  reviewRow,
} from '../lib/questionTypes.js';
import { attemptRepository } from '../repositories/attemptRepository.js';
import { attemptService } from './attemptService.js';
import { quizService } from './quizService.js';

/**
 * Ranking rule: highest score wins. When scores tie, the faster attempt wins.
 * If both are identical the earlier submission is listed first, and the two
 * genuinely share a rank.
 */
function compareAttempts(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.durationMs !== b.durationMs) return a.durationMs - b.durationMs;
  return Date.parse(a.submittedAt) - Date.parse(b.submittedAt);
}

const isTie = (a, b) => a.score === b.score && a.durationMs === b.durationMs;

export const leaderboardService = {
  build(quizId) {
    const quiz = quizService.requireQuiz(quizId);

    // Sweep up anyone whose timer expired while they were away, so the board is honest.
    attemptService.finaliseExpired(quiz.id);

    const attempts = attemptRepository.listSubmittedByQuiz(quiz.id).sort(compareAttempts);

    const entries = attempts.map((attempt, index) => ({
      rank: 0, // assigned below
      attemptId: attempt.id,
      participantName: attempt.participantName,
      score: attempt.score,
      maxScore: attempt.maxScore,
      percentage: attempt.maxScore === 0 ? 0 : Math.round((attempt.score / attempt.maxScore) * 100),
      correctCount: attempt.correctCount,
      answeredCount: attempt.answeredCount,
      questionCount: quiz.questions.length,
      durationMs: attempt.durationMs,
      timedOut: attempt.timedOut,
      endedReason: attempt.endedReason ?? (attempt.timedOut ? 'timed_out' : 'submitted'),
      submittedAt: attempt.submittedAt,
      position: index,
    }));

    entries.forEach((entry, index) => {
      entry.rank = index > 0 && isTie(entry, entries[index - 1]) ? entries[index - 1].rank : index + 1;
      delete entry.position;
    });

    const inProgress = attemptRepository
      .listByQuiz(quiz.id)
      .filter((attempt) => attempt.status === 'in_progress').length;

    return {
      quiz: {
        id: quiz.id,
        title: quiz.title,
        description: quiz.description,
        timeLimitSeconds: quiz.timeLimitSeconds,
        questionCount: quiz.questions.length,
        totalPoints: quizService.totalPoints(quiz),
        isPublished: quiz.isPublished,
      },
      stats: {
        submittedCount: entries.length,
        inProgressCount: inProgress,
        averageScore: entries.length
          ? Number((entries.reduce((sum, e) => sum + e.score, 0) / entries.length).toFixed(2))
          : 0,
        averageDurationMs: entries.length
          ? Math.round(entries.reduce((sum, e) => sum + e.durationMs, 0) / entries.length)
          : 0,
        topScore: entries.length ? entries[0].score : 0,
      },
      entries,
    };
  },

  /**
   * One participant's paper: every question, what they chose, what was right.
   *
   * Answers are stored against the authored option order, so this reads the
   * quiz directly and never has to know whether the attempt was shuffled.
   */
  attemptReview(quizId, attemptId) {
    const quiz = quizService.requireQuiz(quizId);
    const attempt = attemptRepository.findById(attemptId);

    if (!attempt || attempt.quizId !== quiz.id) throw notFound('That attempt does not exist.');

    const questions = quiz.questions.map((question, index) =>
      reviewRow(question, index, attempt.answers[question.id]),
    );

    return {
      attemptId: attempt.id,
      participantName: attempt.participantName,
      score: attempt.score,
      maxScore: attempt.maxScore,
      correctCount: attempt.correctCount,
      answeredCount: attempt.answeredCount,
      durationMs: attempt.durationMs,
      endedReason: attempt.endedReason ?? (attempt.timedOut ? 'timed_out' : 'submitted'),
      submittedAt: attempt.submittedAt,
      questions,
    };
  },

  /** Per-question breakdown so the organiser can see what tripped people up. */
  questionBreakdown(quizId) {
    const quiz = quizService.requireQuiz(quizId);
    const attempts = attemptRepository.listSubmittedByQuiz(quiz.id);

    return quiz.questions.map((question) => {
      const responses = attempts.filter((attempt) =>
        isAnswered(question, attempt.answers[question.id]),
      );
      const correct = responses.filter((attempt) =>
        isCorrect(question, attempt.answers[question.id]),
      ).length;

      const summary = {
        questionId: question.id,
        type: question.type ?? 'choice',
        text: question.text,
        responseCount: responses.length,
        correctCount: correct,
        correctRate: responses.length ? Math.round((correct / responses.length) * 100) : 0,
      };

      if (hasOptions(question)) {
        return {
          ...summary,
          optionCounts: question.options.map(
            (_, index) =>
              responses.filter((attempt) => attempt.answers[question.id] === index).length,
          ),
          correctIndex: question.correctIndex,
          options: question.options,
        };
      }

      // A typed question has no fixed options to count, so the useful thing is
      // what people actually wrote. Grouping by the graded form puts "15 N" and
      // "15n" together; the most common spelling of each is what gets shown.
      const groups = new Map();
      for (const attempt of responses) {
        const given = String(attempt.answers[question.id]);
        // Group by the form that grading compares, so the spellings that score
        // the same are counted together rather than listed separately.
        const key = normaliseAnswerText(given);
        const group = groups.get(key) ?? { text: given, count: 0 };
        group.count += 1;
        groups.set(key, group);
      }

      return {
        ...summary,
        acceptedAnswers: question.acceptedAnswers ?? [],
        givenAnswers: [...groups.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 10)
          .map((group) => ({
            text: group.text,
            count: group.count,
            isCorrect: isCorrect(question, group.text),
          })),
      };
    });
  },

  toCsv(quizId) {
    const { entries } = leaderboardService.build(quizId);
    const escape = (value) => `"${String(value).replace(/"/g, '""')}"`;

    const rows = [
      ['Rank', 'Participant', 'Score', 'Max score', 'Percentage', 'Correct', 'Time taken', 'Submitted at'],
      ...entries.map((entry) => [
        entry.rank,
        entry.participantName,
        entry.score,
        entry.maxScore,
        `${entry.percentage}%`,
        `${entry.correctCount}/${entry.questionCount}`,
        formatDuration(entry.durationMs),
        entry.submittedAt,
      ]),
    ];

    return rows.map((row) => row.map(escape).join(',')).join('\r\n');
  },
};

function formatDuration(milliseconds) {
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
