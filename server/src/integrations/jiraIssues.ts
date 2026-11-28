import { callJson, IntegrationError } from './errors.js';
import { jiraConnection, jiraRequest, type JiraSecret } from './projectTools.js';

/*
 * Full Jira issues (bugs, stories, tasks) for the conversational workflow: rich fields, Atlassian Document Format
 * description with sections, assignee lookup, attachments, and a search for likely duplicates. Optional fields the
 * project doesn't support (priority, components, assignee …) are dropped and the request retried once, so a ticket
 * is never lost because one field doesn't exist on that screen.
 */

export interface IssueFields {
  summary?: string;
  description?: string;
  priority?: string;
  severity?: string;
  component?: string;
  environment?: string;
  assignee?: string;
  labels?: string[];
  acceptanceCriteria?: string[];
  stepsToReproduce?: string[];
  expected?: string;
  actual?: string;
  userRole?: string;
  goal?: string;
  benefit?: string;
}

export type IssueType = 'bug' | 'story' | 'task';

type Node = Record<string, unknown>;
const text = (t: string): Node => ({ type: 'text', text: t });
const para = (t: string): Node => ({ type: 'paragraph', content: [text(t)] });
const heading = (t: string): Node => ({ type: 'heading', attrs: { level: 3 }, content: [text(t)] });
const list = (items: string[], ordered = false): Node => ({
  type: ordered ? 'orderedList' : 'bulletList',
  content: items.map((i) => ({ type: 'listItem', content: [para(i)] })),
});

/** The description as Jira expects it: sections for steps, expected/actual, environment, acceptance criteria. */
export function descriptionAdf(type: IssueType, f: IssueFields, extra: { meetingLink?: string; evidenceNote?: string } = {}): Node {
  const content: Node[] = [];
  if (type === 'story' && (f.userRole || f.goal || f.benefit)) {
    content.push(para(`As ${f.userRole || 'a user'}, I want ${f.goal || '…'}${f.benefit ? `, so that ${f.benefit}` : ''}.`));
  }
  if (f.description) for (const line of f.description.split('\n').filter(Boolean)) content.push(para(line));
  if (f.stepsToReproduce?.length) content.push(heading('Steps to reproduce'), list(f.stepsToReproduce, true));
  if (f.expected) content.push(heading('Expected result'), para(f.expected));
  if (f.actual) content.push(heading('Actual result'), para(f.actual));
  if (f.environment) content.push(heading('Environment'), para(f.environment));
  if (f.severity) content.push(heading('Severity'), para(f.severity));
  if (f.acceptanceCriteria?.length) content.push(heading('Acceptance criteria'), list(f.acceptanceCriteria));
  if (extra.evidenceNote) content.push(para(extra.evidenceNote));
  if (extra.meetingLink) content.push(para(`Created by AuMeet from a meeting: ${extra.meetingLink}`));
  return { type: 'doc', version: 1, content: content.length ? content : [para(f.summary ?? '')] };
}

const PRIORITY: Record<string, string> = { highest: 'Highest', critical: 'Highest', blocker: 'Highest', high: 'High', medium: 'Medium', normal: 'Medium', low: 'Low', lowest: 'Lowest', trivial: 'Lowest' };
const TYPE_NAMES: Record<IssueType, string[]> = { bug: ['Bug', 'Defect'], story: ['Story', 'User Story'], task: ['Task'] };

/** The project's issue type that matches (falls back to Task). */
async function issueTypeFor(s: JiraSecret, projectKey: string, type: IssueType): Promise<{ name: string; exact: boolean }> {
  try {
    const r = await jiraRequest(s, `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?maxResults=50`);
    const names = ((r['issueTypes'] ?? r['values']) as Array<{ name: string }> | undefined)?.map((t) => t.name) ?? [];
    const hit = TYPE_NAMES[type].find((n) => names.some((x) => x.toLowerCase() === n.toLowerCase()));
    if (hit) return { name: names.find((x) => x.toLowerCase() === hit.toLowerCase())!, exact: true };
    return { name: names.find((x) => x.toLowerCase() === 'task') ?? names[0] ?? 'Task', exact: false };
  } catch {
    return { name: TYPE_NAMES[type][0]!, exact: true };
  }
}

async function accountIdFor(s: JiraSecret, who: string): Promise<string | null> {
  try {
    const r = await callJson<Array<{ accountId: string; displayName?: string }>>(
      `https://${s.site}/rest/api/3/user/search?query=${encodeURIComponent(who)}&maxResults=2`,
      { headers: { Authorization: `Basic ${Buffer.from(`${s.email}:${s.token}`).toString('base64')}`, Accept: 'application/json' } },
      'Jira',
    );
    return r.length === 1 ? r[0]!.accountId : null; // ambiguous → leave unassigned
  } catch {
    return null;
  }
}

