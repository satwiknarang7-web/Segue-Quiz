-- One attempt per person, part two.
--
-- Attempts were only ever keyed on the participant's self-declared name, so
-- typing a different name started a fresh attempt with a fresh timer. This
-- records the browser that started the attempt as well.

alter table public.attempts
  add column if not exists device_id text;

create index if not exists attempts_quiz_device_idx
  on public.attempts (quiz_id, device_id);
