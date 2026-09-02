-- SegueQuiz schema
--
-- Run this once against your Supabase project: SQL Editor -> New query -> paste
-- -> Run. Safe to re-run; every statement is guarded.
--
-- Questions live in a jsonb column on `quizzes` rather than a table of their
-- own, and answers likewise on `attempts`. A quiz is always read and written
-- whole, and question order is part of the document, so splitting them out
-- would buy joins nobody makes and lose the ordering for free.

create extension if not exists "pgcrypto";

/* ---- Quiz makers ---------------------------------------------------------
   Passwords are scrypt hashes and TOTP secrets are stored as issued; the
   application does its own authentication and never exposes this table. */
create table if not exists public.users (
  id               uuid        primary key,
  name             text        not null,
  email            text        not null unique,
  password_salt    text        not null,
  password_hash    text        not null,
  totp_secret      text        not null,
  totp_confirmed   boolean     not null default false,
  recovery_codes   jsonb       not null default '[]'::jsonb,
  token_version    integer     not null default 1,
  created_at       timestamptz not null default now(),
  last_sign_in_at  timestamptz
);

/* ---- Quizzes -------------------------------------------------------------
   The primary key is the six-character join code, because that is what a QR
   code encodes and what a participant types. owner_id is nullable so quizzes
   made before accounts existed can be adopted. */
create table if not exists public.quizzes (
  id                  text        primary key,
  owner_id            uuid        references public.users(id) on delete cascade,
  title               text        not null,
  description         text        not null default '',
  time_limit_seconds  integer     not null check (time_limit_seconds >= 10),
  is_published        boolean     not null default false,
  allow_retakes       boolean     not null default false,
  end_on_leave        boolean     not null default true,
  questions           jsonb       not null default '[]'::jsonb,
  created_at          timestamptz not null,
  updated_at          timestamptz not null
);

create index if not exists quizzes_owner_id_idx on public.quizzes (owner_id);

/* ---- Attempts ------------------------------------------------------------
   participant_key is the lower-cased name, used to spot a retake or resume an
   attempt after a refresh. ended_reason records how the attempt finished. */
create table if not exists public.attempts (
  id                uuid        primary key,
  quiz_id           text        not null references public.quizzes(id) on delete cascade,
  participant_name  text        not null,
  participant_key   text        not null,
  -- Opaque per-browser marker, so a second attempt under a new name is caught.
  device_id         text,
  status            text        not null check (status in ('in_progress', 'submitted')),
  started_at        timestamptz not null,
  deadline_at       timestamptz not null,
  submitted_at      timestamptz,
  duration_ms       integer,
  timed_out         boolean     not null default false,
  ended_reason      text        check (ended_reason in ('submitted', 'timed_out', 'left_quiz')),
  answers           jsonb       not null default '{}'::jsonb,
  score             integer     not null default 0,
  correct_count     integer     not null default 0,
  max_score         integer     not null default 0,
  answered_count    integer     not null default 0
);

create index if not exists attempts_quiz_id_idx on public.attempts (quiz_id);
create index if not exists attempts_quiz_participant_idx
  on public.attempts (quiz_id, participant_key);
create index if not exists attempts_quiz_device_idx
  on public.attempts (quiz_id, device_id);
create index if not exists attempts_leaderboard_idx
  on public.attempts (quiz_id, score desc, duration_ms asc)
  where status = 'submitted';

/* ---- Row level security --------------------------------------------------
   RLS is on with no policies, which denies everything to the anon and
   authenticated roles. Only the service_role key bypasses RLS, and that key
   lives on the SegueQuiz server and never reaches a browser. Every rule about
   who may see what is enforced by the application, which is also what stops a
   quiz taker from reading the answer key. */
alter table public.users    enable row level security;
alter table public.quizzes  enable row level security;
alter table public.attempts enable row level security;