export interface CreatedIssue {
  key: string;
  id: string;
  url: string;
  /** Optional fields Jira refused (left out). */
  dropped: string[];
}

/** Create the issue; unsupported optional fields are removed and the call retried once. */
export async function createJiraIssue(
  hostId: string,
  type: IssueType,
  f: IssueFields,
  extra: { meetingLink?: string; evidenceNote?: string } = {},
): Promise<CreatedIssue> {
  const conn = await jiraConnection(hostId);
  if (!conn) throw new IntegrationError('Jira is not connected for this meeting\'s host', false, true);
  const projectKey = conn.config['projectKey'];
  if (!projectKey) throw new IntegrationError('Choose a Jira project in Account → Integrations first', false);
  const s = conn.secret;
  const issueType = await issueTypeFor(s, projectKey, type);
  const assignee = f.assignee ? await accountIdFor(s, f.assignee) : null;
  const fields: Record<string, unknown> = {
    project: { key: projectKey },
    issuetype: { name: issueType.name },
    summary: (f.summary ?? '').slice(0, 250),
    description: descriptionAdf(type, f, { ...extra, ...(issueType.exact ? {} : { evidenceNote: [extra.evidenceNote, `Requested as a ${type}.`].filter(Boolean).join(' ') }) }),
    labels: [...new Set(['aumeet', ...(f.labels ?? [])].map((l) => l.trim().replace(/\s+/g, '-')).filter(Boolean))].slice(0, 10),
    ...(f.priority && PRIORITY[f.priority.toLowerCase()] ? { priority: { name: PRIORITY[f.priority.toLowerCase()] } } : {}),
    ...(f.component ? { components: [{ name: f.component }] } : {}),
    ...(assignee ? { assignee: { accountId: assignee } } : {}),
  };
  const dropped: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await jiraRequest(s, '/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields }) });
      const key = String(r['key']);
      return { key, id: String(r['id']), url: `https://${s.site}/browse/${key}`, dropped };
    } catch (err) {
      // 400 with field errors: drop the optional fields Jira rejected and try once more.
      const msg = String((err as Error).message);
      const optional = ['priority', 'components', 'assignee', 'labels'].filter((k) => k in fields && new RegExp(k, 'i').test(msg));
      if (attempt === 0 && /answered 400/.test(msg) && optional.length) {
        for (const k of optional) {
          delete fields[k];
          dropped.push(k);
        }
        continue;
      }
      throw err;
    }
  }
  throw new IntegrationError('Jira did not create the issue', false);
}

/** Attach a file (Jira wants multipart + the no-check header). */
export async function attachToJira(hostId: string, key: string, file: { name: string; mime: string; data: Buffer }): Promise<void> {
  const conn = await jiraConnection(hostId);
  if (!conn) throw new IntegrationError('Jira is not connected', false, true);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file.data)], { type: file.mime }), file.name);
  await callJson(
    `https://${conn.secret.site}/rest/api/3/issue/${encodeURIComponent(key)}/attachments`,
    {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${conn.secret.email}:${conn.secret.token}`).toString('base64')}`, 'X-Atlassian-Token': 'no-check', Accept: 'application/json' },
      body: form,
    },
    'Jira',
  );
}

/** Open issues in the project that look like this one (for duplicate warnings). */
export async function similarJiraIssues(hostId: string, summary: string, max = 5): Promise<Array<{ key: string; summary: string; url: string }>> {
  const conn = await jiraConnection(hostId);
  const projectKey = conn?.config['projectKey'];
  if (!conn || !projectKey) return [];
  const words = summary
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6);
  if (!words.length) return [];
  const jql = `project = "${projectKey.replace(/"/g, '')}" AND statusCategory != Done AND (${words.map((w) => `summary ~ "${w}"`).join(' OR ')}) ORDER BY created DESC`;
  try {
    const r = await jiraRequest(conn.secret, '/rest/api/3/search/jql', { method: 'POST', body: JSON.stringify({ jql, maxResults: max, fields: ['summary'] }) });
    return ((r['issues'] as Array<{ key: string; fields: { summary: string } }>) ?? []).map((i) => ({
      key: i.key, summary: i.fields.summary, url: `https://${conn.secret.site}/browse/${i.key}`,
    }));
  } catch {
    return [];
  }
}
