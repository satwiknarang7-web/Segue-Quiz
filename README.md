# SegueQuiz

Create a quiz, share it as a QR code, run it against a timer, and rank the results.

The leaderboard rule is simple: **highest score wins, and when scores tie the faster
finisher wins.**

Zero runtime dependencies — Node's standard library only. No build step, no database
server, no `npm install`.

## Running it

```bash
npm start
```

Then open <http://localhost:4000>.

The console prints two addresses and, the first time, a maker sign-up code. Use the
**Organiser** address yourself, and note the **Participants** one — that is your
machine's LAN address, and it is what the QR code encodes, because a phone cannot
reach `localhost`.

Open the site, choose **Create account**, and follow the three steps: details, then
two-factor enrolment, then your recovery codes.

## How it works

1. **Create a quiz** on the dashboard: title, description, and a time limit.
2. **Add questions** in the editor — multiple choice, 2 to 6 options, one correct
   answer, and a point value per question.
3. **Open it for taking** with the "Open quiz" button — on the dashboard card or in the
   editor header. A quiz stays a draft, and nobody can join, until you do.
4. **Share the QR code** shown in the editor, or read out the six-character join code.
   Participants can also type the URL by hand.
5. **Watch the results** page. It refreshes itself every 8 seconds while you have it open.

### The timer

The countdown starts server-side the moment a participant presses Start, and the
deadline is stored with the attempt. That means:

- Answers autosave as they are picked, so a closed tab loses nothing.
- Refreshing the page resumes the same attempt with the same deadline — it does not
  hand out a fresh timer.
- If the clock runs out, the attempt is submitted automatically with whatever was
  answered, and the recorded time is capped at the limit.
- An attempt abandoned entirely is finalised the next time results are viewed.

### Leaving the quiz

By default an attempt **ends the moment the taker leaves the screen** — switching browser
tab, switching app, or locking the phone. Whatever they had answered is scored, the time
is recorded, and the attempt is closed for good. They cannot answer more, and they cannot
start again unless retakes are on.

The taker is warned twice before this can bite: a notice on the start screen, and a
standing reminder above the questions.

How it is detected and enforced:

- The browser's `visibilitychange` (plus `pagehide`) is what fires — the same signal for
  a tab switch, an app switch and a screen lock.
- The report is sent with `navigator.sendBeacon`, because a hidden page can be frozen or
  killed before an ordinary request finishes. A `keepalive` fetch is the fallback.
- Ending is done **server-side**, so closing the phone and never coming back still ends
  the attempt. The endpoint is idempotent — a beacon and a later reload both land safely.
- Time is capped at the limit, so leaving and returning much later cannot inflate it.
- The leaderboard shows these attempts as *Ended — left the quiz*.

Turn it off per quiz with **End the attempt if a taker leaves the screen** in the editor's
settings. Worth knowing: a phone notification that pulls focus, or the screen dimming to
lock, counts as leaving. For a relaxed quiz, switch it off.

### Ranking

Attempts are sorted by score descending, then by elapsed time ascending, then by
submission time. Two attempts with the same score *and* the same time share a rank.

### Who can see what

There are two kinds of people here, and only one of them signs in.

| | Quiz taker | Quiz maker |
| --- | --- | --- |
| Account needed | none | email, password and 2FA |
| Take a quiz (`/take/:id`) | yes | yes |
| Leaderboard (`/quizzes/:id/results`) | no | own quizzes |
| Question breakdown and CSV export | no | own quizzes |
| Dashboard and editor | no | own quizzes |
| Create, edit, open, delete quizzes | no | own quizzes |
| QR code and share links | no | own quizzes |

Anyone reaching a maker page is sent to `/signin`; maker API calls answer `401`.
Quizzes belong to the maker who created them — another maker's quiz answers `404`
rather than `403`, so join codes cannot be probed by guessing.

Three details worth knowing, because they are easy to get wrong:

- **The leaderboard is private to the quiz's owner.** Takers cannot see who is winning,
  and after submitting they see only their own score. The page redirects to sign in and
  the API answers `401`; another maker gets `404`.
- Page files are **not** served as static assets. `/editor.html` returns 404; pages
  are only reachable through their routes, which is where the check lives.
- A correct password alone gets you a **pending** session that unlocks nothing but the
  two-factor step. Only the second factor produces a session the maker routes accept.

### Two-factor authentication

