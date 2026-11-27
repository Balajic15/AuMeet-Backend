import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService, apiErrorMessage } from '../../core/auth.service';
import {
  MeetingsService,
  meetingLink,
  parseMeetingCode,
  type Meeting,
} from '../../core/meetings.service';
import { Icon } from '../../shared/icon';
import { Modal } from '../../shared/modal';
import { ToastService } from '../../shared/toast';
import { UserMenu } from '../../shared/user-menu';
import { MemoryService, type MyTask, type Overview } from '../../core/memory.service';
import { AskBox } from './ask-box';
import { MyTasks } from './my-tasks';
import { PrepareDialog } from './prepare-dialog';

type Tab = 'upcoming' | 'recent' | 'tasks';
type Dialog =
  | { kind: 'link'; meeting: Meeting }
  | { kind: 'schedule' }
  | { kind: 'settings'; meeting: Meeting }
  | { kind: 'end'; meeting: Meeting }
  | { kind: 'invite'; meeting: Meeting }
  | { kind: 'prepare'; meeting: Meeting };

/** Turns a Date into the value a <input type="datetime-local"> expects (local time). */
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function nextHalfHour(): Date {
  const d = new Date();
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}

@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Modal, UserMenu, ReactiveFormsModule, RouterLink, AskBox, MyTasks, PrepareDialog],
  host: { '(document:click)': 'closeMenus($event)' },
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard {
  protected readonly auth = inject(AuthService);
  private readonly meetings = inject(MeetingsService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly memory = inject(MemoryService);

  protected readonly all = signal<Meeting[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly tab = signal<Tab>('upcoming');
  protected readonly newMenuOpen = signal(false);
  protected readonly rowMenu = signal<string | null>(null);
  protected readonly dialog = signal<Dialog | null>(null);
  protected readonly busy = signal(false);
  protected readonly dialogError = signal<string | null>(null);

  protected readonly joinInput = new FormControl('', { nonNullable: true });
  protected readonly joinError = signal<string | null>(null);

  protected readonly firstName = computed(() => this.auth.user()?.name.split(' ')[0] ?? '');

  /** Live meetings first, then scheduled ones that haven't happened yet (soonest first). */
  protected readonly upcoming = computed(() => {
    const now = Date.now();
    const live = this.all().filter((m) => m.status === 'live');
    const scheduled = this.all()
      .filter((m) => m.status === 'idle' && m.scheduledFor && new Date(m.scheduledFor).getTime() > now - 60 * 60_000)
      .sort((a, b) => +new Date(a.scheduledFor!) - +new Date(b.scheduledFor!));
    return [...live, ...scheduled];
  });

  protected readonly recent = computed(() => {
    const up = new Set(this.upcoming().map((m) => m.id));
    const when = (m: Meeting) => +new Date(m.endedAt ?? m.startedAt ?? m.scheduledFor ?? m.createdAt);
    return this.all()
      .filter((m) => !up.has(m.id))
      .sort((a, b) => when(b) - when(a));
  });

  protected readonly visible = computed(() => (this.tab() === 'upcoming' ? this.upcoming() : this.recent()));

  protected readonly overview = signal<Overview | null>(null);
  protected readonly openTaskCount = computed(() => this.overview()?.tasks.filter((t) => t.status === 'open').length ?? 0);

  protected readonly scheduleForm = new FormGroup({
    title: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.maxLength(120)] }),
    when: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    allowGuests: new FormControl(true, { nonNullable: true }),
    aiEnabled: new FormControl(true, { nonNullable: true }),
    aiProactive: new FormControl(true, { nonNullable: true }),
  });

  protected readonly settingsForm = new FormGroup({
    title: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.maxLength(120)] }),
    when: new FormControl('', { nonNullable: true }),
    waitingRoom: new FormControl(false, { nonNullable: true }),
    aiReplyMode: new FormControl<'named' | 'any'>('named', { nonNullable: true }),
    aiFacilitator: new FormControl(false, { nonNullable: true }),
    followUpEmail: new FormControl(true, { nonNullable: true }),
    allowGuests: new FormControl(true, { nonNullable: true }),
    aiEnabled: new FormControl(true, { nonNullable: true }),
    aiProactive: new FormControl(true, { nonNullable: true }),
  });

  constructor() {
    void this.load();
    void this.loadOverview();
  }

  /** My tasks + decisions waiting on the team (from the memory API). */
  protected async loadOverview(): Promise<void> {
    try {
      this.overview.set(await this.memory.overview());
    } catch {
      /* the tab simply stays empty */
    }
  }

  protected onTaskChanged(t: MyTask): void {
    this.overview.update((o) =>
      o ? { ...o, tasks: o.tasks.map((x) => (x.sessionId === t.sessionId && x.id === t.id ? t : x)) } : o,
    );
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const list = await this.meetings.list();
      this.all.set(list);
      if (this.tab() !== 'tasks' && this.upcoming().length === 0 && list.length > 0) this.tab.set('recent');
    } catch (err) {
      this.loadError.set(apiErrorMessage(err, 'Could not load your meetings.'));
    } finally {
      this.loading.set(false);
    }
  }

  // ---------- helpers used by the template ----------

  /** Meetings I host, newest first – choices for "Follow-up to". */
  protected readonly hostedMeetings = computed(() => this.all().filter((m) => m.hostId === this.auth.user()?.id));

  protected isHost(m: Meeting): boolean {
    return m.hostId === this.auth.user()?.id;
  }

  protected link(m: Meeting): string {
    return meetingLink(m.code);
  }

  /** Big date shown at the left of each row. */
  protected dateParts(m: Meeting): { day: string; month: string; time: string; label: string } {
    const d = new Date(m.status === 'live' ? (m.startedAt ?? m.createdAt) : (m.scheduledFor ?? m.startedAt ?? m.createdAt));
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    const label = same(d, today) ? 'Today' : same(d, tomorrow) ? 'Tomorrow' : same(d, yesterday) ? 'Yesterday' : '';
    return {
      day: String(d.getDate()),
      month: d.toLocaleDateString(undefined, { month: 'short' }),
      time: d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
      label: label || d.toLocaleDateString(undefined, { weekday: 'short' }),
    };
  }

  // ---------- actions ----------

  protected closeMenus(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (!t.closest('.new-wrap')) this.newMenuOpen.set(false);
    if (!t.closest('.row-menu-wrap')) this.rowMenu.set(null);
  }

  protected async startInstant(): Promise<void> {
    this.newMenuOpen.set(false);
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const m = await this.meetings.create({ title: `${this.firstName() || 'My'}'s meeting` });
      await this.router.navigate(['/', m.code]);
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'Could not start a meeting.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected async createForLater(): Promise<void> {
    this.newMenuOpen.set(false);
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const m = await this.meetings.create({ title: `${this.firstName() || 'My'}'s meeting` });
      this.all.update((l) => [m, ...l]);
      this.tab.set('recent');
      this.dialog.set({ kind: 'link', meeting: m });
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'Could not create a meeting.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected openSchedule(): void {
    this.newMenuOpen.set(false);
    this.dialogError.set(null);
    this.scheduleForm.reset({ title: '', when: toLocalInput(nextHalfHour()), allowGuests: true, aiEnabled: true, aiProactive: true });
    this.dialog.set({ kind: 'schedule' });
  }

  protected async submitSchedule(): Promise<void> {
    this.scheduleForm.markAllAsTouched();
    if (this.scheduleForm.invalid || this.busy()) return;
    const v = this.scheduleForm.getRawValue();
    const when = new Date(v.when);
    if (when.getTime() < Date.now() - 60_000) {
      this.dialogError.set('Pick a time in the future.');
      return;
    }
    this.busy.set(true);
    this.dialogError.set(null);
    try {
      const m = await this.meetings.create({
        title: v.title.trim(),
        scheduledFor: when.toISOString(),
        settings: { allowGuests: v.allowGuests, aiEnabled: v.aiEnabled, aiProactive: v.aiProactive },
      });
      this.all.update((l) => [m, ...l]);
      this.tab.set('upcoming');
      this.dialog.set({ kind: 'link', meeting: m });
    } catch (err) {
      this.dialogError.set(apiErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected openSettings(m: Meeting): void {
    this.rowMenu.set(null);
    this.dialogError.set(null);
    this.settingsForm.reset({
      title: m.title,
      when: m.scheduledFor ? toLocalInput(new Date(m.scheduledFor)) : '',
      allowGuests: m.settings.allowGuests,
      aiEnabled: m.settings.aiEnabled,
      aiProactive: m.settings.aiProactive ?? true,
      waitingRoom: m.settings.waitingRoom ?? false,
      aiReplyMode: m.settings.aiReplyMode ?? 'named',
      aiFacilitator: m.settings.aiFacilitator ?? false,
      followUpEmail: m.settings.followUpEmail ?? true,
    });
    this.dialog.set({ kind: 'settings', meeting: m });
  }

  protected async submitSettings(m: Meeting): Promise<void> {
    this.settingsForm.markAllAsTouched();
    if (this.settingsForm.invalid || this.busy()) return;
    const v = this.settingsForm.getRawValue();
    this.busy.set(true);
    this.dialogError.set(null);
    try {
      const updated = await this.meetings.update(m.code, {
        title: v.title.trim(),
        scheduledFor: v.when ? new Date(v.when).toISOString() : null,
        settings: { allowGuests: v.allowGuests, aiEnabled: v.aiEnabled, aiProactive: v.aiProactive, waitingRoom: v.waitingRoom, aiReplyMode: v.aiReplyMode, aiFacilitator: v.aiFacilitator, followUpEmail: v.followUpEmail },
      });
      this.replace(updated);
      this.dialog.set(null);
      this.toast.show('Meeting updated');
    } catch (err) {
      this.dialogError.set(apiErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected readonly resending = signal(false);
  protected readonly resent = signal(false);

  protected async resendVerification(): Promise<void> {
    this.resending.set(true);
    try {
      await this.auth.resendVerification();
      this.resent.set(true);
      this.toast.show('Verification email sent');
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'Could not send the email right now.'));
    } finally {
      this.resending.set(false);
    }
  }

  protected readonly inviteEmails = new FormControl('', { nonNullable: true });
  protected readonly inviteMessage = new FormControl('', { nonNullable: true });

  protected openPrepare(m: Meeting): void {
    this.rowMenu.set(null);
    this.dialog.set({ kind: 'prepare', meeting: m });
  }

  protected onPrepared(m: Meeting): void {
    this.replace(m);
    this.dialog.set(null);
  }

  protected openInvite(m: Meeting): void {
    this.rowMenu.set(null);
    this.dialogError.set(null);
    this.inviteEmails.reset();
    this.inviteMessage.reset();
    this.dialog.set({ kind: 'invite', meeting: m });
  }

  /** Accepts emails separated by commas, spaces, semicolons or new lines. */
  protected parseEmails(raw: string): { valid: string[]; invalid: string[] } {
    const parts = raw.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    const ok = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
    return { valid: [...new Set(parts.filter(ok))], invalid: parts.filter((e) => !ok(e)) };
  }

  protected async sendInvites(m: Meeting): Promise<void> {
    const { valid, invalid } = this.parseEmails(this.inviteEmails.value);
    if (invalid.length) {
      this.dialogError.set(`Check these addresses: ${invalid.slice(0, 3).join(', ')}`);
      return;
    }
    if (valid.length === 0 || valid.length > 20) {
      this.dialogError.set('Enter between 1 and 20 email addresses.');
      return;
    }
    this.busy.set(true);
    this.dialogError.set(null);
    try {
      const res = await this.meetings.invite(m.code, valid, this.inviteMessage.value.trim() || undefined);
      this.dialog.set(null);
      this.toast.show(`Invitation sent to ${res.sent} ${res.sent === 1 ? 'person' : 'people'}`);
    } catch (err) {
      this.dialogError.set(apiErrorMessage(err, 'Could not send the invitations.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected confirmEnd(m: Meeting): void {
    this.rowMenu.set(null);
    this.dialogError.set(null);
    this.dialog.set({ kind: 'end', meeting: m });
  }

  protected async endMeeting(m: Meeting): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      this.replace(await this.meetings.end(m.code));
      this.dialog.set(null);
      this.toast.show('Meeting ended for everyone');
    } catch (err) {
      this.dialogError.set(apiErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async copyLink(m: Meeting): Promise<void> {
    try {
      await navigator.clipboard.writeText(meetingLink(m.code));
      this.toast.show('Meeting link copied');
    } catch {
      this.toast.error('Could not copy – select the link and copy it manually.');
    }
  }

  protected join(m: Meeting): void {
    void this.router.navigate(['/', m.code]);
  }

  protected submitJoin(): void {
    const code = parseMeetingCode(this.joinInput.value);
    if (!code) {
      this.joinError.set('Enter a meeting code like abc-defg-hij or paste the full link.');
      return;
    }
    this.joinError.set(null);
    void this.router.navigate(['/', code]);
  }

  private replace(m: Meeting): void {
    this.all.update((l) => l.map((x) => (x.id === m.id ? m : x)));
  }
}
