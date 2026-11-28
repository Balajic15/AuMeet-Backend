import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { behaviourDiff, talkLabel, type Behaviour } from '../core/ai.service';
import { BehaviourEditor } from './behaviour-editor';

const base: Behaviour = {
  name: 'Maaya', wakeWords: ['Maya'], talkativeness: 0.5, tone: 'neutral', replyLength: 'brief',
  watchFor: { decisions: true, owners: true, disputes: true, goal: true, time: true, followUps: true, contradictions: true, risks: true },
  customInstructions: '', learnFromReactions: true, copilot: { enabled: true, minRelevance: 0.6, maxSuggestions: 4 },
  screen: { enabled: true, minIntervalSeconds: 20, maxPerTenMinutes: 12, changeThreshold: 0.08, maxSide: 1280 },
  limits: { minGapSeconds: 60, maxPerTenMinutes: 4, pauseMs: 1800, warmupSeconds: 20, repeatTopicMinutes: 15, minCheckSeconds: 8 },
  engine: { contextLines: 30 },
};

describe('AI behaviour editing', () => {
  it('saves only what differs from the layer below', () => {
    expect(behaviourDiff(base, base)).toEqual({});
    const changed: Behaviour = { ...base, tone: 'casual', watchFor: { ...base.watchFor, time: false }, limits: { ...base.limits, minGapSeconds: 120 }, engine: { contextLines: 99 } };
    expect(behaviourDiff(changed, base)).toEqual({ tone: 'casual', watchFor: { time: false }, limits: { minGapSeconds: 120 } });
    expect(behaviourDiff({ ...base, wakeWords: ['Au Meet', 'Oh Meet'] }, base)).toEqual({ wakeWords: ['Au Meet', 'Oh Meet'] });
  });

  it('describes talkativeness in words', () => {
    expect([0, 0.2, 0.5, 0.8, 1].map(talkLabel)).toEqual(['Only when asked', 'Rarely', 'When it helps', 'Often', 'Very active']);
  });

  it('emits the full updated behaviour when a control changes', async () => {
    const f = TestBed.createComponent(BehaviourEditor);
    f.componentRef.setInput('value', base);
    const out: Behaviour[] = [];
    f.componentInstance.changed.subscribe((b) => out.push(b));
    await f.whenStable();
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;

    const tone = el.querySelector<HTMLSelectElement>('#be-tone')!;
    tone.value = 'formal';
    tone.dispatchEvent(new Event('change'));
    const time = [...el.querySelectorAll<HTMLLabelElement>('.check')].find((l) => l.textContent?.includes('Time and agenda'))!.querySelector('input')!;
    time.checked = false;
    time.dispatchEvent(new Event('change'));
    const wake = el.querySelector<HTMLInputElement>('#be-wake')!;
    wake.value = 'Au Meet, Oh Meet, Au Meet, x';
    wake.dispatchEvent(new Event('change'));

    expect(out[0]!.tone).toBe('formal');
    expect(out[1]!.watchFor.time).toBe(false);
    expect(out[2]!.wakeWords).toEqual(['Au Meet', 'Oh Meet']);
    expect(el.textContent).toContain('When it helps');
  });
});
