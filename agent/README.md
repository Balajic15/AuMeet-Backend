# AuMeet AI agent

The AI participant that joins AuMeet meetings. Built on LiveKit Agents (Node):
**Deepgram** (speech-to-text) → **Gemini** (reasoning) → **Cartesia Sonic** (voice).

## Run

```bash
cp .env.example .env   # LiveKit, Deepgram, Google AI Studio, Cartesia keys
npm install
npm run dev            # registers with LiveKit as agent "aumeet"
npm test               # unit tests (no keys needed)
```

The server puts an agent dispatch in the join token of meetings with **AI participant** on.
LiveKit then sends this agent into the room when it is created. `AGENT_NAME` must match in
`server/.env` and `agent/.env` (both default to `aumeet`).

## How it works

| Concern | Approach |
|---|---|
| **Who is speaking** | One Deepgram stream **per participant** (`listener.ts`), so every line is attributed by audio track, not guessed from a mixed recording. |
| **Interruptions** | One Silero VAD **per participant**. When anyone starts talking (≥250 ms) while the AI is thinking or speaking, the AI stops immediately. |
| **Languages** | Deepgram `nova-3` with `language: multi` detects the language per utterance. The AI is told to reply in that language, and Cartesia's voice language is switched to match (falls back to English for languages Sonic doesn't cover). |
| **When to talk** | `addressing.ts`: the AI answers when its name is said ("AuMeet", including common mis-hearings), or when the person it just answered follows up within 10 s. It also speaks up on its own in a few situations (see *Adaptive intervention*). The rest of the time it stays silent and listens. |
| **Chat** | Reads the meeting chat (`lk.chat`). Messages mentioning AuMeet or starting with `@ai` get a chat reply. |
| **Context** | Every utterance is added to the model's context as `Name: text`, capped at the last 120 items. |
| **Transcript storage** | If `MONGODB_URI` is set, each line goes to the `transcripts` collection (meeting code, speaker, user id, language, time) for steps 4 and 6. |
| **Leaving** | Shuts down 60 s after the last person leaves, after a final analysis pass. |

## Conversation intelligence (`src/intel/`)

While the meeting runs, `MeetingAnalyzer` keeps structured notes:

- **Decisions** with a strict status: `proposed`, `agreed` (the group explicitly settled on one option),
  `disputed` (competing options, not resolved), or `rejected`. Vague acknowledgements like "okay, let's
  proceed" never confirm a disputed decision. Instead the AI records a `confirmationNeeded` question,
  e.g. *"Can we confirm which database the team has agreed to use?"*
- **Action items** with owner (matched to a real participant and their account), deadline as said, and a
  resolved `dueDate`.
- **Open questions**, **topics**, and a running **summary**.
- Every item cites **evidence**: the transcript line numbers it came from.

How it runs: after 4 new lines, or 12 s of quiet, at most once every 15 s. Gemini returns JSON matching
a schema (`schema.ts`). `normalize.ts` keeps ids stable, never drops an item the model forgot, discards
evidence that points at lines that don't exist, and maps owners to participants.

Each update is:
1. sent to the room on topic `aumeet.insights` (the live **Insights** panel in the meeting UI),
2. saved to MongoDB `meeting_insights` (the **Meeting notes** page),
3. added to the voice assistant's instructions, so "AuMeet, what did we decide?" uses the same notes.

## Adaptive intervention (`src/intervene/`)

The AI speaks without being asked only when **all** of these are true:

1. **There's a reason** (`candidates.ts`, rule-based, from the live notes):
   - a disputed or unconfirmed decision with a `confirmationNeeded` question, at least 15 s old;
   - an open task nobody has taken, at least 45 s old;
   - a dispute that has gone in circles: 4+ minutes and 15+ lines → offer to summarise both sides.
2. **It's a natural pause:** nobody is speaking (tracked per participant from the VAD) for 1.8 s, and the
   AI isn't speaking or preparing a reply.
3. **It isn't too much:** 90 s since the AI last spoke (answers included), not in the first 30 s,
   each issue raised once, and at most 2 "should I?" checks per issue, 30 s apart.
4. **The model agrees** (`judge.ts`): Gemini sees the goal, the notes and the last 30 lines. It returns
   `{ speak, message }` and is told to stay quiet if the issue was already handled or people are still
   working it out.
5. **The moment hasn't passed:** if anyone starts talking while the model is deciding, the AI drops it.

People stay in control:
- The host setting *"AI can speak up on its own"* (`aiProactive`, sent in the dispatch metadata).
- Anyone can say "AuMeet, stay quiet" / "AuMeet, you can speak up again" (`proactivityCommand`).

## Memory of earlier sessions (`src/memory.ts`)

When a meeting link is reused (a weekly stand-up, say), the AI starts with a brief of the last 3
sessions of **that same link**: summary, agreed decisions, unresolved ones, and open tasks. It also
gets a `search_meeting_history` tool that searches that link's memory chunks (written by the server
worker). It never pulls in other meetings, because the people in this room may not have been in them.

Files: `main.ts` (wiring), `memory.ts`, `listener.ts` (per-speaker audio), `addressing.ts` (when to reply),
`prompts.ts` (instructions), `language.ts`, `transcript.ts`, `db.ts`, `config.ts`,
`gemini.ts` (structured calls), `intel/` (`analyzer.ts`, `schema.ts`, `normalize.ts`, `prompt.ts`, `gemini.ts`, `render.ts`, `store.ts`),
`intervene/` (`candidates.ts`, `judge.ts`, `controller.ts`).
