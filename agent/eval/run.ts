/**
 * AI quality bench – plays scripted meetings through the REAL note-taker and decision logic
 * (Gemini) and checks the results. Uses agent/.env (GOOGLE_API_KEY, GEMINI_MODEL).
 *
 *   npx tsx eval/run.ts            # all scenarios
 *   npx tsx eval/run.ts dispute    # scenarios whose name contains "dispute"
 *
 * Costs a few cents per full run. Not part of `npm test` (needs a real key, results vary).
 */
import { initializeLogger } from '@livekit/agents';
import { config } from '../src/config.js';
import { geminiStructured } from '../src/gemini.js';
import { normalize } from '../src/intel/normalize.js';
import { ANALYST_SYSTEM, analystPrompt } from '../src/intel/prompt.js';
import { emptyInsights, ModelOutput, type Insights } from '../src/intel/schema.js';
import { findCandidates } from '../src/intervene/candidates.js';
import { geminiJudge } from '../src/intervene/judge.js';
import { addressedToPerson, looksLikeQuestion, shouldAnswerQuestion } from '../src/intervene/question.js';
import type { Utterance } from '../src/transcript.js';

initializeLogger({ pretty: false, level: 'warn' });
const cfg = config();
import { parseModels } from '../src/gemini.js';
const call = geminiStructured({ apiKey: cfg.GOOGLE_API_KEY, models: parseModels(cfg.GEMINI_MODEL, cfg.GEMINI_FALLBACK_MODELS), thinking: cfg.GEMINI_THINKING });
const judge = geminiJudge(call);

// Thursday 26 Nov 2026, 10:00 UTC
const T0 = Date.UTC(2026, 10, 26, 10, 0, 0);
type Line = [speaker: string, text: string, secondsAfterStart?: number];

function script(lines: Line[]): Utterance[] {
  return lines.map(([who, text, s], i) => ({
    id: i + 1,
    speakerId: who === 'AuMeet AI' ? 'agent' : `user:${who.toLowerCase()}`,
    speakerName: who,
    userId: null,
    isAgent: who === 'AuMeet AI',
    channel: 'voice',
    text,
    language: '',
    at: T0 + (s ?? i * 20) * 1000,
  }));
}

interface Prep {
  goal?: string;
  agenda?: Array<{ id: string; title: string; minutes: number | null }>;
  pastDecisions?: Array<{ ref: string; statement: string; date: string; title: string }>;
}

/** Feed the transcript in batches of 4 lines, like the live analyzer does. */
async function analyse(lines: Utterance[], prep: Prep = {}, batch = 4): Promise<{ notes: Insights; ms: number[] }> {
  let notes = emptyInsights();
  const ms: number[] = [];
  for (let end = Math.min(batch, lines.length); ; end = Math.min(end + batch, lines.length)) {
    const seen = lines.slice(0, end);
    const t = Date.now();
    const out = await call(ModelOutput, {
      system: ANALYST_SYSTEM,
      prompt: analystPrompt({
        title: 'Team sync',
        meetingDate: new Date(T0),
        participants: [...new Set(seen.filter((u) => !u.isAgent).map((u) => u.speakerName))],
        current: notes,
        lines: seen,
        final: end === lines.length,
        goal: prep.goal,
        agenda: prep.agenda,
        pastDecisions: prep.pastDecisions,
        elapsedMinutes: Math.round((seen.at(-1)!.at - T0) / 60_000),
      }),
      temperature: 0.1,
    });
    ms.push(Date.now() - t);
    notes = normalize(notes, out, {
      validLines: new Set(seen.map((u) => u.id)),
      people: [...new Set(seen.map((u) => u.speakerName))].map((n) => ({ identity: `user:${n.toLowerCase()}`, name: n, userId: null })),
      analyzedThrough: end,
      now: new Date(seen.at(-1)!.at),
      goal: prep.goal,
      agendaPlan: prep.agenda,
      pastDecisions: prep.pastDecisions,
    });
    if (end === lines.length) break;
  }
  return { notes, ms };
}

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}
const results: Array<{ scenario: string; checks: Check[]; ms: number[] }> = [];
const check = (name: string, ok: boolean, detail?: unknown): Check => ({ name, ok, detail: ok ? undefined : JSON.stringify(detail)?.slice(0, 300) });
const has = (s: string | null | undefined, ...words: string[]) => !!s && words.every((w) => s.toLowerCase().includes(w.toLowerCase()));