**No email or SMS is ever sent.** Maker accounts use a TOTP authenticator app — Google
Authenticator, Microsoft Authenticator, Authy, or a password manager like 1Password or
Bitwarden. At sign-up you scan a standard `otpauth://` QR code; from then on the app
generates a fresh six-digit code every 30 seconds, offline, on your phone. There is
nothing to wait for in an inbox, and the app sends no mail because it has no mail
service to send through.

- Passwords are hashed with scrypt and a per-account salt.
- Sign-up issues **eight single-use recovery codes**, shown exactly once. Each signs
  you in if the phone is lost, and the leftover count is reported when one is spent.
- Codes from the previous and next 30-second window are accepted, so a phone whose
  clock drifts slightly still works.
- Sessions are signed, HttpOnly cookies lasting 12 hours. Passwords and codes are both
  throttled after repeated failures.

### Who may register

By default, creating a maker account needs the **maker sign-up code** printed in the
server console. Without it, anyone who can reach the server — which on a LAN means
anyone who can take your quiz — could register and start editing.

Set `SEGUEQUIZ_SIGNUP_CODE` to choose the code yourself, or `SEGUEQUIZ_OPEN_SIGNUP=true`
to drop the requirement entirely.

The first account created adopts any quizzes that already existed, so nothing made
before accounts were introduced is stranded.

## Storing data in Supabase

Out of the box everything lives in JSON files under `data/`. Point the app at a
Supabase project and quizzes, attempts and maker accounts move into Postgres instead.
Sign-in is untouched — Supabase is the database, not the authentication.

**1. Create the tables.** In your project: SQL Editor → New query → paste
[`supabase/migrations/0001_initial_schema.sql`](supabase/migrations/0001_initial_schema.sql)
→ Run. It is safe to run more than once.

**2. Set two environment variables.** Both come from Project Settings → API:

```bash
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

**3. Start the app.** It prints which backend it is using:

```
Storage:      Supabase (1 users, 3 quizzes, 6 attempts)
```

Set neither and it stays on JSON files; set only one and it refuses to start rather
than silently writing somewhere you did not expect.

### How it connects

Through Supabase's PostgREST endpoint (`/rest/v1`) over plain `fetch` — no client
library, so the project keeps its zero dependencies.

The `service_role` key is used, which bypasses row level security. That is deliberate
and safe here because **the key never leaves the server**: browsers talk to SegueQuiz,
and SegueQuiz talks to Supabase. Every rule about who may see what — a taker not
seeing the answer key, a maker not seeing another maker's quizzes — is enforced in the
application, exactly as before. RLS is switched on with no policies, so if that key
ever did leak into a browser, the anon role still reads nothing.

### What is stored, and what is not

Questions live in a `jsonb` column on `quizzes`, and answers likewise on `attempts`.
A quiz is always read and written whole, and question order is part of the document,
so separate tables would buy joins nobody makes and lose ordering for free.

The session signing key and maker sign-up code stay in `data/secrets.json`. They are
server configuration rather than application data, and keeping them out of the
database means a database dump carries no ability to mint sessions.

### The one limitation to know

Rows are read into memory once at start-up; every change is applied there and written
through to Postgres on a queue. This keeps the whole application above the store layer
synchronous and unchanged — it is exactly how the JSON store already behaved.

The cost: **this process is the live copy.** Editing rows in the Supabase dashboard,
or running a second instance against the same project, will not be seen until a
restart. For one server running one event — what this app is for — that is fine. Making
Supabase the live source of truth means making the repositories async, which ripples
through every service and route.

Writes that fail are logged and skipped rather than crashing the app, and the queue
keeps working afterwards, so a brief network blip loses a write rather than the event.

## Deploying it

The app is a long-running Node process, so it belongs on a container host —
Render, Railway, Fly, or anything that runs a container. A `render.yaml` blueprint
and a `Dockerfile` are both included.

It is **not** suited to Vercel or other serverless platforms without change: rows are
held in memory per process, so separate instances would disagree about who is
mid-attempt, and the ephemeral disk would mint a new session key on every cold start.
Making that work means an async data layer — see the note at the end of the Supabase
section.

### On Render

1. Push this repository to GitHub.
2. Render → **New** → **Blueprint** → pick the repository. `render.yaml` does the rest.
3. Fill in the values it prompts for (below).

### Anywhere that runs a container

```bash
docker build -t seguequiz .
```

```bash
docker run -p 4000:4000 --env-file .env seguequiz
```

Point the platform's health check at `/healthz`.

### What to set, and why it matters

| Variable | Why |
| --- | --- |
| `SEGUEQUIZ_SESSION_SECRET` | Signs session cookies. Without it a fresh key is generated on every restart, signing every maker out. `render.yaml` generates and keeps one for you. |
| `SEGUEQUIZ_SIGNUP_CODE` | The code needed to register a maker. Otherwise it changes on every restart. |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | **Without these the container's disk is the database, and a redeploy wipes every quiz, account and result.** |

The app tells you when it is running hosted without them:

```
! Storage is JSON files on a hosted container.
    Every redeploy or restart wipes quizzes, accounts and results.
    Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
