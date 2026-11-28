import { z } from 'zod';
import { IntegrationModel, type IntegrationProvider } from '../models/Integration.js';
import { decryptSecret, encryptSecret } from '../services/secrets.js';
import { callJson, IntegrationError } from './errors.js';

/*
 * Jira, Linear and Asana with the user's own API token (no OAuth app to register):
 *   Jira   – Atlassian account email + API token (id.atlassian.com → Security → API tokens) + site
 *   Linear – personal API key (Settings → Account → Security & access)
 *   Asana  – personal access token (My Settings → Apps → Developer apps)
 * Only the providers' own API hosts are ever called; a Jira site must be <name>.atlassian.net.
 */

export type ProjectTool = Extract<IntegrationProvider, 'jira' | 'linear' | 'asana'>;
export const PROJECT_TOOLS: ProjectTool[] = ['jira', 'linear', 'asana'];

export const ConnectBody = {
  jira: z.object({
    site: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/, 'Use your Atlassian site, e.g. acme.atlassian.net'),
    email: z.email(),
    token: z.string().trim().min(10).max(500),
  }),
  linear: z.object({ apiKey: z.string().trim().min(10).max(500) }),
  asana: z.object({ token: z.string().trim().min(10).max(500) }),
} as const;

export const ConfigBody = {
  jira: z.object({ projectKey: z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,19}$/), issueType: z.string().trim().min(1).max(50).default('Task') }),
  linear: z.object({ teamId: z.string().trim().min(1).max(100) }),
  asana: z.object({ workspaceGid: z.string().regex(/^\d{1,30}$/), projectGid: z.string().regex(/^\d{1,30}$/) }),
} as const;

type JiraSecret = z.infer<(typeof ConnectBody)['jira']>;
type LinearSecret = z.infer<(typeof ConnectBody)['linear']>;
type AsanaSecret = z.infer<(typeof ConnectBody)['asana']>;

export interface TaskInput {
  title: string;
  description: string;
  dueDate: string | null;
}
export interface ExternalIssue {
  provider: ProjectTool;
  id: string;
  key: string;
  url: string;
}
export interface Choice {
  id: string;
  name: string;
  /** Asana projects belong to a workspace. */
  parent?: string;
}

// ---------- low level ----------

const jira = (s: JiraSecret, path: string, init: RequestInit = {}) =>
  callJson<Record<string, unknown>>(
    `https://${s.site}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Basic ${Buffer.from(`${s.email}:${s.token}`).toString('base64')}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    },
    'Jira',
  );

async function linear<T>(s: LinearSecret, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const out = await callJson<{ data?: T; errors?: Array<{ message: string }> }>(
    'https://api.linear.app/graphql',
    { method: 'POST', headers: { Authorization: s.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) },
    'Linear',
  );
  if (out.errors?.length || !out.data) throw new IntegrationError(`Linear: ${out.errors?.[0]?.message ?? 'no data'}`, false);
  return out.data;
}

const asana = <T>(s: AsanaSecret, path: string, init: RequestInit = {}) =>
  callJson<{ data: T }>(
    `https://app.asana.com/api/1.0${path}`,
    { ...init, headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers ?? {}) } },
    'Asana',
  ).then((r) => r.data);

/** Atlassian Document Format for a plain-text description. */
const adf = (text: string) => ({
  type: 'doc',
  version: 1,
  content: text.split('\n').filter(Boolean).map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
});

// ---------- connect / configure ----------

