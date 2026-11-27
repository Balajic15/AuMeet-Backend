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
import { isAddressedToAgent, mentionsAgent, proactivityCommand } from './addressing.js';
import { geminiStructured } from './gemini.js';
import { InterventionController } from './intervene/controller.js';
import { geminiJudge } from './intervene/judge.js';
import { AGENT_DISPLAY_NAME, config } from './config.js';
import { languageName, voiceLanguage } from './language.js';
import { ParticipantListener } from './listener.js';
import { GREETING, chatReplyInstruction, meetingInstructions, replyInstruction, type MeetingInfo } from './prompts.js';
import { MeetingTranscript, TranscriptSink } from './transcript.js';
import { connectMongo } from './db.js';
import { earlierSessionsBrief, historySearcher } from './memory.js';
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

function userIdOf(p: RemoteParticipant): string | null {
  try {
    return (JSON.parse(p.metadata || '{}') as { userId?: string | null }).userId ?? null;
  } catch {
    return null;
  }
}

const isHuman = (p: RemoteParticipant) => p.kind !== ParticipantKind.AGENT;
const transcribeAllowed = (p: RemoteParticipant) => p.attributes?.[TRANSCRIBE_ATTR] !== 'off';
const nameOf = (p: RemoteParticipant) => p.name || p.identity;

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
    const structured = geminiStructured(cfg.GOOGLE_API_KEY, cfg.GEMINI_MODEL);

    // ---------- models ----------
    const sttEngine = new deepgram.STT({
      apiKey: cfg.DEEPGRAM_API_KEY,
      model: 'nova-3',
      language: 'multi', // automatic language detection, incl. switching mid-meeting
      smartFormat: true,
      punctuate: true,
      keyterm: ['AuMeet'],
    });
    const brain = new google.LLM({ apiKey: cfg.GOOGLE_API_KEY, model: cfg.GEMINI_MODEL, temperature: 0.4 });
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
    const tools: Record<string, ReturnType<typeof llm.tool>> = {};
    if (mongo) {
      try {
        earlier = await earlierSessionsBrief(mongo.db, info.meetingCode, ctx.job.id);
      } catch (err) {
        logger.warn({ err }, 'could not load earlier sessions');
      }
      const searchHistory = historySearcher(mongo.db, {
        apiKey: cfg.GOOGLE_API_KEY,
        model: cfg.EMBEDDING_MODEL,
        dims: cfg.EMBEDDING_DIMS,
        meetingCode: info.meetingCode,
      });
      tools['search_meeting_history'] = llm.tool({
        description:
          'Search earlier sessions of THIS meeting (same meeting link) for what was said, decided or assigned. ' +
          'Use when someone asks about a previous session ("last week", "last time") and the answer is not in your instructions.',
        parameters: z.object({ query: z.string().describe('What to look for, e.g. "database decision"') }),
        execute: async ({ query }) => {
          const hits = await searchHistory(query);
          return hits.length ? hits : 'No matching discussion found in earlier sessions of this meeting.';
        },
      });
    }
    const baseInstructions = earlier ? `${meetingInstructions(info)}\n\n${earlier}` : meetingInstructions(info);
    const assistant = new voice.Agent({ instructions: baseInstructions, tools });

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
      onUpdate: (insights) => {
        void sendInsights(insights);
        intervention.notesUpdated();
        store?.save(insights, [...people.values()]).catch((err) => logger.warn({ err }, 'could not save insights'));
        // The voice assistant answers "what did we decide?" from the same notes everyone sees.
        const notes = renderNotes(insights);
        void assistant
          .updateInstructions(notes ? `${baseInstructions}\n\nCURRENT MEETING NOTES\n${notes}` : baseInstructions)
          .catch(() => {});
      },
      onError: (err) => logger.warn({ err }, 'meeting analysis failed; will retry with the next batch'),
    });

    // ---------- adaptive intervention ----------
    let lastLanguage = 'en';
    const agentIdle = () => session.agentState === 'listening' || session.agentState === 'idle';
    const intervention = new InterventionController({
      enabled: info.proactive,
      judge: geminiJudge(structured),
      insights: () => analyzer.insights,
      transcript: () => transcript.all,
      agentIdle,
      speak: (message, candidate) => {
        logger.info({ kind: candidate.kind, key: candidate.key }, 'speaking up proactively');
        voiceOut.updateOptions({ language: voiceLanguage(lastLanguage) });
        session.say(message, { allowInterruptions: true });
      },
      log: (msg, data) => logger.debug(data ?? {}, msg),
    });
    const session = new voice.AgentSession({ llm: brain, tts: voiceOut, vad: null, turnDetection: 'manual' });

    let lastAgentReplyAt: number | null = null;
    let lastAddressedBy: string | null = null;

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (ev.oldState === 'speaking' && ev.newState !== 'speaking') {
        lastAgentReplyAt = Date.now();
        intervention.agentFinishedSpeaking();
      }
    });
    // Record what the AI actually said (interrupted replies are truncated to what was spoken).
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item;
      if (item.type === 'message' && item.role === 'assistant' && item.textContent) {
        transcript.add({
          speakerId: ctx.room.localParticipant?.identity ?? 'agent',
          speakerName: AGENT_DISPLAY_NAME,
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
      intervention.humanSpeechStarted(p.identity);
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

    const onUtterance = async (p: RemoteParticipant, text: string, language: string) => {
      const now = Date.now();
      transcript.add({
        speakerId: p.identity,
        speakerName: nameOf(p),
        userId: userIdOf(p),
        isAgent: false,
        channel: 'voice',
        text,
        language,
        at: now,
      });
      await appendToContext('user', `${nameOf(p)}: ${text}`);
      analyzer.notify();
      if (language) lastLanguage = language;

      // "AuMeet, stay quiet" / "AuMeet, you can speak up again"
      const command = proactivityCommand(text);
      if (command) {
        intervention.setQuiet(command === 'quiet');
        voiceOut.updateOptions({ language: voiceLanguage(language) });
        session.generateReply({
          instructions:
            command === 'quiet'
              ? `${nameOf(p)} asked you to stop speaking up on your own. Briefly acknowledge in ${languageName(language)} that you'll only speak when someone asks you.`
              : `${nameOf(p)} said you may speak up again. Briefly acknowledge in ${languageName(language)} that you'll speak up when something needs attention.`,
          allowInterruptions: true,
        });
        return;
      }

      const { addressed, reason } = isAddressedToAgent(text, p.identity, now, { lastAgentReplyAt, lastAddressedBy });
      if (!addressed || !reason) return;

      lastAddressedBy = p.identity;
      voiceOut.updateOptions({ language: voiceLanguage(language) });
      session.generateReply({
        instructions: replyInstruction(nameOf(p), languageName(language), reason),
        allowInterruptions: true,
      });
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
      if (mentionsAgent(text) || /^@ai\b/i.test(text)) await replyInChat(nameOf(p));
    });

    const replyInChat = async (speaker: string) => {
      try {
        const chat = assistant.chatCtx.copy();
        chat.addMessage({ role: 'system', content: baseInstructions });
        chat.addMessage({ role: 'system', content: chatReplyInstruction(speaker) });
        let out = '';
        for await (const chunk of brain.chat({ chatCtx: chat })) out += chunk.delta?.content ?? '';
        out = out.trim();
        if (!out) return;
        await ctx.room.localParticipant?.sendText(out, { topic: CHAT_TOPIC });
        await appendToContext('assistant', `(in chat) ${out}`);
        transcript.add({
          speakerId: ctx.room.localParticipant?.identity ?? 'agent',
          speakerName: AGENT_DISPLAY_NAME,
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
      session.say(GREETING, { allowInterruptions: true });
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
        new ParticipantListener(p, track, sttEngine, ctx.proc.userData.vad, {
          onSpeechStart: () => onSpeechStart(p),
          onSpeechEnd: () => intervention.humanSpeechEnded(p.identity),
          onPartial: (text) => sendCaption(p, text, false),
          onUtterance: (text, lang) => {
            sendCaption(p, text, true);
            void onUtterance(p, text, lang);
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
    const applyRoomSettings = (raw: string | undefined) => {
      try {
        const s = JSON.parse(raw || '{}') as { aiProactive?: boolean };
        if (typeof s.aiProactive === 'boolean' && s.aiProactive !== intervention.isEnabled) {
          intervention.setEnabled(s.aiProactive);
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
        if (!(TRANSCRIBE_ATTR in changed) || p.identity === ctx.room.localParticipant?.identity) return;
        const rp = ctx.room.remoteParticipants.get(p.identity);
        if (!rp) return;
        if (transcribeAllowed(rp)) relisten(rp);
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
        if (isHuman(p) && analyzer.insights.analyzedThrough > 0) void sendInsights(analyzer.insights, [p.identity]);
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        stopListening(p.identity);
        intervention.participantLeft(p.identity);
        if (!humansPresent() && !emptyTimer) {
          emptyTimer = setTimeout(() => {
            if (!humansPresent()) ctx.shutdown('everyone left');
          }, EMPTY_ROOM_GRACE_MS);
        }
      });

    ctx.addShutdownCallback(async () => {
      if (emptyTimer) clearTimeout(emptyTimer);
      intervention.stop();
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

    // Pick up anyone whose tracks were subscribed during connect.
    for (const p of ctx.room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (pub.track && !listeners.has(p.identity)) listen(pub.track as RemoteTrack, pub as RemoteTrackPublication, p);
      }
    }
    greetOnce();
    logger.info({ meeting: info.meetingCode }, 'AuMeet AI joined');
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
