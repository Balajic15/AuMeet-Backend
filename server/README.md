# MeetMind API (server)

Node + Express 5 + TypeScript + MongoDB. Handles accounts, meetings and LiveKit access tokens.

## Setup

```bash
cp .env.example .env   # fill in MongoDB Atlas + LiveKit Cloud values
npm install
npm run dev            # http://localhost:4000
npm test               # integration tests (in-memory MongoDB, no external services)
```

## Endpoints

All bodies are JSON. Authenticated routes need `Authorization: Bearer <jwt>`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | – | Liveness + DB state |
| POST | `/api/auth/register` | – | `{ email, name, password }` → `{ token, user }` |
| POST | `/api/auth/login` | – | `{ email, password }` → `{ token, user }` |
| GET | `/api/auth/me` | required | Current user |
| POST | `/api/meetings` | required | `{ title?, scheduledFor?, settings?: { allowGuests?, aiEnabled? } }` → `{ meeting }` |
| GET | `/api/meetings` | required | Meetings I host or joined |
| GET | `/api/meetings/:code` | optional | Lobby info for an invite link (`hostName`, `isHost`, status) |
| PATCH | `/api/meetings/:code` | host | Update title / schedule / settings |
| POST | `/api/meetings/:code/join` | optional | `{ name? }` (required for guests) → `{ livekit: { url, token }, participant, meeting }` |
| POST | `/api/meetings/:code/end` | host | End for everyone (closes the LiveKit room; link stops working) |
| POST | `/api/livekit/webhook` | LiveKit signature | Syncs `idle` ⇄ `live` status from `room_started` / `room_finished` |

### Meeting codes and identities

- Codes look like `abc-defg-hij` and double as the LiveKit room name.
- LiveKit identities are `user:<mongoId>` for accounts and `guest:<random>` for guests.
  Participant metadata is `{ role: 'host' | 'participant' | 'guest', userId }`. The AI agent
  uses this to know who is speaking.

### Webhook

In LiveKit Cloud → Settings → Webhooks, add `https://<public-url>/api/livekit/webhook`.
For local development, expose port 4000 with a tunnel (e.g. `ngrok http 4000`). Without the
webhook everything still works; meeting status just stays `idle` until the host ends it.

## Follow-through, feedback and analytics

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/meetings/:code/insights/:sessionId/actions` | Host: follow-up actions the agent proposed |
| POST | `/api/meetings/:code/insights/:sessionId/actions/plan` | Host: (re-)plan follow-ups now |
| PATCH | `/api/meetings/:code/insights/:sessionId/actions/:id` | Host: edit, approve or dismiss an action |
| POST | `/api/meetings/:code/insights/:sessionId/tasks` · `/decisions` | Add an item the AI missed (a correction) |
| PATCH | `/api/meetings/:code/insights/:sessionId/speakers` | `{ from, to, seqs? }` fix a misidentified speaker |
| GET/PUT | `/api/ai/follow-through` | My follow-through settings (reminders, overdue nudges, project webhook) |
| GET | `/api/ai/feedback` · `/feedback/dataset` | Corrections, recurring mistakes, lessons · JSONL evaluation dataset |
| POST/PATCH/DELETE | `/api/ai/feedback/learn` · `/feedback/lessons` · `/feedback` | Re-learn now · switch a lesson off/on · forget |
| GET | `/api/memory/commitments` | Who owns what across my meetings, overdue work, open risks |
| GET | `/api/memory/follow-through` | Actions waiting for my approval |
| GET/POST | `/api/analytics?days=30` · `/api/analytics/insights` | Effectiveness metrics vs the previous period · AI recommendations |
| GET | `/api/analytics/sessions/:sessionId` | One meeting's metrics |

- **Follow-through agent** (`services/followThrough.ts`): after the recap, the model drafts owner emails, reminders and
  calendar events (`.ics` plus a Google Calendar link). Emails and invites always wait for the host's approval.
  Reminders about a person's own task and pushes to the project tool can run on their own if the host allows it. A sweep
  every `FOLLOW_THROUGH_SWEEP_SECONDS` sends due reminders and nudges owners of overdue tasks (once per task). The
  project-tool webhook (HTTPS, public addresses only) receives `task.created` / `task.updated` JSON.
- **Feedback engine** (`services/feedback.ts`): every edit, delete, added item or speaker fix is stored in
  `ai_corrections` with the transcript lines behind it. Every `LEARN_SWEEP_SECONDS` the model proposes lessons from a host's
  corrections; safety rules keep one wrong correction from becoming a team rule:
  - **Evidence is counted by the server**, from the corrections each lesson cites. Only corrections inside the policy
    window count; ones that were undone later (an edit set back, an item added then deleted), marked wrong, or
    quarantined by a rollback don't.
  - **Thresholds** (the learning policy: `ai_profiles/learning-policy`, seeded from `config/learning-policy.seed.json`,
    host overrides via `PUT /api/ai/feedback/policy`): a lesson is applied only with enough corrections, from enough
    meetings and people, above a confidence bar, and with no correction against it. Otherwise it stays a *candidate*
    and never reaches the note-taker. Lessons expire when their corrections leave the window.
  - **Versions**: each learning run, rollback, lesson switch, excluded correction or threshold change is a new version
    in `ai_lessons`. The agent applies only the current version's active lessons.
  - **Rollback** (`POST /api/ai/feedback/rollback { version }`) restores any kept version and quarantines the corrections
    behind the lessons it removes, so they aren't re-learned; restoring a version that needs them releases them.
    `PATCH /api/ai/feedback/corrections/:id { excluded }` marks a single correction wrong (or counts it again).
- **Ask your meetings** now also gets a structured status ledger (tasks with owners and due dates, decision statuses,
  open risks), so "who owns X" and "what is pending" are answered from facts, not only from similar text.

## Background worker & meeting memory

```bash
npm run worker   # needs REDIS_URL, GOOGLE_API_KEY, MONGODB_URI
```

Every 5 minutes (`MEMORY_SWEEP_SECONDS`) a BullMQ job finds sessions that have ended (or went quiet for 2 hours because an
agent crashed) and have no recap yet, and queues one `process-session` job each. Jobs are retried
up to 3 times, and a session is given up after 3 failed attempts. Each job:

1. writes a **recap** (`headline`, `overview`, `highlights`, `nextSteps`) onto the session in
   `meeting_insights`;
2. builds **memory chunks** (`memory_chunks`): the recap, each decision, each task, and 12-line
   transcript windows, each with a Gemini embedding (768 dims, normalised).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/memory/overview` | My tasks across all meetings + decisions still waiting on the team |
| PATCH | `/api/memory/tasks/:sessionId/:taskId` | `{ status: 'open' \| 'done' }`. Owner or host, after the meeting ends |
| POST | `/api/memory/ask` | `{ question }` → `{ answer, sources[] }` from the user's own meetings only |

Access rule everywhere: a user sees meetings they host, joined with their account, or were heard
speaking in. Search is cosine similarity in the app over those meetings (fine for thousands of
chunks per user). At larger scale, create an Atlas Vector Search index on `memory_chunks.embedding`
and switch `src/memory/search.ts` to `$vectorSearch`.
