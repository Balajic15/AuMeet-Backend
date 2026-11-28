import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { apiErrorMessage } from '../../core/auth.service';
import { ToastService } from '../../shared/toast';

type Provider = 'google' | 'jira' | 'linear' | 'asana';
type Tool = Exclude<Provider, 'google'>;

interface IntegrationInfo {
  provider: Provider;
  connected: boolean;
  status?: 'connected' | 'error';
  account?: string;
  enabled?: boolean;
  config?: Record<string, string>;
  lastError?: string | null;
  lastUsedAt?: string | null;
}

interface View {
  google: { available: boolean; redirectUri: string; scopes: string[] };
  integrations: IntegrationInfo[];
}

const TOOLS: Array<{ id: Tool; name: string; help: string; fields: Array<{ key: string; label: string; type: string; placeholder: string }> }> = [
  {
    id: 'jira',
    name: 'Jira',
    help: 'Create an API token at id.atlassian.com → Security → API tokens.',
    fields: [
      { key: 'site', label: 'Site', type: 'text', placeholder: 'acme.atlassian.net' },
      { key: 'email', label: 'Atlassian email', type: 'email', placeholder: 'you@acme.com' },
      { key: 'token', label: 'API token', type: 'password', placeholder: '' },
    ],
  },
  {
    id: 'linear',
    name: 'Linear',
    help: 'Create a personal API key in Linear → Settings → Account → Security & access.',
    fields: [{ key: 'apiKey', label: 'API key', type: 'password', placeholder: 'lin_api_…' }],
  },
  {
    id: 'asana',
    name: 'Asana',
    help: 'Create a personal access token in Asana → My settings → Apps → Developer apps.',
    fields: [{ key: 'token', label: 'Personal access token', type: 'password', placeholder: '' }],
  },
];