/** Check the credentials with a real call, then store them (encrypted). */
export async function connectProjectTool(userId: string, provider: ProjectTool, body: unknown): Promise<{ account: string }> {
  let account = '';
  let secret: unknown;
  let config: Record<string, unknown> = {};
  if (provider === 'jira') {
    const s = ConnectBody.jira.parse(body);
    const me = await jira(s, '/rest/api/3/myself');
    account = String(me['emailAddress'] ?? me['displayName'] ?? s.email);
    secret = s;
    config = { site: s.site, issueType: 'Task' };
  } else if (provider === 'linear') {
    const s = ConnectBody.linear.parse(body);
    const d = await linear<{ viewer: { name: string; email: string } }>(s, '{ viewer { name email } }');
    account = d.viewer.email || d.viewer.name;
    secret = s;
  } else {
    const s = ConnectBody.asana.parse(body);
    const me = await asana<{ email?: string; name?: string }>(s, '/users/me');
    account = me.email ?? me.name ?? '';
    secret = s;
  }
  // Only one project tool is used for follow-ups at a time: connecting one makes it the active one.
  await IntegrationModel.updateMany({ userId, provider: { $in: PROJECT_TOOLS.filter((p) => p !== provider) } }, { $set: { enabled: false } });
  await IntegrationModel.updateOne(
    { userId, provider },
    { $set: { status: 'connected', account, config, secret: encryptSecret(secret), enabled: true }, $unset: { lastError: 1 } },
    { upsert: true },
  );
  return { account };
}

async function load(userId: string, provider: ProjectTool) {
  const doc = await IntegrationModel.findOne({ userId, provider }).select('+secret');
  if (!doc) throw new IntegrationError(`${provider} is not connected`, false, true);
  return { doc, secret: decryptSecret<JiraSecret & LinearSecret & AsanaSecret>(doc.secret), config: (doc.config ?? {}) as Record<string, string> };
}

/** Projects / teams to choose where tasks go. */
export async function projectToolChoices(userId: string, provider: ProjectTool): Promise<Choice[]> {
  const { secret } = await load(userId, provider);
  if (provider === 'jira') {
    const r = await jira(secret, '/rest/api/3/project/search?maxResults=100');
    return ((r['values'] as Array<{ key: string; name: string }>) ?? []).map((p) => ({ id: p.key, name: `${p.name} (${p.key})` }));
  }
  if (provider === 'linear') {
    const d = await linear<{ teams: { nodes: Array<{ id: string; name: string; key: string }> } }>(secret, '{ teams(first: 100) { nodes { id name key } } }');
    return d.teams.nodes.map((t) => ({ id: t.id, name: `${t.name} (${t.key})` }));
  }
  const me = await asana<{ workspaces: Array<{ gid: string; name: string }> }>(secret, '/users/me?opt_fields=workspaces.name');
  const out: Choice[] = [];
  for (const w of me.workspaces.slice(0, 10)) {
    const projects = await asana<Array<{ gid: string; name: string }>>(secret, `/projects?workspace=${encodeURIComponent(w.gid)}&archived=false&limit=100`);
    out.push(...projects.map((p) => ({ id: p.gid, name: `${p.name} – ${w.name}`, parent: w.gid })));
  }
  return out;
}

export async function configureProjectTool(userId: string, provider: ProjectTool, body: unknown): Promise<void> {
  const parsed = ConfigBody[provider].parse(body);
  const { doc } = await load(userId, provider);
  await IntegrationModel.updateOne({ _id: doc._id }, { $set: { config: { ...(doc.config ?? {}), ...parsed }, enabled: true } });
}

/** The project tool follow-ups go to (connected, enabled and configured), or null. */
export async function activeProjectTool(userId: string): Promise<ProjectTool | null> {
  const docs = await IntegrationModel.find({ userId, provider: { $in: PROJECT_TOOLS }, enabled: true, status: 'connected' }).lean();
  const ready = docs.find((d) => {
    const c = (d.config ?? {}) as Record<string, string>;
    return d.provider === 'jira' ? !!c['projectKey'] : d.provider === 'linear' ? !!c['teamId'] : !!c['projectGid'];
  });
  return (ready?.provider as ProjectTool | undefined) ?? null;
}

// ---------- issues ----------

async function track<T>(userId: string, provider: ProjectTool, fn: () => Promise<T>): Promise<T> {
  try {
    const out = await fn();
    await IntegrationModel.updateOne({ userId, provider }, { $set: { lastUsedAt: new Date(), status: 'connected' }, $unset: { lastError: 1 } });
    return out;
  } catch (err) {
    if (err instanceof IntegrationError && err.reconnect) {
      await IntegrationModel.updateOne({ userId, provider }, { $set: { status: 'error', lastError: err.message } });
    }
    throw err;
  }
}

