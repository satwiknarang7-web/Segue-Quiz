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

### Adding many questions at once

**Paste many** in the editor takes a block of text, one question per line: the question
first, then its options, with `*` in front of the correct one.

```
Capital of France?	Berlin	*Paris	Madrid	Rome
Two plus two?	3	*4	5
Water is wet	*True	False
```

Cells are separated by tabs or commas. Tabs are the default because that is exactly
what copying a range out of Excel or Google Sheets produces, so a spreadsheet of
questions pastes straight in. Commas work too, with `"quoted cells"` when a question
contains one. Blank lines and `#` comments are skipped, and trailing empty columns are
ignored.

Marking the answer inline rather than in a fixed column is what lets one paste mix
two-option and six-option questions.

The preview underneath is a **dry run of the real import** - the same parsing and the
same validation, saving nothing - so what it shows is what you get. Problems are listed
against the line number in your paste, and **Import stays disabled until every line is
good**: a half-imported quiz is harder to repair than one that never imported.

### Showing takers their answers

Off by default. With **Show takers the answers when they submit** on, the result screen
lists every question with their pick, the right one, and the points awarded; unanswered
questions read as blank rather than wrong.

It is off by default deliberately. When people sit the same quiz at different times,
handing the answers to whoever finishes first undoes the shuffling and the one-attempt
rule in one step. With it off, takers still see their own score - they just do not see
which questions carried it.

The answer key is **withheld from the response entirely** rather than hidden in the
page, so opening the network tab reveals nothing the quiz did not choose to share.

### Shuffling

Two per-quiz settings, both off by default: **shuffle the question order** and
**shuffle the answer options**, each independently.

The arrangement is derived from the attempt id rather than stored, which makes it
stable for that attempt and different between attempts. Reloading, resuming after a
dropped connection, or stepping back to an earlier question all show the same
arrangement - anything else would leave saved answers pointing at the wrong option.

Answers are recorded against the **authored** option order. The translation from
"position N of what I was shown" happens on the way in, so scoring, the question
breakdown, the CSV export and the answer key are all untouched by shuffling. That
translation is the part worth being careful with: a mistake there marks people wrong
silently, so the tests check a correct pick scores under shuffling, a wrong pick does
not, and answers arriving with a bulk submission are translated the same way autosaves
are.

### Reviewing one person's answers

**View** on any leaderboard row opens that participant's paper: every question, the
option they chose, the option that was right, and the points awarded. Unanswered
questions are marked as such rather than shown as wrong.

The paper is shown in the authored order even when the attempt was shuffled, so every
participant's review reads the same way for marking.

### One attempt per person

With **Allow more than one attempt per person** off (the default), a quiz is refused a
second time on two independent checks:

- the participant's name, normalised, so signing in again as "priya" or " Priya " is caught; and
- an opaque per-browser cookie, so retyping a different name does not start a fresh attempt.

The cookie also keys the resume: reloading, or typing a new name mid-attempt, continues
the attempt already running with its original deadline rather than handing out a fresh
timer.

**This is not airtight, and cannot be.** Takers have no accounts, so identity is a
self-declared name plus a cookie. Anyone willing to open a private window, clear site
data, or pick up a second phone gets another go. It stops the casual retake, which is
what it is for. A real guarantee needs takers to sign in, which is a much bigger change
— ask if you want it.

### Letting one person retake

Each row on the leaderboard has a remove button. Deleting somebody's result frees
**only that person** to take the quiz again - both one-attempt checks look for a
submitted attempt, so removing theirs lifts the block on their name and their browser
while everyone else stays locked out.

The confirmation names them and the score being destroyed. There is no undo.

### Searching the leaderboard

The search box above the table filters by participant name as you type. It runs against
the rows already loaded, so it costs no request and does not disturb auto-refresh, and
ranks keep their real leaderboard position rather than being renumbered.

### Clearing the leaderboard

**Clear** on the results page deletes every attempt at that quiz while keeping the quiz,
its questions and its join code. It is owner-only, and irreversible - the confirmation
names how many attempts will go, and warns when some are still in progress.

Clearing also resets **who has already taken it**, which is the point: it is how the
same quiz gets run with a second group without having to rebuild it or hand out a new
QR code. Export the CSV first if the results matter.

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

**Sign-up is open.** Anyone who can reach the site can create a maker account, and a
maker can build and run their own quizzes. Quizzes are owned by whoever made them, so
a new maker sees an empty dashboard and cannot read anybody else's quiz, leaderboard
or answer key — but they can use your server.

On a public URL that is worth knowing about. If you need it closed again, the honest
options are to put the site behind something that authenticates first, or to keep it
on a LAN.

The first account created adopts any quizzes that already existed, so nothing made
before accounts were introduced is stranded.

### Forgotten passwords

There is no reset email, because there is no mail server. The second factor does the
authorising instead: on `/reset`, enter your email, then either the code your
authenticator is showing or one of the recovery codes from sign-up, then a new
password.

- A recovery code used this way is spent, and the response says how many remain.
- Resetting bumps the account's token version, which **signs out every existing
  session** — so a password changed because it may have leaked also evicts whoever
  might be holding it.
