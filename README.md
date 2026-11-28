# AuMeet

Video meetings with an AI that actually participates. People meet in the browser (audio, video,
screen share, chat). AuMeet AI joins as a participant: it knows who is speaking, answers when
addressed, can be interrupted at any moment, follows the conversation across languages, tracks
decisions and tasks, speaks up when a decision is left unresolved, and remembers past meetings.

> "Let's use MongoDB." — "I think PostgreSQL is better." — "Okay, let's proceed."
> AuMeet doesn't record MongoDB as the decision. It marks it *Needs confirmation* and, at a natural
> pause, asks: *"Can we confirm which database the team has agreed to use?"*

## What the AI does

| | |
|---|---|
| **Live notes** | Decisions (*Confirmed*, *Suggested*, *Needs confirmation*), tasks with owners and deadlines, open questions, key points, assumptions, and risks and conflicts, all updated during the meeting with transcript evidence. |
| **Copilot** | A quiet panel in the meeting: what's being discussed, off-topic warnings, missing information, questions to ask, what to discuss next, and agenda and time advice. |
| **Speaking up** | At natural pauses it may ask to confirm a decision, find an owner, or clear up a conflict, depending on your settings. |
| **Memory** | Continuity between sessions, earlier decisions and blockers, and "who owns…?" / "what's pending?" across all your meetings (Dashboard → Team, Ask). |
| **Follow-through** | After the meeting: drafted emails, reminders, calendar invites and project-tool tasks. You approve external actions. It also nudges owners about overdue work. |
| **Learning** | Every correction you make (owner, deadline, status, speaker, a missed or wrong item) becomes training data. Recurring mistakes become lessons the note-taker follows, but only with enough independent evidence. Lessons are versioned, expire, and can be rolled back. |
| **Analytics** | Participation balance, speaking time, agenda completion, time to decide, unresolved items, and task completion over time, with AI recommendations. |

## Architecture

```
Browser (Angular) ──/api──▶ nginx ──▶ server (Express) ──▶ MongoDB Atlas
      │                                   │  ▲
      │ WebRTC (audio/video/chat)         │  └── worker (BullMQ) ◀── Redis
      ▼                                   │        recaps + memory embeddings (Gemini)
 LiveKit Cloud ◀── dispatch in join token ┘
      ▲
      └── agent (LiveKit Agents): Deepgram STT per speaker → Gemini → Cartesia TTS
             live notes → MongoDB + room · proactive interventions · meeting memory
```

| Folder | What | Docs |
|---|---|---|
| `web/` | Angular 22 app: auth, dashboard, lobby, meeting room, notes, My tasks, Ask | — |
| `server/` | Express 5 API + background worker (recaps, memory, follow-through, learning) | [server/README.md](server/README.md) |
| `agent/` | The AI participant | [agent/README.md](agent/README.md) |

## Services you need

| Service | Used for | Env |
|---|---|---|
| MongoDB Atlas | accounts, meetings, transcripts, insights, memory | `MONGODB_URI` (server, agent) |
| LiveKit Cloud | real-time audio/video, agent dispatch | `LIVEKIT_*` (server, agent) |
| Deepgram | speech-to-text | `DEEPGRAM_API_KEY` (agent) |
| Google AI Studio | Gemini reasoning + embeddings | `GOOGLE_API_KEY` (agent, server) |
| Cartesia | the AI's voice | `CARTESIA_API_KEY` (agent) |
| Redis | background jobs | `REDIS_URL` (server; provided by Docker Compose) |
| Google / GitHub OAuth | optional social sign-in | `GOOGLE_CLIENT_*`, `GITHUB_CLIENT_*` (server) |

## Run with Docker

```bash
cp server/.env.example server/.env   # fill in
cp agent/.env.example  agent/.env    # fill in
docker compose up --build
```

Open http://localhost:8080. Compose starts `web`, `server`, `worker`, `agent` and `redis`, and wires
`REDIS_URL`, `WEB_URL`, `PUBLIC_API_URL` and `CORS_ORIGINS` itself.

- **OAuth redirect URIs** for Docker: `http://localhost:8080/api/auth/oauth/{google|github}/callback`.
- **LiveKit webhook** (optional, keeps the "Live" badge accurate): `https://<your-domain>/api/livekit/webhook`.

## Deploy to production (HTTPS)

On a server with Docker, with your domain's DNS pointing at it and ports 80 and 443 open:

```bash
DOMAIN=meet.example.com PUBLIC_URL=https://meet.example.com docker compose --profile https up -d --build
```

