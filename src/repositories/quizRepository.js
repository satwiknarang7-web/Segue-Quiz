import { createStore } from '../store/index.js';

/** Postgres columns are snake_case; the domain object stays camelCase. */
const toRow = (quiz) => ({
  id: quiz.id,
  owner_id: quiz.ownerId ?? null,
  title: quiz.title,
  description: quiz.description ?? '',
  time_limit_seconds: quiz.timeLimitSeconds,
  is_published: quiz.isPublished,
  allow_retakes: quiz.allowRetakes,
  end_on_leave: quiz.endOnLeave !== false,
  shuffle_questions: Boolean(quiz.shuffleQuestions),
  shuffle_options: Boolean(quiz.shuffleOptions),
  questions: quiz.questions ?? [],
  created_at: quiz.createdAt,
  updated_at: quiz.updatedAt,
});

const fromRow = (row) => ({
  id: row.id,
  // A quiz made before accounts existed has no owner until one adopts it.
  ...(row.owner_id ? { ownerId: row.owner_id } : {}),
  title: row.title,
  description: row.description ?? '',
  timeLimitSeconds: row.time_limit_seconds,
  isPublished: row.is_published,
  allowRetakes: row.allow_retakes,
  endOnLeave: row.end_on_leave,
  shuffleQuestions: Boolean(row.shuffle_questions),
  shuffleOptions: Boolean(row.shuffle_options),
  questions: row.questions ?? [],
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
});

const store = createStore({
  file: 'quizzes.json',
  table: 'quizzes',
  toRow,
  fromRow,
  // Added by supabase/migrations/0003_shuffle.sql.
  requiredColumns: ['id', 'shuffle_questions', 'shuffle_options'],
});

export const quizRepository = {
  list() {
    return store.all().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  findById(id) {
    return store.findById(id);
  },

  exists(id) {
    return store.findById(id) !== null;
  },

  insert(quiz) {
    return store.insert(quiz);
  },

  update(id, updater) {
    return store.update(id, updater);
  },

  remove(id) {
    return store.remove(id);
  },

  flushed() {
    return store.flushed();
  },
};