- A wrong code and an unknown email return exactly the same error, so the form cannot
  be used to discover which addresses have accounts.

Lose both the phone and the recovery codes and nobody can help: delete that row from
the `users` table and sign up again.

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

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/satwiknarang7-web/Segue-Quiz)

That button reads `render.yaml` from the repository and pre-fills everything except the
values marked `sync: false`, which it prompts for.

By hand instead: Render → **New** → **Blueprint** → pick the repository.

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

### Auto-deploy

Render only watches a repository for pushes once **its GitHub app is connected to that
repository**. A service created from a bare public URL clones fine but never learns
about new commits, so `autoDeploy: yes` sits there with nothing to trigger it and every
deploy has to be started by hand.

Connect it once: Render dashboard -> the service -> **Settings** -> **Build & Deploy** ->
connect the repository. That also turns on pull request previews.

`.github/workflows/ci.yml` covers the same ground from the other side. It runs the test
suite on every push and pull request, and on a green `main` it calls a Render deploy
hook - so a push that breaks the tests never reaches the site. The deploy step is
skipped unless a `RENDER_DEPLOY_HOOK_URL` secret exists, so the workflow is useful as
plain CI even if you connect Render directly instead.

To use that path: Render -> Settings -> **Deploy Hook**, copy the URL, then add it as a
repository secret named `RENDER_DEPLOY_HOOK_URL` under GitHub -> Settings -> Secrets and
variables -> Actions.

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
    parseQuestions.js    Reads pasted TSV/CSV question blocks
    shuffle.js           Deterministic per-attempt question and option order
    totp.js              TOTP (RFC 6238) and base32, for two-factor sign in
  store/
    index.js             Picks the backend: Supabase when configured, else JSON
    jsonStore.js         Atomic, write-serialised JSON collection
    supabaseStore.js     Same surface, backed by a Supabase table
    postgrest.js         Minimal PostgREST client over fetch
  repositories/          Data access for quizzes, attempts and users
  services/              Domain rules: accounts, authoring, attempts, leaderboard
  routes/                Route definitions grouped by area
public/                  Landing, auth, reset, dashboard, editor, take, results
  css/                   app.css (shared), landing.css, auth.css
  img/                   SegueIT logo, light and dark tints
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
| `POST` | `/api/auth/signup` | Create a maker account | |
| `POST` | `/api/auth/signin` | Step one: email and password | |
| `GET` | `/api/auth/2fa/setup` | Enrolment secret and QR link | pending |
| `GET` | `/api/auth/2fa/qr.svg` | Enrolment QR for an authenticator app | pending |
| `POST` | `/api/auth/2fa/activate` | Finish enrolment, receive recovery codes | pending |
| `POST` | `/api/auth/2fa/verify` | Step two: authenticator or recovery code | pending |
| `POST` | `/api/auth/reset-password` | New password, authorised by the second factor | |
| `POST` | `/api/auth/signout` | Sign out | |
| `GET` | `/api/quizzes` | List quizzes with counts | maker |
| `POST` | `/api/quizzes` | Create a quiz | maker |
| `GET` | `/api/quizzes/:id` | Full quiz, including the answer key | maker |
| `PATCH` | `/api/quizzes/:id` | Update settings | maker |
| `DELETE` | `/api/quizzes/:id` | Delete a quiz and its attempts | maker |
| `POST` | `/api/quizzes/:id/questions` | Add a question | maker |
| `POST` | `/api/quizzes/:id/questions/bulk` | Add many from pasted text (`dryRun` previews) | maker |
| `PUT` | `/api/quizzes/:id/questions/:questionId` | Update a question | maker |
| `DELETE` | `/api/quizzes/:id/questions/:questionId` | Delete a question | maker |
| `POST` | `/api/quizzes/:id/questions/:questionId/move` | Reorder a question | maker |
| `GET` | `/api/quizzes/:id/share` | Join code, join URL and QR links | maker |
| `GET` | `/api/quizzes/:id/qr.svg` | QR code as SVG (`?size=`) | maker |
| `GET` | `/api/quizzes/:id/qr.png` | QR code as PNG (`?scale=`) | maker |
| `GET` | `/api/quizzes/:id/results` | Leaderboard, stats and per-question breakdown | maker |
| `GET` | `/api/quizzes/:id/attempts/:attemptId` | One participant's answers, question by question | maker |
| `DELETE` | `/api/quizzes/:id/attempts/:attemptId` | Remove one result, freeing that person | maker |
| `DELETE` | `/api/quizzes/:id/results` | Clear every attempt, keeping the quiz | maker |
| `GET` | `/api/quizzes/:id/results.csv` | Leaderboard as CSV | maker |
| `GET` | `/api/quizzes/:id/intro` | Participant-facing summary |  |
| `POST` | `/api/quizzes/:id/attempts` | Start (or resume) an attempt |  |
| `GET` | `/api/attempts/:id` | Attempt state and remaining time |  |
| `POST` | `/api/attempts/:id/answers` | Autosave one answer |  |
| `POST` | `/api/attempts/:id/submit` | Submit and score |  |
| `POST` | `/api/attempts/:id/abandon` | End an attempt because the taker left |  |

Participant-facing endpoints never include `correctIndex`; scoring happens on the server.

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
