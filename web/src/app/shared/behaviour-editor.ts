import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { talkLabel, type Behaviour, type WatchKey } from '../core/ai.service';

const WATCH: Array<{ key: WatchKey; label: string }> = [
  { key: 'decisions', label: 'Unconfirmed decisions' },
  { key: 'owners', label: 'Tasks without an owner' },
  { key: 'disputes', label: 'Debates going in circles' },
  { key: 'goal', label: 'Drifting from the goal' },
  { key: 'time', label: 'Time and agenda' },
  { key: 'followUps', label: 'Open items from last meeting' },
  { key: 'contradictions', label: 'Reversing an earlier decision' },
  { key: 'risks', label: 'Conflicts, risky deadlines, blockers' },
];

/** Edits a full behaviour; the parent decides where it is saved (account or meeting). */
@Component({
  selector: 'app-behaviour-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let b = value();
    <div class="field">
      <label for="be-talk">Speaks up on its own: <strong>{{ talk(b.talkativeness) }}</strong></label>
      <input id="be-talk" type="range" min="0" max="1" step="0.05" [value]="b.talkativeness"
             (input)="set({ talkativeness: +$any($event.target).value })" />
    </div>

    <div class="row">
      <div class="field">
        <label for="be-tone">Tone</label>
        <select id="be-tone" class="input" [value]="b.tone" (change)="set({ tone: $any($event.target).value })">
          <option value="formal">Formal</option><option value="neutral">Neutral</option><option value="casual">Casual</option>
        </select>
      </div>
      <div class="field">
        <label for="be-len">Answers</label>
        <select id="be-len" class="input" [value]="b.replyLength" (change)="set({ replyLength: $any($event.target).value })">
          <option value="brief">Brief</option><option value="normal">Normal</option><option value="detailed">Detailed</option>
        </select>
      </div>
    </div>

    <fieldset>
      <legend>It may raise on its own</legend>
      @for (w of watch; track w.key) {
        <label class="check"><input type="checkbox" [checked]="b.watchFor[w.key]" (change)="setWatch(w.key, $any($event.target).checked)" /> {{ w.label }}</label>
      }
    </fieldset>

    <div class="field">
      <label for="be-ins">Instructions for the AI <span class="opt">(optional)</span></label>
      <textarea id="be-ins" class="input area" rows="3" maxlength="2000"
                placeholder="e.g. Mostly speak Hindi. Keep it very short. Don't joke."
                [value]="b.customInstructions" (input)="set({ customInstructions: $any($event.target).value })"></textarea>
    </div>

    <div class="row">
      <div class="field">
        <label for="be-name">Its name</label>
        <input id="be-name" class="input" type="text" maxlength="30" [value]="b.name" (input)="set({ name: $any($event.target).value })" />
      </div>
      <div class="field grow">
        <label for="be-wake">Also responds to <span class="opt">(comma-separated)</span></label>
        <input id="be-wake" class="input" type="text" [value]="b.wakeWords.join(', ')"
               (change)="set({ wakeWords: splitWords($any($event.target).value) })" />
      </div>
    </div>
    <label class="check"><input type="checkbox" [checked]="b.learnFromReactions" (change)="set({ learnFromReactions: $any($event.target).checked })" /> Learn from how people react to it</label>

    <details>
      <summary>Limits</summary>
      <div class="grid">
        <label>At least <input class="input num" type="number" min="5" max="900" [value]="b.limits.minGapSeconds" (change)="setLimit('minGapSeconds', $event)" /> s between remarks</label>
        <label>At most <input class="input num" type="number" min="0" max="30" [value]="b.limits.maxPerTenMinutes" (change)="setLimit('maxPerTenMinutes', $event)" /> remarks per 10 min</label>
        <label>A pause is <input class="input num" type="number" min="400" max="8000" step="100" [value]="b.limits.pauseMs" (change)="setLimit('pauseMs', $event)" /> ms of silence</label>
        <label>Quiet for the first <input class="input num" type="number" min="0" max="600" [value]="b.limits.warmupSeconds" (change)="setLimit('warmupSeconds', $event)" /> s</label>
        <label>Don't repeat an issue for <input class="input num" type="number" min="1" max="240" [value]="b.limits.repeatTopicMinutes" (change)="setLimit('repeatTopicMinutes', $event)" /> min</label>
        <label>Re-assess at most every <input class="input num" type="number" min="3" max="300" [value]="b.limits.minCheckSeconds" (change)="setLimit('minCheckSeconds', $event)" /> s</label>
      </div>
    </details>
  `,
  styles: `
    :host { display: block; }
    .field { margin-bottom: 16px; display: flex; flex-direction: column; gap: 6px; }
    .field label, legend { font-weight: 600; font-size: 14px; }
    .opt { color: var(--text-muted); font-weight: 400; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; .field { flex: 1; min-width: 140px; } .grow { flex: 2; } }
    select.input, .input { height: 40px; font-size: 14.5px; }
    .input.area { height: auto; padding: 10px 12px; line-height: 1.5; resize: vertical; }
    input[type='range'] { width: 100%; accent-color: var(--accent, #3df2b1); }
    fieldset { border: none; margin: 0 0 16px; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px 14px; }
    legend { margin-bottom: 8px; }
    .check { display: flex; align-items: center; gap: 8px; font-size: 14px; margin-bottom: 4px; }
    details { margin-top: 10px; summary { cursor: pointer; font-weight: 600; font-size: 14px; margin-bottom: 10px; } }
    .grid { display: grid; gap: 8px; font-size: 14px; label { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; } }
    .num { width: 84px; height: 34px; }
  `,
})
export class BehaviourEditor {
  readonly value = input.required<Behaviour>();
  readonly changed = output<Behaviour>();

  protected readonly watch = WATCH;
  protected talk = talkLabel;

  protected set(patch: Partial<Behaviour>): void {
    this.changed.emit({ ...this.value(), ...patch });
  }

  protected setWatch(key: WatchKey, on: boolean): void {
    this.set({ watchFor: { ...this.value().watchFor, [key]: on } });
  }

  protected setLimit(key: keyof Behaviour['limits'], e: Event): void {
    const n = Math.round(Number((e.target as HTMLInputElement).value));
    if (Number.isFinite(n)) this.set({ limits: { ...this.value().limits, [key]: n } });
  }

  protected splitWords(text: string): string[] {
    return [...new Set(text.split(',').map((w) => w.trim()).filter((w) => w.length >= 2))].slice(0, 30);
  }
}