/** Account → Integrations: where approved follow-ups are carried out. */
@Component({
  selector: 'app-integrations-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe, NgTemplateOutlet],
  template: `
    <h2 id="integrations">Integrations</h2>
    <p class="hint">
      Approved follow-ups are carried out in these services: emails from your Gmail, events in your Google Calendar,
      and tasks in your project tool (closed there when they're done in AuMeet). Credentials are encrypted and never
      shown again.
    </p>
    @if (v(); as v) {
      <!-- Google -->
      <div class="int">
        <div class="int-head">
          <div><strong>Gmail &amp; Google Calendar</strong>
            @if (info('google'); as g) { @if (g.connected) { <span class="tag" [class.err]="g.status === 'error'">{{ g.status === 'error' ? 'Needs reconnecting' : 'Connected' }}</span> } }
          </div>
          @if (info('google')?.connected) {
            <button type="button" class="link" [disabled]="busy()" (click)="disconnect('google')">Disconnect</button>
          }
        </div>
        @if (info('google'); as g) {
          @if (g.connected) {
            <p class="meta">As {{ g.account }}@if (g.lastUsedAt) { · last used {{ g.lastUsedAt | date: 'd MMM, HH:mm' }} }</p>
            @if (g.lastError) { <p class="error">{{ g.lastError }}</p> }
            <label class="check"><input type="checkbox" [ngModel]="g.enabled" (ngModelChange)="toggle('google', $event)" /> Use for follow-ups</label>
          } @else if (v.google.available) {
            <p class="meta">Sends follow-up emails as you and creates calendar events with invitations. AuMeet can't read your mail or other events.</p>
          }
        }
        @if (!info('google')?.connected || info('google')?.status === 'error') {
          @if (v.google.available) {
            <a class="btn btn-outline small" href="/api/integrations/google/start">Connect Google</a>
          } @else {
            <p class="meta">Google isn't configured on this server.</p>
          }
        }
      </div>

      <!-- Project tools -->
      @for (t of tools; track t.id) {
        <div class="int">
          <div class="int-head">
            <div><strong>{{ t.name }}</strong>
              @if (info(t.id); as i) {
                @if (i.connected) {
                  <span class="tag" [class.err]="i.status === 'error'">{{ i.status === 'error' ? 'Needs reconnecting' : i.enabled ? 'In use' : 'Connected' }}</span>
                }
              }
            </div>
            @if (info(t.id)?.connected) {
              <button type="button" class="link" [disabled]="busy()" (click)="disconnect(t.id)">Disconnect</button>
            }
          </div>
          @if (info(t.id); as i) {
            @if (i.connected && i.status !== 'error') {
              <p class="meta">As {{ i.account }}@if (i.lastUsedAt) { · last used {{ i.lastUsedAt | date: 'd MMM, HH:mm' }} }</p>
              @if (i.lastError) { <p class="error">{{ i.lastError }}</p> }
              <div class="row">
                <label class="grow">
                  <span>{{ t.id === 'linear' ? 'Team' : 'Project' }} for new tasks</span>
                  <select class="input" [ngModel]="selected(t.id, i)" (focus)="loadChoices(t.id)" (ngModelChange)="configure(t.id, $event)">
                    <option value="" disabled>{{ choices()[t.id] ? 'Choose…' : 'Loading…' }}</option>
                    @for (c of choices()[t.id] ?? fallbackChoice(t.id, i); track c.id) { <option [value]="c.id">{{ c.name }}</option> }
                  </select>
                </label>
              </div>
              @if (!i.enabled) {
                <button type="button" class="btn btn-outline small" [disabled]="busy()" (click)="toggle(t.id, true)">Use {{ t.name }} for tasks</button>
              }
            } @else {
              <ng-container *ngTemplateOutlet="connectForm; context: { $implicit: t }" />
            }
          } @else {
            <ng-container *ngTemplateOutlet="connectForm; context: { $implicit: t }" />
          }
        </div>
      }
      <p class="meta">One project tool is used at a time. Tasks still go to your webhook too, if you set one below.</p>

      <ng-template #connectForm let-t>
        @if (open() === t.id) {
          <p class="meta">{{ t.help }}</p>
          @for (f of t.fields; track f.key) {
            <label class="field"><span>{{ f.label }}</span>
              <input class="input" [type]="f.type" [placeholder]="f.placeholder" autocomplete="off" [(ngModel)]="draft[f.key]" />
            </label>
          }
          <div class="btns">
            <button type="button" class="btn btn-outline small" (click)="open.set(null)">Cancel</button>
            <button type="button" class="btn btn-primary small" [disabled]="busy()" (click)="connect(t.id)">
              @if (busy()) { <span class="spinner"></span> } Connect
            </button>
          </div>
        } @else {
          <button type="button" class="btn btn-outline small" (click)="startConnect(t.id)">Connect {{ t.name }}</button>
        }
      </ng-template>
    } @else {
      <p class="hint">Loading…</p>
    }
  `,
  styles: `
    :host { display: block; }
    h2 { margin: 0 0 18px; font-size: 18px; font-weight: 600; }
    .hint { margin: -6px 0 16px; color: var(--text-muted); font-size: 14px; line-height: 1.5; }
    .int { padding: 14px 0; border-top: 1px solid #222; }
    .int-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; strong { font-size: 15px; } }
    .tag { margin-left: 8px; padding: 1px 8px; border: 1px solid var(--brand); color: var(--brand); font-size: 11.5px; }
    .tag.err { border-color: var(--danger); color: var(--danger); }
    .meta { margin: 6px 0 10px; color: var(--text-muted); font-size: 13px; line-height: 1.5; }
    .error { margin: 4px 0 8px; color: var(--danger); font-size: 13px; }
    .link { background: none; border: none; padding: 0; color: var(--link); font-size: 13px; cursor: pointer; }
    .btn.small { width: auto; height: 36px; padding: 0 14px; font-size: 13.5px; display: inline-flex; align-items: center; gap: 6px; }
    .check { display: flex; gap: 8px; align-items: center; font-size: 14px; }
    .field, .row label { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; font-size: 13px; color: var(--text-muted); }
    .row { display: flex; gap: 10px; } .grow { flex: 1; }
    .btns { display: flex; gap: 8px; justify-content: flex-end; }
  `,
})
export class IntegrationsCard {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);
  protected readonly tools = TOOLS;
  protected readonly v = signal<View | null>(null);
  protected readonly busy = signal(false);
  protected readonly open = signal<Tool | null>(null);
  protected readonly choices = signal<Partial<Record<Tool, Array<{ id: string; name: string; parent?: string }>>>>({});
  protected draft: Record<string, string> = {};
  private readonly byProvider = computed(() => new Map((this.v()?.integrations ?? []).map((i) => [i.provider, i])));

  constructor() {
    void this.load();
    // Back from Google's consent screen.
    const q = this.route.snapshot.queryParamMap;
    if (q.get('integration') === 'google') {
      if (q.get('connected')) this.toast.show(`Google connected as ${q.get('connected')}`);
      else if (q.get('error')) this.toast.error(q.get('error')!);
    }
  }

  protected info(p: Provider): IntegrationInfo | undefined {
    return this.byProvider().get(p);
  }

  private async load(): Promise<void> {
    try {
      this.v.set(await firstValueFrom(this.http.get<View>('/api/integrations')));
    } catch {
      this.v.set({ google: { available: false, redirectUri: '', scopes: [] }, integrations: [] });
    }
  }

  private async run(fn: () => Promise<View>, done: string): Promise<boolean> {
    this.busy.set(true);
    try {
      this.v.set(await fn());
      this.toast.show(done);
      return true;
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'That did not work.'));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  protected startConnect(t: Tool): void {
    this.draft = {};
    this.open.set(t);
  }

  protected async connect(t: Tool): Promise<void> {
    const ok = await this.run(() => firstValueFrom(this.http.post<View>(`/api/integrations/${t}/connect`, this.draft)), `${t[0]!.toUpperCase()}${t.slice(1)} connected`);
    if (ok) {
      this.draft = {};
      this.open.set(null);
      void this.loadChoices(t);
    }
  }

  protected async loadChoices(t: Tool): Promise<void> {
    if (this.choices()[t]) return;
    try {
      const r = await firstValueFrom(this.http.get<{ choices: Array<{ id: string; name: string; parent?: string }> }>(`/api/integrations/${t}/choices`));
      this.choices.update((c) => ({ ...c, [t]: r.choices }));
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'Could not load the list.'));
    }
  }

  protected selected(t: Tool, i: IntegrationInfo): string {
    const c = i.config ?? {};
    return (t === 'jira' ? c['projectKey'] : t === 'linear' ? c['teamId'] : c['projectGid']) ?? '';
  }

  /** Before the list loads, show the saved choice so the select isn't empty. */
  protected fallbackChoice(t: Tool, i: IntegrationInfo): Array<{ id: string; name: string }> {
    const id = this.selected(t, i);
    return id ? [{ id, name: id }] : [];
  }

  protected configure(t: Tool, id: string): Promise<boolean> {
    const choice = this.choices()[t]?.find((c) => c.id === id);
    const body = t === 'jira' ? { projectKey: id } : t === 'linear' ? { teamId: id } : { workspaceGid: choice?.parent ?? '', projectGid: id };
    return this.run(() => firstValueFrom(this.http.put<View>(`/api/integrations/${t}/config`, body)), 'Saved');
  }

  protected toggle(p: Provider, enabled: boolean): Promise<boolean> {
    return this.run(() => firstValueFrom(this.http.patch<View>(`/api/integrations/${p}`, { enabled })), enabled ? 'In use' : 'Paused');
  }

  protected disconnect(p: Provider): Promise<boolean> {
    return this.run(() => firstValueFrom(this.http.delete<View>(`/api/integrations/${p}`)), 'Disconnected');
  }
}