Caddy gets and renews a Let's Encrypt certificate automatically and serves the app on
`https://meet.example.com`. Then update the redirect URIs and webhook to that domain.

### Production checklist

| | Item |
|---|---|
| 🔑 | **Rotate every key** that was ever shared in chat or committed anywhere (MongoDB password, LiveKit, Gemini, Deepgram, Cartesia, Upstash). |
| 🔑 | A long random `JWT_SECRET` (changing it signs everyone out). |
| 🌐 | HTTPS (Caddy profile above or your own proxy). Camera, mic and secure cookies need it. |
| ✉️ | `SMTP_URL` + `MAIL_FROM` so password reset, email confirmation and invitations send email. Then consider `REQUIRE_EMAIL_VERIFICATION=true`. |
| 🎥 | Recording (optional): an S3/R2/MinIO bucket in `RECORDING_S3_*`. Recordings use LiveKit Egress, which is included in LiveKit Cloud. |
| 🔒 | MongoDB Atlas: restrict network access to your server's IP; use a database user scoped to the `aumeet` database. |
| 🔒 | Google/GitHub OAuth apps (optional) with redirect URIs on your domain. |
| 🗑️ | `DATA_RETENTION_DAYS` if you want old transcripts and notes deleted automatically. |
| 📈 | Optional: Atlas Vector Search index for memory search at scale (`server/README.md`). |
| 🔔 | LiveKit webhook to `https://<domain>/api/livekit/webhook`. |
| 📋 | Logs are JSON (pino) on stdout, with request ids. Ship them to your log platform. |

### Security built in

- Sessions are **httpOnly, SameSite cookies**. Page scripts never see a token. Cookie writes need a
  CSRF header. Changing your password or "sign out everywhere" revokes all sessions.
- Rate limits on login, sign-up, password reset, invitations and AI questions.
- Strict Content-Security-Policy, Permissions-Policy (camera/mic for this site only), no framing.
- Password-reset tokens are single-use, stored hashed, and expire after 30 minutes. Account deletion
  removes hosted meeting data and anonymises the person elsewhere.
- Privacy: anyone can opt out of AI transcription (in the lobby or the meeting). The AI then doesn't
  process their audio or chat at all. While a meeting is recorded, everyone sees a REC badge.
- Hosts can use a waiting room (admit or deny each person), lock the meeting, and mute or remove people.
- **Per-session access**: on a recurring link, people see the notes, transcript, recordings, memory and analytics of
  the sessions they attended (the AI saw them, or they joined during it), not every session of the link. The host sees all.
- **Identity**: participants can't impersonate others. The server signs each participant's name, role and account
  into the join token; the AI ignores names, roles or account ids changed in the room, and marks changed names as
  unverified. The UI derives "host" from the token identity, never from editable metadata.
- **Audit log** (`audit_events`, kept `AUDIT_RETENTION_DAYS`, default 365): every successful change, failed sign-in,
  and every view or download of a transcript or recording. Hosts see a meeting's trail on its notes page (Activity);
  everyone can read their own sign-in history (`GET /api/auth/audit`).
- **Webhooks**: LiveKit webhooks are signature-checked and replay-protected (each event id is processed once).
  Outgoing project-tool webhooks are signed (`X-AuMeet-Signature: v1=HMAC-SHA256(secret, "<timestamp>.<body>")`,
  `X-AuMeet-Timestamp`, `X-AuMeet-Event-Id`), go only to public HTTPS addresses (checked at connect time, so DNS
  can't be re-pointed), and never follow redirects.
- **Prompt injection**: everything participants say or write, and anything derived from it (notes, documents, earlier
  meetings, corrections), reaches the model fenced as data the model must not obey; fake fence markers are
  neutralised. Messages sent without review (reminders, overdue nudges) have links, addresses and phone numbers
  stripped; emails and invites always need the host's approval.

## Run for development

```bash
cd server && npm install && npm run dev      # API on :4000
cd server && npm run worker                  # background jobs (needs Redis)
cd agent  && npm install && npm run dev      # AI participant
cd web    && npm install && npm start        # http://localhost:4200 (proxies /api to :4000)
```

Tests: `npm test` in `server/` and `agent/` (in-memory MongoDB and fake AI models, so no API
keys needed), and `npx ng test --watch=false` in `web/`. CI (`.github/workflows/ci.yml`) runs all
of them, plus the production build and the Docker images, on every push and pull request.
