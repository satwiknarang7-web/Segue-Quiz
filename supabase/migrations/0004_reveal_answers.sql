-- Whether a taker sees which questions they got right, and the answers, as
-- soon as they submit.
--
-- Off by default on purpose: when people sit the same quiz at different times,
-- revealing the answers to whoever finishes first undoes the shuffling and the
-- one-attempt rule.

alter table public.quizzes
  add column if not exists reveal_answers boolean not null default false;
