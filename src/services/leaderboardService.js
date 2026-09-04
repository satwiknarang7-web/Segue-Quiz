import { notFound } from '../lib/errors.js';
import {
  hasOptions,
  isAnswered,
  isCorrect,
  needsMarking,
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
      // A row with marking outstanding is ranked on what it has earned so far.
      // The board shows that rather than hiding the person until a teacher gets
      // to them, because a hidden row looks like a lost attempt.
      pendingMarkCount: attempt.pendingMarkCount ?? 0,
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
        // Whether the ranking above is final at all.
        awaitingMarkingCount: entries.filter((entry) => entry.pendingMarkCount > 0).length,
      },
      entries,
    };
  },

  /**
   * Every drawing still waiting on a person, oldest submission first.
   *
   * Marking in submission order rather than by participant keeps a class fair:
   * whoever finished first is looked at first, and a teacher working down the
   * list is not applying a standard that drifts as they go.
   */
  markingQueue(quizId) {
    const quiz = quizService.requireQuiz(quizId);
    const drawn = quiz.questions
      .map((question, index) => ({ question, number: index + 1 }))
      .filter(({ question }) => needsMarking(question));

    if (drawn.length === 0) return { questions: [], items: [], remaining: 0 };

    const attempts = attemptRepository
      .listSubmittedByQuiz(quiz.id)
      .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));

    const items = [];
    for (const attempt of attempts) {
      for (const { question, number } of drawn) {
        const drawingUrl = attempt.answers[question.id];
        const mark = attempt.marks?.[question.id] ?? null;

        // Nothing drawn is nothing to mark: an unanswered question is already
        // worth zero and putting it in the queue would be busywork.
        if (!drawingUrl) continue;

        items.push({
          attemptId: attempt.id,
          participantName: attempt.participantName,
          submittedAt: attempt.submittedAt,
          questionId: question.id,
          questionNumber: number,
          questionText: question.text,
          maxPoints: question.points,
          drawingUrl,
          mark,
        });
      }
    }

    return {
      questions: drawn.map(({ question, number }) => ({
        id: question.id,
        number,
        text: question.text,
        points: question.points,
      })),
      items,
      remaining: items.filter((item) => !item.mark).length,
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

    const marks = attempt.marks ?? {};
    const questions = quiz.questions.map((question, index) =>
      reviewRow(question, index, attempt.answers[question.id], marks[question.id]),
    );

    return {
      attemptId: attempt.id,
      participantName: attempt.participantName,
      score: attempt.score,
      maxScore: attempt.maxScore,
      correctCount: attempt.correctCount,
      answeredCount: attempt.answeredCount,
      pendingMarkCount: attempt.pendingMarkCount ?? 0,
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

      // A drawing has neither options nor text to group. What is worth showing
      // is how far the marking has got and what it is averaging, which is the
      // question a teacher part way through a class actually has.
      if (needsMarking(question)) {
        const marks = attempts
          .map((attempt) => attempt.marks?.[question.id])
          .filter((mark) => mark && Number.isFinite(Number(mark.points)))
          .map((mark) => Number(mark.points));

        return {
          ...summary,
          markedCount: marks.length,
          awaitingMarkingCount: responses.length - marks.length,
          maxPoints: question.points,
          averageMark: marks.length
            ? Number((marks.reduce((sum, points) => sum + points, 0) / marks.length).toFixed(1))
            : 0,
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
