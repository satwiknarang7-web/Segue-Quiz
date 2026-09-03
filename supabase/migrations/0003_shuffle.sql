-- Per-quiz shuffling.
--
-- The order itself is never stored: it is derived from the attempt id, so it
-- stays stable across reloads without a column. These two flags only record
-- whether a quiz shuffles at all.

alter table public.quizzes
  add column if not exists shuffle_questions boolean not null default false;

alter table public.quizzes
  add column if not exists shuffle_options boolean not null default false;