```

You do not need to set `PUBLIC_BASE_URL`: Render, Railway and Fly each announce their
own public address and the app picks it up, so QR codes encode the right URL. Set it
by hand for a custom domain.

Once the app knows it is served over HTTPS, session cookies are marked `Secure`.

### Free tiers

Render's free web services spin down after a spell of inactivity, and the next request
can take up to a minute while the instance wakes. The first person to scan a QR code
after a quiet period waits; everyone after them does not. Open the URL yourself a
couple of minutes before an event starts, and it will be warm.

## Configuration

All optional, set as environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | Port to listen on. |
| `HOST` | `0.0.0.0` | Interface to bind. The default is what makes the app reachable from phones. |
| `PUBLIC_BASE_URL` | host address, else LAN | The origin encoded into QR codes. Detected automatically on Render, Railway and Fly. |
| `SEGUEQUIZ_SESSION_SECRET` | generated | Signs session cookies. Required for any deployment. |
| `SEGUEQUIZ_SECURE_COOKIES` | auto | Forces the `Secure` cookie flag on or off. Detected from the public URL. |
| `SEGUEQUIZ_DATA_DIR` | `./data` | Where JSON data and server secrets live. |
| `SUPABASE_URL` | unset | Supabase project URL. Set with the key below to use Postgres. |
| `SUPABASE_SERVICE_ROLE_KEY` | unset | Supabase service_role key. Server-side only. |
| `SEGUEQUIZ_SIGNUP_CODE` | generated | The code needed to register a maker account. |
| `SEGUEQUIZ_OPEN_SIGNUP` | `false` | `true` lets anyone register without a code. |

If the QR code points somewhere a phone cannot reach, that is what `PUBLIC_BASE_URL`
is for:

```bash
PUBLIC_BASE_URL=https://quiz.example.com npm start
```

## Project layout

```
src/
  server.js              HTTP server bootstrap and shutdown
  app.js                 Request pipeline: route match, body parse, error mapping
  config.js              Settings, limits, and join-URL construction
  lib/
    qrcode.js            QR encoder written from scratch (SVG + PNG output)
    router.js            Small path router with :params
    http.js              JSON/body/static-file helpers
    errors.js            HttpError and its shorthands
    validate.js          Input coercion and bounds checking
    ids.js               Join codes and record ids
    network.js           LAN address detection
    totp.js              TOTP (RFC 6238) and base32, for two-factor sign in
  store/
    index.js             Picks the backend: Supabase when configured, else JSON
    jsonStore.js         Atomic, write-serialised JSON collection
    supabaseStore.js     Same surface, backed by a Supabase table
    postgrest.js         Minimal PostgREST client over fetch
  repositories/          Data access for quizzes, attempts and users
  services/              Domain rules: accounts, authoring, attempts, leaderboard
  routes/                Route definitions grouped by area
public/                  Landing, auth, dashboard, editor, take, results
  css/                   app.css (shared), landing.css, auth.css
  img/                   SegueIT logo, light and dark tints
scripts/                 One-off importers
supabase/migrations/     SQL schema to run against your project
test/                    Node's built-in test runner
data/                    Runtime data (git-ignored)
```

### Why these choices

- **JSON files rather than a database.** A quiz session is small and single-process.
  Writes go through one queue and land atomically (temp file, then rename), so a
  crash mid-write cannot corrupt the store.
- **A hand-written QR encoder.** It keeps the dependency count at zero. It covers byte
  mode, versions 1–10 and all four error-correction levels, which is far more than a
  join URL needs. The test suite decodes its own output — reading the format bits back,
  un-masking, de-interleaving the blocks and checking every Reed-Solomon syndrome is
  zero — and cross-checks the capacity tables against the published figures.
- **No client framework.** The pages build their DOM through a small `el()` helper that
  never touches `innerHTML`, so quiz text and participant names cannot inject markup.
- **TOTP written from scratch.** Two-factor is an HMAC and a time window, so it needs no
  package. The test suite checks it against the published RFC 4226 vectors, and the
  enrolment QR is produced by the same encoder that makes the join codes.

## Branding

The header carries the SegueIT logo alongside the product name. The palette is taken
from the logo itself — navy `#042b56` and grey `#878787` — and both are exposed as
`--brand-navy` and `--brand-grey` in `public/css/app.css`.

