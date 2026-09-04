-- Marks a person has awarded for answers a computer cannot grade.
--
-- A drawn answer has no answer key, so an attempt containing one is submitted
-- with a score that is real but not final: it counts everything gradeable and
-- nothing that is still waiting on a teacher.
--
-- `marks` is keyed by question id, each value being the awarded points, an
-- optional note, and whether a person or an accepted suggestion decided it.
-- `pending_mark_count` is stored rather than derived because the leaderboard
-- sorts on the score, and recomputing every attempt's marks on each refresh
-- would do that work for a whole class on every poll.

alter table public.attempts
  add column if not exists marks jsonb not null default '{}'::jsonb,
  add column if not exists pending_mark_count integer not null default 0;

-- Finding what is still to be marked is the one query the marking screen makes,
-- and it runs on every refresh of it.
create index if not exists attempts_pending_marking_idx
  on public.attempts (quiz_id)
  where pending_mark_count > 0;