export function createIssue(userId: string, provider: ProjectTool, t: TaskInput): Promise<ExternalIssue> {
  return track(userId, provider, async () => {
    const { secret, config } = await load(userId, provider);
    if (provider === 'jira') {
      const r = await jira(secret, '/rest/api/3/issue', {
        method: 'POST',
        body: JSON.stringify({
          fields: {
            project: { key: config['projectKey'] },
            summary: t.title.slice(0, 250),
            issuetype: { name: config['issueType'] || 'Task' },
            description: adf(t.description),
            ...(t.dueDate ? { duedate: t.dueDate } : {}),
          },
        }),
      });
      const key = String(r['key']);
      return { provider, id: String(r['id']), key, url: `https://${secret.site}/browse/${key}` };
    }
    if (provider === 'linear') {
      const d = await linear<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } } }>(
        secret,
        'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }',
        { input: { teamId: config['teamId'], title: t.title.slice(0, 250), description: t.description, ...(t.dueDate ? { dueDate: t.dueDate } : {}) } },
      );
      if (!d.issueCreate.success) throw new IntegrationError('Linear did not create the issue', true);
      return { provider, id: d.issueCreate.issue.id, key: d.issueCreate.issue.identifier, url: d.issueCreate.issue.url };
    }
    const task = await asana<{ gid: string; permalink_url: string }>(secret, '/tasks?opt_fields=permalink_url', {
      method: 'POST',
      body: JSON.stringify({ data: { name: t.title.slice(0, 250), notes: t.description, projects: [config['projectGid']], ...(t.dueDate ? { due_on: t.dueDate } : {}) } }),
    });
    return { provider, id: task.gid, key: task.gid, url: task.permalink_url };
  });
}

/** Close (done) or reopen an issue when the task's status changes in AuMeet. */
export function setIssueDone(userId: string, issue: ExternalIssue, done: boolean): Promise<void> {
  return track(userId, issue.provider, async () => {
    const { secret, config } = await load(userId, issue.provider);
    if (issue.provider === 'jira') {
      const r = await jira(secret, `/rest/api/3/issue/${encodeURIComponent(issue.key)}/transitions`);
      const transitions = (r['transitions'] as Array<{ id: string; to: { statusCategory: { key: string } } }>) ?? [];
      const t = transitions.find((x) => x.to.statusCategory.key === (done ? 'done' : 'new')) ?? (done ? null : transitions.find((x) => x.to.statusCategory.key === 'indeterminate'));
      if (!t) throw new IntegrationError(`Jira has no transition to ${done ? 'done' : 'open'} for ${issue.key}`, false);
      await jira(secret, `/rest/api/3/issue/${encodeURIComponent(issue.key)}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id: t.id } }) });
      return;
    }
    if (issue.provider === 'linear') {
      const d = await linear<{ workflowStates: { nodes: Array<{ id: string; position: number }> } }>(
        secret,
        'query($team: ID!, $type: String!) { workflowStates(filter: { team: { id: { eq: $team } }, type: { eq: $type } }) { nodes { id position } } }',
        { team: config['teamId'], type: done ? 'completed' : 'unstarted' },
      );
      const state = [...d.workflowStates.nodes].sort((a, b) => a.position - b.position)[0];
      if (!state) throw new IntegrationError('Linear has no matching workflow state', false);
      await linear(secret, 'mutation($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }', { id: issue.id, state: state.id });
      return;
    }
    await asana(secret, `/tasks/${encodeURIComponent(issue.id)}`, { method: 'PUT', body: JSON.stringify({ data: { completed: done } }) });
  });
}

/** For the conversational Jira workflow (integrations/jiraIssues.ts): same credentials and request helper. */
export async function jiraConnection(userId: string): Promise<{ secret: JiraSecret; config: Record<string, string> } | null> {
  const doc = await IntegrationModel.findOne({ userId, provider: 'jira', status: 'connected' }).select('+secret');
  if (!doc) return null;
  return { secret: decryptSecret<JiraSecret>(doc.secret), config: (doc.config ?? {}) as Record<string, string> };
}
export { jira as jiraRequest };
export type { JiraSecret };
