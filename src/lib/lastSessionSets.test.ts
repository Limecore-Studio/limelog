import { describe, it, expect, afterEach } from 'vitest';
import { getLastSessionSets, topWeight } from './lastSessionSets';
import type { SessionLog, SetLog } from '@/types/logging';

// Characterization tests (v1.16, limecore#11). This is the progressive-overload
// lookup: "what did I do for this last time". If it returns the wrong session
// the user progresses off the wrong numbers, which is a training error rather
// than a display one.

function set(over: Partial<SetLog> = {}): SetLog {
  return {
    id: `s${Math.random()}`,
    exerciseId: 'squat',
    setNumber: 1,
    weightKg: 100,
    reps: 5,
    completed: true,
    ...over,
  } as SetLog;
}

// LAST is dated by the lifter's local day (v1.18.1, LimeLog#75), so the dates
// below are pinned to UTC; the test about time zones sets its own.
process.env.TZ = 'UTC';
afterEach(() => {
  process.env.TZ = 'UTC';
});

function log(id: string, loggedAt: string, sets: SetLog[]): SessionLog {
  return { id, loggedAt, sets } as SessionLog;
}

describe('getLastSessionSets', () => {
  it('returns the most recent prior session for the exercise', () => {
    const out = getLastSessionSets(
      [
        log('old', '2026-01-01T10:00:00.000Z', [set({ weightKg: 90 })]),
        log('recent', '2026-01-08T10:00:00.000Z', [set({ weightKg: 100 })]),
      ],
      'squat',
      'current',
    );
    expect(out?.date).toBe('2026-01-08');
    expect(out?.sets[0].weightKg).toBe(100);
  });

  it('sorts by date rather than trusting array order', () => {
    const out = getLastSessionSets(
      [
        log('recent', '2026-01-08T10:00:00.000Z', [set({ weightKg: 100 })]),
        log('old', '2026-01-01T10:00:00.000Z', [set({ weightKg: 90 })]),
      ],
      'squat',
      'current',
    );
    expect(out?.date).toBe('2026-01-08');
  });

  it('excludes the session being logged right now', () => {
    const out = getLastSessionSets(
      [
        log('current', '2026-01-09T10:00:00.000Z', [set({ weightKg: 120 })]),
        log('prior', '2026-01-08T10:00:00.000Z', [set({ weightKg: 100 })]),
      ],
      'squat',
      'current',
    );
    expect(out?.date).toBe('2026-01-08');
  });

  it('skips a session that has no sets for this exercise', () => {
    const out = getLastSessionSets(
      [
        log('bench-day', '2026-01-08T10:00:00.000Z', [set({ exerciseId: 'bench' })]),
        log('squat-day', '2026-01-01T10:00:00.000Z', [set({ exerciseId: 'squat' })]),
      ],
      'squat',
      'current',
    );
    expect(out?.date).toBe('2026-01-01');
  });

  it('orders the returned sets by set number, not by array position', () => {
    const out = getLastSessionSets(
      [
        log('s', '2026-01-08T10:00:00.000Z', [
          set({ setNumber: 3, weightKg: 102 }),
          set({ setNumber: 1, weightKg: 100 }),
          set({ setNumber: 2, weightKg: 101 }),
        ]),
      ],
      'squat',
      'current',
    );
    expect(out?.sets.map((s) => s.setNumber)).toEqual([1, 2, 3]);
  });

  // limelog#42 (owner decision A1, 2026-10-03): LAST is "what did I do last
  // time", so only finished work counts. This replaced a test that pinned the
  // old lenient behaviour ("returns the sets whether or not they were completed").
  it('skips a session whose sets for the exercise were never finished', () => {
    const out = getLastSessionSets(
      [
        log('abandoned', '2026-01-08T10:00:00.000Z', [set({ completed: false }), set({ setNumber: 2, completed: false })]),
        log('real', '2026-01-01T10:00:00.000Z', [set({ weightKg: 95 })]),
      ],
      'squat',
      'current',
    );
    expect(out?.date).toBe('2026-01-01');
    expect(out?.sets.map((s) => s.weightKg)).toEqual([95]);
  });

  it('skips a session whose only done sets have no reps (the "95 kg×—" screenshot)', () => {
    const out = getLastSessionSets(
      [
        log('repless', '2026-01-08T10:00:00.000Z', [
          set({ reps: null as never }),
          set({ setNumber: 2, reps: 0 }),
        ]),
        log('real', '2026-01-01T10:00:00.000Z', [set({ reps: 5 })]),
      ],
      'squat',
      'current',
    );
    expect(out?.date).toBe('2026-01-01');
  });

  it('returns only the finished sets of a partly finished session', () => {
    const out = getLastSessionSets(
      [
        log('partial', '2026-01-08T10:00:00.000Z', [
          set({ setNumber: 1, reps: 5 }),
          set({ setNumber: 2, reps: 5 }),
          set({ setNumber: 3, completed: false }),
          set({ setNumber: 4, reps: null as never }),
        ]),
      ],
      'squat',
      'current',
    );
    expect(out?.date).toBe('2026-01-08');
    expect(out?.sets.map((s) => s.setNumber)).toEqual([1, 2]);
  });

  it('is null when no session has finished work for the exercise', () => {
    expect(
      getLastSessionSets([log('s', '2026-01-08T10:00:00.000Z', [set({ completed: false })])], 'squat', 'current'),
    ).toBeNull();
  });

  it('is null when there is no history for the exercise', () => {
    expect(getLastSessionSets([], 'squat', 'current')).toBeNull();
    expect(
      getLastSessionSets([log('s', '2026-01-08T10:00:00.000Z', [set({ exerciseId: 'bench' })])], 'squat', 'current'),
    ).toBeNull();
  });

  it('is null when the only session for the exercise is the excluded one', () => {
    expect(
      getLastSessionSets([log('current', '2026-01-09T10:00:00.000Z', [set()])], 'squat', 'current'),
    ).toBeNull();
  });

  // v1.18.1 (LimeLog#75): the local day, not the UTC one.
  it('dates LAST by the lifter\'s own calendar day', () => {
    process.env.TZ = 'America/New_York';
    // 20:00 on 7 January in New York is already the 8th in UTC.
    const out = getLastSessionSets([log('evening', '2026-01-08T01:00:00.000Z', [set()])], 'squat', 'current');
    expect(out?.date).toBe('2026-01-07');
  });
});

describe('topWeight', () => {
  it('takes the heaviest completed set', () => {
    expect(topWeight([set({ weightKg: 100 }), set({ weightKg: 110 })])).toBe(110);
  });

  it('ignores an incomplete set however heavy', () => {
    expect(topWeight([set({ weightKg: 100 }), set({ weightKg: 300, completed: false })])).toBe(100);
  });

  it('ignores a set with no weight recorded', () => {
    expect(topWeight([set({ weightKg: null as never }), set({ weightKg: 100 })])).toBe(100);
  });

  it('is zero rather than null for no qualifying sets', () => {
    expect(topWeight([])).toBe(0);
    expect(topWeight([set({ completed: false })])).toBe(0);
  });
});