The logo ships in two tints, because the navy disappears against a dark header:

- `public/img/segueit-logo.png` — the original colours, used in light mode
- `public/img/segueit-logo-dark.png` — lightened, swapped in under `prefers-color-scheme: dark`

To replace the logo, drop in two PNGs with those names, cropped tight to the artwork
(the header sizes them to 26px tall and lets the width follow).

## API

Routes marked **maker** need a fully signed-in maker who owns the quiz. Routes marked
**pending** are the two-factor step, reachable only with a half-finished session.
Everything else is public.

| Method | Path | Purpose | |
| --- | --- | --- | --- |
| `GET` | `/api/auth/me` | Who is viewing, and at which stage | |
| `GET` | `/api/auth/signup-policy` | Whether a maker code is required | |
| `POST` | `/api/auth/signup` | Create a maker account | |
| `POST` | `/api/auth/signin` | Step one: email and password | |
| `GET` | `/api/auth/2fa/setup` | Enrolment secret and QR link | pending |
| `GET` | `/api/auth/2fa/qr.svg` | Enrolment QR for an authenticator app | pending |
| `POST` | `/api/auth/2fa/activate` | Finish enrolment, receive recovery codes | pending |
| `POST` | `/api/auth/2fa/verify` | Step two: authenticator or recovery code | pending |
| `POST` | `/api/auth/signout` | Sign out | |
| `GET` | `/api/quizzes` | List quizzes with counts | maker |
| `POST` | `/api/quizzes` | Create a quiz | maker |
| `GET` | `/api/quizzes/:id` | Full quiz, including the answer key | maker |
| `PATCH` | `/api/quizzes/:id` | Update settings | maker |
| `DELETE` | `/api/quizzes/:id` | Delete a quiz and its attempts | maker |
| `POST` | `/api/quizzes/:id/questions` | Add a question | maker |
| `PUT` | `/api/quizzes/:id/questions/:questionId` | Update a question | maker |
| `DELETE` | `/api/quizzes/:id/questions/:questionId` | Delete a question | maker |
| `POST` | `/api/quizzes/:id/questions/:questionId/move` | Reorder a question | maker |
| `GET` | `/api/quizzes/:id/share` | Join code, join URL and QR links | maker |
| `GET` | `/api/quizzes/:id/qr.svg` | QR code as SVG (`?size=`) | maker |
| `GET` | `/api/quizzes/:id/qr.png` | QR code as PNG (`?scale=`) | maker |
| `GET` | `/api/quizzes/:id/results` | Leaderboard, stats and per-question breakdown | maker |
| `GET` | `/api/quizzes/:id/results.csv` | Leaderboard as CSV | maker |
| `GET` | `/api/quizzes/:id/intro` | Participant-facing summary |  |
| `POST` | `/api/quizzes/:id/attempts` | Start (or resume) an attempt |  |
| `GET` | `/api/attempts/:id` | Attempt state and remaining time |  |
| `POST` | `/api/attempts/:id/answers` | Autosave one answer |  |
| `POST` | `/api/attempts/:id/submit` | Submit and score |  |
| `POST` | `/api/attempts/:id/abandon` | End an attempt because the taker left |  |

Participant-facing endpoints never include `correctIndex`; scoring happens on the server.

## Importing a quiz

`scripts/import-ai-quiz.mjs` loads the **SegueIT AI Quiz** (15 questions on agentic AI,
RAG, LLMs and automation) from its Google Form into a running server:

```bash
SEGUEQUIZ_PASSCODE=your-passcode node scripts/import-ai-quiz.mjs
```

Google does not publish a form's answer key, so the `correctIndex` values in that
script were derived from the subject matter rather than copied from the form. Check
them against your own key before running the quiz for real.

The Google Form also collected Email, Full Name and Roll Number. SegueQuiz identifies
participants by a single name field, so those extra fields are not carried over.

## Limitations worth knowing

- Traffic is plain HTTP by default. Passwords and one-time codes cross the network in
  the clear, so put the app behind HTTPS before exposing it beyond a LAN you trust.
  The session cookie is not marked `Secure` for the same reason.
- There is no password reset or email verification, because the app sends no email.
  A maker who loses both their password and their recovery codes needs their record
  editing in `data/users.json` by hand.
- Participants are identified by the name they type. Names are matched
  case-insensitively to block retakes, but nothing stops someone entering a new name.
- State lives in JSON files sized for a classroom or a team, not thousands of concurrent
  submissions.