const PAST = [
  { ref: 'P1', statement: 'Use PostgreSQL for the billing service', date: '2026-11-12', title: 'Billing kickoff' },
  { ref: 'P2', statement: 'Release every two weeks', date: '2026-11-12', title: 'Billing kickoff' },
];

const scenarios: Record<string, () => Promise<{ checks: Check[]; ms: number[] }>> = {
  async 'contradiction: reversing an earlier decision is flagged'() {
    const { notes, ms } = await analyse(script([
      ['Ben', 'Honestly, I think we should move billing to MongoDB instead.'],
      ['Chen', "Yeah, MongoDB would be simpler for us. Let's switch billing to MongoDB."],
      ['Asha', 'Okay, MongoDB for billing then.'],
    ]), { pastDecisions: PAST });
    const d = notes.decisions.find((x) => has(x.statement + x.options.join(' '), 'mongo'));
    return {
      ms,
      checks: [
        check('a MongoDB decision is recorded', !!d, notes.decisions),
        check('it is linked to the earlier PostgreSQL decision', d?.contradicts?.ref === 'P1', d),
        check('the release cadence is not flagged', !notes.decisions.some((x) => x.contradicts?.ref === 'P2'), notes.decisions),
      ],
    };
  },

  async 'contradiction: reconfirming the same choice is not flagged'() {
    const { notes, ms } = await analyse(script([
      ['Asha', 'Just to confirm, billing stays on PostgreSQL, right?'],
      ['Ben', 'Yes, PostgreSQL for billing, as we agreed.'],
      ['Chen', "And we'll add a read replica for reports."],
    ]), { pastDecisions: PAST });
    return { ms, checks: [check('nothing flagged as a contradiction', !notes.decisions.some((x) => x.contradicts), notes.decisions)] };
  },

  async 'dispute: "okay, let\'s proceed" is not a decision'() {
    const { notes, ms } = await analyse(script([
      ['Asha', "Let's use MongoDB for the new service."],
      ['Ben', 'I think PostgreSQL is better for our requirements, we need joins.'],
      ['Chen', "Okay, let's proceed."],
    ]));
    const d = notes.decisions.find((x) => has(x.statement + x.options.join(' '), 'mongo') || has(x.statement, 'database'));
    return {
      ms,
      checks: [
        check('a database decision is recorded', !!d, notes.decisions),
        check('it is NOT agreed', !!d && d.status !== 'agreed', d),
        check('both options listed', !!d && d.options.some((o) => has(o, 'mongo')) && d.options.some((o) => has(o, 'postgres')), d?.options),
        check('a confirmation question is prepared', !!d?.confirmationNeeded, d),
      ],
    };
  },

  async 'agreement: explicit consensus becomes agreed'() {
    const { notes, ms } = await analyse(script([
      ['Asha', "Let's use MongoDB."],
      ['Ben', 'PostgreSQL fits better, we need transactions across tables.'],
      ['Asha', 'Fair point. Fine, PostgreSQL it is. Everyone agree?'],
      ['Chen', 'Yes, agreed, PostgreSQL.'],
      ['Ben', 'Agreed.'],
    ]));
    const d = notes.decisions.find((x) => has(x.statement, 'postgres'));
    return {
      ms,
      checks: [
        check('PostgreSQL decision recorded', !!d, notes.decisions),
        check('status agreed', d?.status === 'agreed', d),
        check('no confirmation needed', !!d && !d.confirmationNeeded, d),
        check('no duplicate disputed DB decision left open', !notes.decisions.some((x) => x.status === 'disputed' && has(x.statement + x.options.join(' '), 'postgres')), notes.decisions),
      ],
    };
  },

  async 'tasks: owners, dates and unowned work'() {
    const { notes, ms } = await analyse(script([
      ['Asha', 'Ravi, can you write the migration plan by Friday?'],
      ['Ravi', "Sure, I'll have it done by Friday."],
      ['Asha', 'Also somebody needs to update the API docs at some point.'],
      ['Ben', "I'll book the design review for next Tuesday."],
    ]));
    const plan = notes.actionItems.find((a) => has(a.task, 'migration'));
    const docs = notes.actionItems.find((a) => has(a.task, 'doc'));
    const review = notes.actionItems.find((a) => has(a.task, 'review'));
    return {
      ms,
      checks: [
        check('migration plan owned by Ravi', plan?.owner === 'Ravi', plan),
        check('due Friday 2026-11-27', plan?.dueDate === '2026-11-27', plan),
        check('docs task has no owner', !!docs && !docs.owner, docs),
        check('Ben books review, due Tue 2026-12-01', review?.owner === 'Ben' && review?.dueDate === '2026-12-01', review),
      ],
    };
  },

  async 'proposal: unanswered suggestion stays proposed'() {
    const { notes, ms } = await analyse(script([
      ['Asha', 'I propose we ship the beta on Friday.'],
      ['Ben', 'Let me check the test results first.'],
    ]));
    const d = notes.decisions.find((x) => has(x.statement, 'ship') || has(x.statement, 'beta'));
    return { ms, checks: [check('shipping is proposed, not agreed', !!d && d.status === 'proposed', notes.decisions)] };
  },

  async 'hinglish: mixed Hindi/English dispute'() {
    const { notes, ms } = await analyse(script([
      ['Priya', 'Chalo, MongoDB use karte hain is project ke liye.'],
      ['Rahul', 'Nahi yaar, PostgreSQL zyada better hai, humein joins chahiye.'],
      ['Amit', 'Theek hai, aage badhte hain.'],
    ]));
    const d = notes.decisions.find((x) => has(x.statement + x.options.join(' '), 'mongo') || has(x.statement + x.options.join(' '), 'postgres'));
    return {
      ms,
      checks: [
        check('database decision found', !!d, notes.decisions),
        check('not agreed', !!d && d.status !== 'agreed', d),
        check('confirmation prepared', !!d?.confirmationNeeded, d),
      ],
    };
  },

  async 'goal: drifting off topic is noticed'() {
    const prep: Prep = {
      goal: 'Decide which database to use for the billing service',
      agenda: [{ id: 'a1', title: 'Database choice', minutes: 10 }, { id: 'a2', title: 'Migration owners', minutes: 5 }],
    };
    const { notes, ms } = await analyse(script([
      ['Asha', "Let's start with the database for billing.", 0],
      ['Ben', 'Before that, did anyone watch the cricket final yesterday?', 30],
      ['Chen', 'Yes! What a finish, that last over was unbelievable.', 60],
      ['Ben', 'Kohli was amazing, best innings of the season.', 120],
      ['Chen', 'And the stadium was packed, I want to go next year.', 180],
      ['Ben', 'We should plan a team trip to a match.', 240],
      ['Chen', 'Yes, maybe in March when the league starts.', 300],
      ['Ben', 'I can look up ticket prices for March.', 360],
    ]), prep);
    const a1 = notes.agenda.find((a) => a.id === 'a1');
    const notesAt = T0 + 9 * 60_000;
    const cands = findCandidates({ ...notes, goal: notes.goal && { ...notes.goal, since: new Date(T0 + 60_000).toISOString() } }, script([['Asha', 'x', 0]]), notesAt, new Set());
    return {
      ms,
      checks: [
        check('goal marked drifting/off track', notes.goal?.status === 'drifting' || notes.goal?.status === 'off_track', notes.goal),
        check('database item not done', a1?.status !== 'done', a1),
        check('a steer-back nudge is a candidate', cands.some((c) => c.kind === 'off_track'), cands.map((c) => c.kind)),
      ],
    };
  },

  async 'goal: achieved when the decision is agreed'() {
    const prep: Prep = {
      goal: 'Decide which database to use for the billing service',
      agenda: [{ id: 'a1', title: 'Database choice', minutes: 10 }],
    };
    const { notes, ms } = await analyse(script([
      ['Asha', 'Database for billing: MongoDB or PostgreSQL?'],
      ['Ben', 'PostgreSQL, billing needs strong transactions.'],
      ['Chen', 'Agreed, PostgreSQL.'],
      ['Asha', 'Great, decided: PostgreSQL for billing. Next topic.'],
    ]), prep);
    return {
      ms,
      checks: [
        check('goal achieved', notes.goal?.status === 'achieved', notes.goal),
        check('agenda item done', notes.agenda[0]?.status === 'done', notes.agenda),
      ],
    };
  },

  async 'speaking up: confirm at a real pause, not mid-debate'() {
    const lines = script([
      ['Asha', "Let's use MongoDB."],
      ['Ben', 'PostgreSQL is better for us.'],
      ['Chen', "Okay, let's proceed."],
    ]);
    const { notes, ms } = await analyse(lines);
    const cand = findCandidates(notes, lines, Date.parse(notes.decisions[0]?.firstSeenAt ?? new Date(T0).toISOString()) + 60_000, new Set())[0];
    if (!cand) return { ms, checks: [check('a confirmation candidate exists', false, notes.decisions)] };
    const t1 = Date.now();
    const atPause = await judge({ candidate: cand, insights: notes, recent: lines, silenceMs: 3000 });
    const midDebate = script([
      ...lines.map((u) => [u.speakerName, u.text] as Line),
      ['Asha', 'Wait, before we move on – Ben, why exactly PostgreSQL?'],
      ['Ben', 'Two reasons, let me explain the first one…'],
    ]);
    const busy = await judge({ candidate: cand, insights: notes, recent: midDebate, silenceMs: 1900 });
    ms.push(Date.now() - t1);
    return {
      ms,
      checks: [
        check('speaks after "let\'s proceed"', atPause.speak && !!atPause.message, atPause),
        check('asks (doesn\'t decide)', !has(atPause.message, 'we will use') && !has(atPause.message, "we'll go with"), atPause.message),
        check('stays quiet mid-explanation', !busy.speak, busy),
      ],
    };
  },

  async 'room questions: answer the room, not colleagues'() {
    const lines = script([
      ['Asha', 'We agreed PostgreSQL for billing earlier.'],
      ['Ben', 'And Ravi owns the migration plan.'],
    ]);
    const { notes, ms } = await analyse(lines);
    const ask = (q: string) => shouldAnswerQuestion(call, { question: q, speaker: 'Chen', recent: lines, insights: notes, prepSummary: '' });
    const q1 = await ask('What did we decide about the database?');
    const q2 = await ask('How was everyone\'s weekend?');
    return {
      ms,
      checks: [
        check('answers a factual question about the meeting', q1.answer, q1),
        check('ignores small talk', !q2.answer, q2),
        check('heuristic skips "Ravi, can you…"', looksLikeQuestion('Ravi, can you send the spec?') && addressedToPerson('Ravi, can you send the spec?', ['Ravi'])),
      ],
    };
  },
};

const filter = process.argv[2]?.toLowerCase();
for (const [name, run] of Object.entries(scenarios)) {
  if (filter && !name.toLowerCase().includes(filter)) continue;
  try {
    const r = await run();
    results.push({ scenario: name, ...r });
  } catch (err) {
    results.push({ scenario: name, checks: [check('scenario ran', false, String((err as Error).message ?? err))], ms: [] });
  }
}

let pass = 0;
let total = 0;
for (const r of results) {
  const ok = r.checks.every((c) => c.ok);
  const avg = r.ms.length ? Math.round(r.ms.reduce((a, b) => a + b, 0) / r.ms.length) : 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.scenario}  (avg model call ${avg} ms)`);
  for (const c of r.checks) {
    total++;
    if (c.ok) pass++;
    else console.log(`      ✗ ${c.name}: ${c.detail}`);
  }
}
const all = results.flatMap((r) => r.ms);
console.log(`\n${pass}/${total} checks passed · models ${parseModels(cfg.GEMINI_MODEL, cfg.GEMINI_FALLBACK_MODELS).join(" → ")} · thinking ${cfg.GEMINI_THINKING} · median call ${all.sort((a, b) => a - b)[Math.floor(all.length / 2)] ?? 0} ms`);
process.exit(0);
