import { fileURLToPath } from 'node:url';
import {
  AutoSubscribe,
  ServerOptions,
  cli,
  defineAgent,
  llm,
  log,
  voice,
  type JobContext,
  type JobProcess,
  type JobRequest,
  type VAD,
} from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as google from '@livekit/agents-plugin-google';
import * as silero from '@livekit/agents-plugin-silero';
import {
  ParticipantKind,
  RoomEvent,
  TrackKind,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from '@livekit/rtc-node';
import { geminiStructured, parseModels } from './gemini.js';
import { ThinkingLevel } from '@google/genai';
import { Moderator } from './intervene/moderator.js';
import { geminiBrain } from './brain.js';
import { geminiRouter } from './router.js';
import { loadBehaviour, wakeMatcher, type Behaviour } from './behaviour.js';
import { loadLearning, recordReaction, type IntentStats } from './learning.js';
import { AGENT_DISPLAY_NAME, config } from './config.js';
import { verifyParticipant } from './identity.js';
import { fence } from './untrusted.js';
import { languageName, voiceLanguage } from './language.js';
import { ParticipantListener } from './listener.js';
import { chatReplyInstruction, meetingInstructions, notesSection, replyInstruction, type MeetingInfo } from './prompts.js';
import { getAssistantName, MeetingTranscript, setAssistantName, TranscriptSink } from './transcript.js';
import { SharedDeviceVoices } from './voices.js';
import { emptyPrep, loadPrep, renderPrep, type MeetingPrep } from './prep.js';
import { connectMongo } from './db.js';
import { earlierSessionsBrief, historySearcher } from './memory.js';
import { FOLLOW_UP_ITEM, commitmentsLedger, loadContinuity, renderCarryover, type Continuity } from './carryover.js';
import { loadLessons } from './lessons.js';
import { z } from 'zod';
import { MeetingAnalyzer } from './intel/analyzer.js';
import { geminiAnalyzer } from './intel/gemini.js';
import type { Person } from './intel/normalize.js';
import { renderNotes } from './intel/render.js';
import type { Insights } from './intel/schema.js';
import { InsightsStore } from './intel/store.js';

const CHAT_TOPIC = 'lk.chat';
/** Live notes for the meeting UI's Insights panel. */
const INSIGHTS_TOPIC = 'aumeet.insights';
/** Live captions of what people say (the AI's own speech goes out on lk.transcription). */
const CAPTIONS_TOPIC = 'aumeet.captions';
const CAPTION_THROTTLE_MS = 250;
/** Participant attribute: 'off' = this person opted out of transcription (set in the lobby or the room). */
const TRANSCRIBE_ATTR = 'aumeet.transcribe';
/** Participant attribute: '1' = several people speak through this device (enables speaker separation). */
const SHARED_ATTR = 'aumeet.shared';
/** How long the AI stays after the last person leaves (they may just be reconnecting). */
const EMPTY_ROOM_GRACE_MS = 60_000;
/** Keep the model's view of the meeting bounded. */
const MAX_CONTEXT_ITEMS = 120;

interface ProcData extends Record<string, unknown> {
  vad: VAD;
}

interface DispatchInfo extends MeetingInfo {
  /** Host setting: may the AI speak up without being asked? */
  proactive: boolean;
}

function parseDispatch(raw: string | undefined, roomName: string): DispatchInfo {
  try {
    const m = JSON.parse(raw || '{}') as Partial<DispatchInfo>;
    return { meetingCode: m.meetingCode ?? roomName, title: m.title ?? 'Meeting', proactive: m.proactive !== false };
  } catch {
    return { meetingCode: roomName, title: 'Meeting', proactive: true };
  }
}

/** Account id from the token identity only; names only as the server signed them (see identity.ts). */
const who = (p: RemoteParticipant) => verifyParticipant(config().LIVEKIT_API_SECRET, p);
const userIdOf = (p: RemoteParticipant): string | null => who(p).userId;

const isHuman = (p: RemoteParticipant) => p.kind !== ParticipantKind.AGENT;
const transcribeAllowed = (p: RemoteParticipant) => p.attributes?.[TRANSCRIBE_ATTR] !== 'off';
const isSharedDevice = (p: RemoteParticipant) => p.attributes?.[SHARED_ATTR] === '1';
const nameOf = (p: RemoteParticipant) => who(p).name;

export default defineAgent<ProcData>({
  // Load the voice-activity model once per worker process, not per meeting.
  prewarm: async (proc: JobProcess<ProcData>) => {
    proc.userData.vad = await silero.VAD.load({
      // Ignore coughs and short "mm-hm"s so they don't cut the AI off.
      minSpeechDuration: 250,
      minSilenceDuration: 500,
    });
  },

  entry: async (ctx: JobContext<ProcData>) => {
    const cfg = config();
    const logger = log().child({ room: ctx.room.name });
    const info = parseDispatch(ctx.job.metadata, ctx.job.room?.name ?? 'unknown');
    const models = parseModels(cfg.GEMINI_MODEL, cfg.GEMINI_FALLBACK_MODELS);
    const structured = geminiStructured({ apiKey: cfg.GOOGLE_API_KEY, models, thinking: cfg.GEMINI_THINKING });

    // ---------- models ----------
    // Speech-to-text gets the AI's configured name as a key term (set once the behaviour is loaded).
    const makeStt = (keyterm: string[], diarize: boolean) =>
      new deepgram.STT({
        apiKey: cfg.DEEPGRAM_API_KEY,
        model: 'nova-3',
        language: 'multi', // automatic language detection, incl. switching mid-meeting
        smartFormat: true,
        punctuate: true,
        keyterm,
        // Speaker separation only for devices marked as shared by several people.
        ...(diarize ? { diarize: true } : {}),
      });
    let sttEngine = makeStt([], false);
    let sttShared = makeStt([], true);
    const voices = new SharedDeviceVoices();
    // Voice replies: same fast models, with automatic fallback when one is overloaded or slow.
    const voiceLlm = (model: string) =>
      new google.LLM({
        apiKey: cfg.GOOGLE_API_KEY,
        model,
        temperature: 0.4,
        ...(cfg.GEMINI_THINKING !== 'off'
          ? { thinkingConfig: { thinkingLevel: cfg.GEMINI_THINKING === 'low' ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL } }
          : {}),
      });
    const brain =
      models.length > 1
        ? new llm.FallbackAdapter({ llms: models.map(voiceLlm), attemptTimeout: Math.max(10, cfg.VOICE_LLM_TIMEOUT_SECONDS), maxRetryPerLLM: 0 })
        : voiceLlm(models[0]!);
    const voiceOut = new cartesia.TTS({
      apiKey: cfg.CARTESIA_API_KEY,
      model: cfg.CARTESIA_MODEL,
      language: 'en',
      ...(cfg.CARTESIA_VOICE_ID ? { voice: cfg.CARTESIA_VOICE_ID } : {}),
    });

    // ---------- storage ----------
    let mongo: Awaited<ReturnType<typeof connectMongo>> | null = null;
    if (cfg.MONGODB_URI) {
      try {
        mongo = await connectMongo(cfg.MONGODB_URI);
      } catch (err) {
        logger.warn({ err }, 'MongoDB unavailable – transcript and insights will not be saved');
      }
    }
    // ---------- behaviour (stored settings, not code) ----------
    let behaviour: Behaviour | null = null;
    let hostId: string | null = null;
    let learning: IntentStats[] = [];
    /** Lessons from this team's corrections of earlier notes (for the note-taker). */
    let lessons: string[] = [];
    let isWake: (text: string) => boolean = () => false;
    const applyBehaviour = (b: Behaviour | null) => {
      behaviour = b;
      if (b) {
        setAssistantName(b.name);
        // The tile shows the configured name (e.g. "Maaya"), not a hard-coded one.
        const me = ctx.room.localParticipant;
        if (me && me.name !== b.name) void me.updateName(b.name).catch(() => {});
      }
      isWake = b ? wakeMatcher(b) : () => false;
      const terms = b ? [b.name, ...b.wakeWords.filter((w) => /^[\p{Script=Latin}\s'-]+$/u.test(w))].slice(0, 20) : [];
      sttEngine = makeStt(terms, false);
      sttShared = makeStt(terms, true);
    };
    const reloadBehaviour = async () => {
      if (!mongo) return;
      try {
        const r = await loadBehaviour(mongo.db, info.meetingCode);
        hostId = r.hostId;
        applyBehaviour(r.behaviour);
        if (!r.behaviour) logger.error('no valid AI behaviour profile (ai_profiles/default) – the AI will only listen');
        if (hostId && r.behaviour?.learnFromReactions) learning = await loadLearning(mongo.db, hostId);
        if (hostId) lessons = await loadLessons(mongo.db, hostId);
      } catch (err) {
        logger.warn({ err }, 'could not load AI behaviour');
      }
    };
    await reloadBehaviour();

    const transcript = new MeetingTranscript(info.meetingCode, ctx.job.id, mongo ? new TranscriptSink(mongo.db) : null);
    const store = mongo ? new InsightsStore(mongo.db, info.meetingCode, ctx.job.id, info.title) : null;

    // Everyone who has been in the meeting, for attributing task owners.
    const people = new Map<string, Person>();
    const remember = (p: RemoteParticipant) => {
      if (isHuman(p)) people.set(p.identity, { identity: p.identity, name: nameOf(p), userId: userIdOf(p) });
    };

    // ---------- session ----------
    // Audio *input* is off: we listen to every participant ourselves (see ParticipantListener)
    // instead of linking the session to a single person. Audio *output* is the AI's voice.
    // ---------- memory of earlier sessions of this meeting link ----------
    let earlier = '';
    let prep: MeetingPrep = emptyPrep();
    let continuity: Continuity = { carryover: null, pastDecisions: [], earlierItems: [] };
    /** This meeting link plus the meeting it follows up on (host's choice in Prepare). */
    const memoryCodes = () => [info.meetingCode, ...(prep.followUpOf ? [prep.followUpOf] : [])];
    const loadMemory = async () => {
      if (!mongo) return;
      try {
        [earlier, continuity] = await Promise.all([
          earlierSessionsBrief(mongo.db, memoryCodes(), ctx.job.id),
          loadContinuity(mongo.db, memoryCodes(), ctx.job.id),
        ]);
      } catch (err) {
        logger.warn({ err }, 'could not load earlier sessions');
      }
    };
    const tools: Record<string, ReturnType<typeof llm.tool>> = {};
    if (mongo) {
      try {
        prep = await loadPrep(mongo.db, info.meetingCode);
      } catch (err) {
        logger.warn({ err }, 'could not load meeting preparation');
      }
      await loadMemory();
      logger.info(
        { followUpOf: prep.followUpOf, carryover: !!continuity.carryover, pastDecisions: continuity.pastDecisions.length },
        'continuity loaded',
      );
      const searchDocs = historySearcher(mongo.db, {
        apiKey: cfg.GOOGLE_API_KEY,
        model: cfg.EMBEDDING_MODEL,
        dims: cfg.EMBEDDING_DIMS,
        meetingCode: info.meetingCode,
        source: 'documents',
      });
      tools['search_meeting_documents'] = llm.tool({
        description:
          'Search the documents the host attached to this meeting (specs, notes, slides). Use for any question about ' +
          'their content, and say which document the answer comes from.',
        parameters: z.object({ query: z.string().describe('What to look for, e.g. "data retention period"') }),
        execute: async ({ query }) => {
          const hits = await searchDocs(query, 6);
          return hits.length ? fence('DOCUMENT EXCERPTS', hits.map((h) => h.text).join('\n\n')) : 'Nothing relevant found in the meeting documents.';
        },
      });
      const searchHistory = historySearcher(mongo.db, {
        apiKey: cfg.GOOGLE_API_KEY,
        model: cfg.EMBEDDING_MODEL,
        dims: cfg.EMBEDDING_DIMS,
        meetingCode: memoryCodes,
      });
      tools['lookup_commitments'] = llm.tool({
        description:
          'List decisions, tasks (owner, due date, open/done/overdue) and risks from earlier sessions of THIS meeting and the meeting ' +
          'it follows up on. Use for "who owns …", "what did we decide about …", "what is still pending", "what progress was made".',
        parameters: z.object({}),
        execute: async () => {
          const ledger = await commitmentsLedger(mongo!.db, memoryCodes(), ctx.job.id);
          return ledger ? fence('EARLIER DECISIONS, TASKS AND RISKS', ledger) : 'No earlier sessions with notes.';
        },
      });
      tools['search_meeting_history'] = llm.tool({
        description:
          'Search earlier sessions of THIS meeting (and of the meeting it follows up on) for what was said, decided or assigned. ' +
          'Use when someone asks about a previous session ("last week", "last time") and the answer is not in your instructions.',
        parameters: z.object({ query: z.string().describe('What to look for, e.g. "database decision"') }),
        execute: async ({ query }) => {
          const hits = await searchHistory(query);
          return hits.length ? fence('EARLIER DISCUSSION', hits.map((h) => `[${h.date}, ${h.kind}] ${h.text}`).join('\n\n')) : 'No matching discussion found in earlier sessions of this meeting.';
        },
      });
    }
    tools['set_speaking_mode'] = llm.tool({
      description:
        'Switch whether you speak up on your own. Use when someone asks you to stay quiet / stop interrupting ("quiet"), ' +
        'or to speak up / jump in again ("active"). In quiet mode you only answer when asked.',
      parameters: z.object({ mode: z.enum(['quiet', 'active']) }),
      execute: async ({ mode }) => {
        moderator.setQuiet(mode === 'quiet');
        logger.info({ mode }, 'speaking mode changed by a participant');
        return mode === 'quiet' ? 'Now quiet: answering only when asked.' : 'Speaking up again when it helps.';
      },
    });
    const composeBase = () =>
      [
        meetingInstructions(info, behaviour),
        prep && renderPrep(prep) ? fence('MEETING PREPARATION', renderPrep(prep)) : '',
        continuity.carryover ? fence('LEFT OPEN AT THE PREVIOUS MEETING', renderCarryover(continuity.carryover)) : '',
        earlier ? fence('EARLIER SESSIONS OF THIS MEETING', earlier) : '',
      ]
        .filter(Boolean)
        .join('\n\n');
    let baseInstructions = composeBase();
    let latestNotes = '';
    const refreshInstructions = () =>
      assistant
        .updateInstructions(`${baseInstructions}\n\n${notesSection(latestNotes)}`)
        .catch(() => {});
    const assistant = new voice.Agent({ instructions: `${baseInstructions}\n\n${notesSection('')}`, tools });

    // ---------- conversation intelligence ----------
    const sendInsights = (insights: Insights, to?: string[]) =>
      ctx.room.localParticipant
        ?.sendText(JSON.stringify({ type: 'insights', meetingCode: info.meetingCode, insights }), {
          topic: INSIGHTS_TOPIC,
          ...(to ? { destinationIdentities: to } : {}),
        })
        .catch((err) => logger.warn({ err }, 'could not broadcast insights'));

    const analyzer = new MeetingAnalyzer({
      title: info.title,
      transcript,
      analyze: geminiAnalyzer(structured),
      people: () => [...people.values()],
      prep: () => ({
        goal: prep.goal,
        agenda: trackedAgenda(),
        pastDecisions: continuity.pastDecisions,
        earlierItems: continuity.earlierItems,
        lessons,
      }),
      ...(behaviour
        ? {
            batchSize: (behaviour as Behaviour).engine.analysisBatchLines,
            idleMs: (behaviour as Behaviour).engine.analysisIdleSeconds * 1000,
            minIntervalMs: (behaviour as Behaviour).engine.analysisMinIntervalSeconds * 1000,
          }
        : {}),
      onUpdate: (insights) => {
        void sendInsights(insights);
        moderator.notesUpdated();
        store?.save(insights, [...people.values()]).catch((err) => logger.warn({ err }, 'could not save insights'));
        // The voice assistant answers "what did we decide?" from the same notes everyone sees.
        latestNotes = renderNotes(insights);
        void refreshInstructions();
      },
      onError: (err) => logger.warn({ err }, 'meeting analysis failed; will retry with the next batch'),
    });

    /** The host's agenda, plus "Follow-ups from last meeting" first when something was left open. */
    const trackedAgenda = () => (continuity.carryover ? [FOLLOW_UP_ITEM, ...prep.agenda] : prep.agenda);
    // Goal, agenda and follow-ups are visible (and usable by the facilitator) before the first analysis.
    const seedNotes = () =>
      analyzer.seed({
        carryover: continuity.carryover,
        goal: prep.goal,
        agenda: trackedAgenda(),
        now: new Date(),
      });
    seedNotes();

    // ---------- adaptive intervention ----------
    let lastLanguage = 'en';
    const agentIdle = () => session.agentState === 'listening' || session.agentState === 'idle';
    const presentNames = () => [...ctx.room.remoteParticipants.values()].filter(isHuman).map(nameOf);
    const moderator = new Moderator({
      enabled: info.proactive,
      title: info.title,
      brain: geminiBrain(structured),
      behaviour: () => behaviour,
      facilitator: () => prep.facilitator,
      prep: () => renderPrep(prep),
      learning: () => learning,
      insights: () => analyzer.insights,
      transcript: () => transcript.all,
      present: presentNames,
      agentIdle,
      speak: (message, d) => {
        logger.info({ intent: d.intent, key: d.topicKey, reason: d.reason }, 'speaking up');
        voiceOut.updateOptions({ language: voiceLanguage(lastLanguage) });
        session.say(message, { allowInterruptions: true });
      },
      onReaction: (r) => {
        logger.info({ intent: r.intent, reaction: r.reaction }, 'reaction to a remark');
        if (!mongo || !hostId || r.reaction === 'pending') return;
        void recordReaction(mongo.db, {
          hostId, meetingCode: info.meetingCode, sessionId: ctx.job.id, intent: r.intent, reaction: r.reaction, message: r.message, at: new Date(r.at),
        }).catch((err) => logger.warn({ err }, 'could not save reaction'));
      },
      log: (msg, data) => logger.debug(data ?? {}, msg),
    });
    const route = geminiRouter(structured);
    const session = new voice.AgentSession({ llm: brain, tts: voiceOut, vad: null, turnDetection: 'manual' });

    let lastAgentReplyAt: number | null = null;
    let lastAddressedBy: string | null = null;
    let lastAddressedName: string | null = null;
    let lastAgentText = '';

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (ev.oldState === 'speaking' && ev.newState !== 'speaking') {
        lastAgentReplyAt = Date.now();
        moderator.agentFinishedSpeaking();
      }
    });
    // Record what the AI actually said (interrupted replies are truncated to what was spoken).
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item;
      if (item.type === 'message' && item.role === 'assistant' && item.textContent) {
        lastAgentText = item.textContent;
        transcript.add({
          speakerId: ctx.room.localParticipant?.identity ?? 'agent',
          speakerName: getAssistantName(),
          userId: null,
          isAgent: true,
          channel: 'voice',
          text: item.textContent,
          language: '',
          at: Date.now(),
        });
      }
    });
    session.on(voice.AgentSessionEventTypes.Error, (ev) => logger.error({ err: ev.error }, 'session error'));

    // Serialise chat-context updates so concurrent speakers can't lose each other's lines.
    let ctxQueue: Promise<void> = Promise.resolve();
    const appendToContext = (role: 'user' | 'assistant', content: string) => {
      ctxQueue = ctxQueue
        .then(async () => {
          const chat = assistant.chatCtx.copy();
          chat.addMessage({ role, content });
          await assistant.updateChatCtx(chat.truncate(MAX_CONTEXT_ITEMS));
        })
        .catch((err) => logger.warn({ err }, 'could not update chat context'));
      return ctxQueue;
    };

    // ---------- reacting to speech ----------
    const onSpeechStart = (p: RemoteParticipant) => {
      moderator.humanSpeechStarted(p.identity);
      // Full duplex: anyone starting to talk stops the AI immediately.
      if (session.agentState === 'speaking' || session.agentState === 'thinking') {
        logger.debug({ who: p.identity }, 'interrupted by participant');
        try {
          session.interrupt().await.catch(() => {});
        } catch {
          /* nothing interruptible right now */
        }
      }
    };

    const onUtterance = async (p: RemoteParticipant, text: string, language: string, voice: string | null = null, speechMs = 0) => {
      const now = Date.now();
      // On a shared device each voice is its own speaker ("Room laptop (voice 2)" or the name they gave).
      const who = voices.label(p.identity, nameOf(p), voice, text);
      const speakerKey = voice === null ? p.identity : `${p.identity}#voice${voice}`;
      transcript.add({
        speakerId: speakerKey,
        speakerName: who,
        // A voice on a shared device may not be the account holder.
        userId: voice === null ? userIdOf(p) : null,
        isAgent: false,
        channel: 'voice',
        text,
        language,
        at: now,
        ...(speechMs > 0 ? { durationMs: speechMs } : {}),
      });
      await appendToContext('user', `${who}: ${text}`);
      analyzer.notify();
      moderator.lineAdded();
      if (language) lastLanguage = language;
      const line = transcript.all[transcript.all.length - 1]!;

      const answer = (why: string) => {
        lastAddressedBy = speakerKey;
        lastAddressedName = who;
        voiceOut.updateOptions({ language: voiceLanguage(language) });
        session.generateReply({ instructions: replyInstruction(who, languageName(language), why), allowInterruptions: true });
      };

      // Fast path: the configured name (or one of its spellings) was said.
      if (isWake(text)) return answer('they addressed you by name');
      if (!behaviour) return;

      // Otherwise the model judges from context: follow-up, misheard name, question to the room.
      try {
        const d = await route({
          line,
          recent: transcript.all.slice(-12),
          behaviour,
          answerRoomQuestions: prep.replyMode === 'any',
          lastAnswer:
            lastAgentReplyAt !== null && lastAddressedName
              ? { to: lastAddressedName, text: lastAgentText, secondsAgo: Math.round((Date.now() - lastAgentReplyAt) / 1000) }
              : null,
          participants: [...people.values()].map((x) => x.name),
          peoplePresent: presentNames().length,
        });
        logger.debug({ respond: d.respond, kind: d.kind, reason: d.reason }, 'route');
        // Only if nobody has said anything since and the AI is free – otherwise the moment has passed.
        const latest = transcript.all.filter((u) => !u.isAgent).at(-1);
        if (!d.respond || latest?.id !== line.id || !agentIdle()) return;
        answer(d.kind === 'follow_up' ? 'following up on your last answer' : d.kind === 'room_question' ? 'they asked the room a question you can answer' : 'they are talking to you');
      } catch (err) {
        logger.debug({ err }, 'routing failed');
      }
    };

    // ---------- chat ----------
    ctx.room.registerTextStreamHandler(CHAT_TOPIC, async (reader, from) => {
      const text = (await reader.readAll()).trim();
      const p = ctx.room.remoteParticipants.get(from.identity);
      if (!text || !p || !isHuman(p) || !transcribeAllowed(p)) return;
      transcript.add({
        speakerId: p.identity,
        speakerName: nameOf(p),
        userId: userIdOf(p),
        isAgent: false,
        channel: 'chat',
        text,
        language: '',
        at: Date.now(),
      });
      remember(p);
      await appendToContext('user', `${nameOf(p)} (in chat): ${text}`);
      analyzer.notify();
      if (isWake(text) || /^@ai\b/i.test(text)) return replyInChat(nameOf(p));
      if (!behaviour) return;
      // Like speech: the model judges whether the message is meant for the AI (a question while alone with it,
      // a follow-up to its last answer, a misspelled name …).
      const line = transcript.all[transcript.all.length - 1]!;
      try {
        const d = await route({
          line,
          recent: transcript.all.slice(-12),
          behaviour,
          answerRoomQuestions: prep.replyMode === 'any',
          lastAnswer:
            lastAgentReplyAt !== null && lastAddressedName
              ? { to: lastAddressedName, text: lastAgentText, secondsAgo: Math.round((Date.now() - lastAgentReplyAt) / 1000) }
              : null,
          participants: [...people.values()].map((x) => x.name),
          peoplePresent: presentNames().length,
        });
        logger.debug({ respond: d.respond, kind: d.kind, reason: d.reason, channel: 'chat' }, 'route');
        if (d.respond) await replyInChat(nameOf(p));
      } catch (err) {
        logger.debug({ err }, 'chat routing failed');
      }
    });

    const replyInChat = async (speaker: string) => {
      try {
        const chat = assistant.chatCtx.copy();
        chat.addMessage({ role: 'system', content: `${baseInstructions}\n\n${notesSection(latestNotes)}` });
        chat.addMessage({ role: 'system', content: chatReplyInstruction(speaker) });
        let out = '';
        for await (const chunk of brain.chat({ chatCtx: chat })) out += chunk.delta?.content ?? '';
        out = out.trim();
        if (!out) return;
        await ctx.room.localParticipant?.sendText(out, { topic: CHAT_TOPIC });
        await appendToContext('assistant', `(in chat) ${out}`);
        transcript.add({
          speakerId: ctx.room.localParticipant?.identity ?? 'agent',
          speakerName: getAssistantName(),
          userId: null,
          isAgent: true,
          channel: 'chat',
          text: out,
          language: '',
          at: Date.now(),
        });
      } catch (err) {
        logger.error({ err }, 'chat reply failed');
      }
    };

    // ---------- participants ----------
    const listeners = new Map<string, ParticipantListener>();
    let greeted = false;
    let emptyTimer: NodeJS.Timeout | null = null;

    const humansPresent = () => [...ctx.room.remoteParticipants.values()].some(isHuman);

    const greetOnce = () => {
      if (greeted || !humansPresent()) return;
      greeted = true;
      if (analyzer.insights.carryover) void sendInsights(analyzer.insights);
      // Whether and how to introduce itself (or open the meeting as facilitator) is the brain's call.
      moderator.start();
    };

    // ---------- live captions ----------
    // Partial text is throttled per speaker; every utterance ends with a final caption.
    const captionSeq = new Map<string, number>();
    const lastPartialAt = new Map<string, number>();
    const sendCaption = (p: RemoteParticipant, text: string, final: boolean) => {
      const seq = captionSeq.get(p.identity) ?? 0;
      if (!final) {
        const now = Date.now();
        if (now - (lastPartialAt.get(p.identity) ?? 0) < CAPTION_THROTTLE_MS) return;
        lastPartialAt.set(p.identity, now);
      } else {
        captionSeq.set(p.identity, seq + 1);
        lastPartialAt.delete(p.identity);
      }
      void ctx.room.localParticipant
        ?.sendText(JSON.stringify({ id: `${p.identity}#${seq}`, identity: p.identity, name: nameOf(p), text, final }), {
          topic: CAPTIONS_TOPIC,
        })
        .catch(() => {});
    };

    const listen = (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
      if (track.kind !== TrackKind.KIND_AUDIO || pub.source !== TrackSource.SOURCE_MICROPHONE || !isHuman(p)) return;
      remember(p);
      // Privacy opt-out: their audio is not processed at all (no transcript, notes or captions).
      if (!transcribeAllowed(p)) {
        stopListening(p.identity);
        logger.info({ who: p.identity }, 'participant opted out of transcription');
        return;
      }
      listeners.get(p.identity)?.close();
      listeners.set(
        p.identity,
        new ParticipantListener(p, track, isSharedDevice(p) ? sttShared : sttEngine, ctx.proc.userData.vad, {
          onSpeechStart: () => onSpeechStart(p),
          onSpeechEnd: () => moderator.humanSpeechEnded(p.identity),
          onPartial: (text) => sendCaption(p, text, false),
          onUtterance: (text, lang, voice, speechMs) => {
            sendCaption(p, text, true);
            void onUtterance(p, text, lang, voice, speechMs);
          },
        }),
      );
      logger.info({ who: p.identity }, 'listening to participant');
    };

    const stopListening = (identity: string) => {
      listeners.get(identity)?.close();
      listeners.delete(identity);
    };

    /** Start listening again to someone whose mic track is already subscribed (e.g. they opted back in). */
    const relisten = (p: RemoteParticipant) => {
      for (const pub of p.trackPublications.values()) {
        if (pub.track && pub.source === TrackSource.SOURCE_MICROPHONE) listen(pub.track as RemoteTrack, pub as RemoteTrackPublication, p);
      }
    };

    // Host toggled "AI can speak up on its own" during the meeting.
    let lastPrepVersion: number | null = null;
    const applyRoomSettings = (raw: string | undefined) => {
      try {
        const s = JSON.parse(raw || '{}') as { aiProactive?: boolean; aiReplyMode?: string; aiFacilitator?: boolean; prepVersion?: number };
        if (s.aiReplyMode === 'any' || s.aiReplyMode === 'named') prep.replyMode = s.aiReplyMode;
        if (typeof s.aiFacilitator === 'boolean' && s.aiFacilitator !== prep.facilitator) {
          prep.facilitator = s.aiFacilitator;
          baseInstructions = composeBase();
          void refreshInstructions();
          logger.info({ facilitator: s.aiFacilitator }, 'facilitator mode changed by host');
        }
        if (typeof s.prepVersion === 'number' && s.prepVersion !== lastPrepVersion && mongo) {
          lastPrepVersion = s.prepVersion;
          void loadPrep(mongo.db, info.meetingCode)
            .then(async (p) => {
              const followUpChanged = p.followUpOf !== prep.followUpOf;
              prep = { ...p, replyMode: prep.replyMode };
              if (followUpChanged) await loadMemory();
              await reloadBehaviour();
              seedNotes();
              void sendInsights(analyzer.insights);
              baseInstructions = composeBase();
              void refreshInstructions();
              logger.info({ goal: !!p.goal, agenda: p.agenda.length, documents: p.documents.length }, 'meeting preparation reloaded');
            })
            .catch((err) => logger.warn({ err }, 'could not reload meeting preparation'));
        }
        if (typeof s.aiProactive === 'boolean' && s.aiProactive !== moderator.isEnabled) {
          moderator.setEnabled(s.aiProactive);
          logger.info({ proactive: s.aiProactive }, 'proactive mode changed by host');
        }
      } catch {
        /* not our metadata */
      }
    };

    ctx.room
      .on(RoomEvent.TrackSubscribed, (track, pub, p) => {
        listen(track, pub, p);
        greetOnce();
      })
      .on(RoomEvent.ParticipantAttributesChanged, (changed, p) => {
        if (!(TRANSCRIBE_ATTR in changed || SHARED_ATTR in changed) || p.identity === ctx.room.localParticipant?.identity) return;
        const rp = ctx.room.remoteParticipants.get(p.identity);
        if (!rp) return;
        if (SHARED_ATTR in changed) voices.forget(rp.identity);
        if (transcribeAllowed(rp)) relisten(rp); // also switches diarization on/off
        else stopListening(rp.identity);
      })
      .on(RoomEvent.RoomMetadataChanged, (metadata) => applyRoomSettings(metadata))
      .on(RoomEvent.TrackUnsubscribed, (_track, pub, p) => {
        if (pub.source === TrackSource.SOURCE_MICROPHONE) stopListening(p.identity);
      })
      .on(RoomEvent.ParticipantConnected, (p) => {
        if (emptyTimer) clearTimeout(emptyTimer);
        emptyTimer = null;
        remember(p);
        // Late joiners get the notes so far right away.
        if (isHuman(p) && (analyzer.insights.analyzedThrough > 0 || analyzer.insights.carryover)) {
          void sendInsights(analyzer.insights, [p.identity]);
        }
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        stopListening(p.identity);
        moderator.participantLeft(p.identity);
        if (!humansPresent() && !emptyTimer) {
          emptyTimer = setTimeout(() => {
            if (!humansPresent()) ctx.shutdown('everyone left');
          }, EMPTY_ROOM_GRACE_MS);
        }
      });

    const tickTimer = setInterval(() => moderator.tick(), 2_000);
    ctx.addShutdownCallback(async () => {
      clearInterval(tickTimer);
      if (emptyTimer) clearTimeout(emptyTimer);
      moderator.stop();
      for (const l of listeners.values()) l.close();
      listeners.clear();
      // Final notes + summary for the dashboard.
      try {
        const final = await analyzer.finish();
        if (final.analyzedThrough > 0) await store?.save(final, [...people.values()], { ended: true });
      } catch (err) {
        logger.warn({ err }, 'final analysis failed');
      }
      await mongo?.close();
    });

    // Handlers are attached first so no early tracks are missed.
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    await session.start({
      agent: assistant,
      room: ctx.room,
      inputOptions: { audioEnabled: false, textEnabled: false, closeOnDisconnect: false },
      outputOptions: { audioEnabled: true, transcriptionEnabled: true },
    });

    applyRoomSettings(ctx.room.metadata);
    if (behaviour && ctx.room.localParticipant?.name !== (behaviour as Behaviour).name) {
      await ctx.room.localParticipant?.updateName((behaviour as Behaviour).name).catch((err: unknown) => logger.debug({ err }, 'could not set the AI name'));
    }

    // Pick up anyone whose tracks were subscribed during connect (and count everyone present as attending).
    for (const p of ctx.room.remoteParticipants.values()) {
      remember(p);
      for (const pub of p.trackPublications.values()) {
        if (pub.track && !listeners.has(p.identity)) listen(pub.track as RemoteTrack, pub as RemoteTrackPublication, p);
      }
    }
    greetOnce();
    logger.info({ meeting: info.meetingCode }, 'AI joined');
  },
});

// Accept every dispatch with a friendly display name for the tile in the meeting UI.
const requestFunc = async (req: JobRequest) => {
  await req.accept(AGENT_DISPLAY_NAME);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = config();
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: cfg.AGENT_NAME,
      requestFunc,
      wsURL: cfg.LIVEKIT_URL,
      apiKey: cfg.LIVEKIT_API_KEY,
      apiSecret: cfg.LIVEKIT_API_SECRET,
    }),
  );
}
