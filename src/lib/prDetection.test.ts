import { describe, it, expect, afterEach } from 'vitest';
import { currentPR, detectNewPRs } from './prDetection';
import { estimate1RM } from '@/utils/oneRepMax';
import type { SessionLog, ExercisePR, SetLog } from '@/types/logging';

// Characterization tests (v1.16, limecore#11). A PR is a claim the app makes
// to a user about their own training, and it is ranked on an estimate rather
// than the raw weight, so the rules about which sets qualify are the whole
// feature. This module previously carried its own uncapped Epley, which
// claimed PRs the Est. 1RM chart then refused to plot.

// A PR is dated by the lifter's local day (v1.18.1, LimeLog#75), so the dates
// below are pinned to UTC; the tests that are about time zones set their own.
process.env.TZ = 'UTC';
afterEach(() => {
  process.env.TZ = 'UTC';
});

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

function session(sets: SetLog[], over: Partial<SessionLog> = {}): SessionLog {
  return {
    id: 'sess1',
    loggedAt: '2026-01-05T18:30:00.000Z',
    sets,
    ...over,
  } as SessionLog;
}

const name = (id: string) => `Name:${id}`;
let n = 0;
const makeId = () => `pr${(n += 1)}`;

describe('currentPR', () => {
  const prs = [
    { id: 'a', exerciseId: 'squat', oneRepMaxKg: 120 },
    { id: 'b', exerciseId: 'squat', oneRepMaxKg: 130 },
    { id: 'c', exerciseId: 'bench', oneRepMaxKg: 200 },
  ] as ExercisePR[];

  it('takes the highest estimate for the exercise asked for', () => {
    expect(currentPR(prs, 'squat')?.id).toBe('b');
  });

  it('does not leak another exercise PR', () => {
    expect(currentPR(prs, 'deadlift')).toBeNull();
  });

  it('is null for an empty list', () => {
    expect(currentPR([], 'squat')).toBeNull();
  });
});

describe('detectNewPRs', () => {
  it('records a PR for an exercise with no history', () => {
    const out = detectNewPRs(session([set({ weightKg: 100, reps: 5 })]), [], name, makeId);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      exerciseId: 'squat',
      exerciseName: 'Name:squat',
      weightKg: 100,
      reps: 5,
      sessionId: 'sess1',
      date: '2026-01-05',
    });
  });

  it('rounds the stored estimate to two decimals', () => {
    const out = detectNewPRs(session([set({ weightKg: 100, reps: 5 })]), [], name, makeId);
    expect(out[0].oneRepMaxKg).toBe(112.5);
  });

  it('ranks by estimate, so fewer reps at more weight can lose', () => {
    // 100x5 estimates 112.50; 105x3 estimates 111.18. The heavier set is not
    // automatically the PR — that is the point of ranking on 1RM.
    const out = detectNewPRs(
      session([set({ weightKg: 100, reps: 5 }), set({ weightKg: 105, reps: 3 })]),
      [],
      name,
      makeId,
    );
    expect(out[0]).toMatchObject({ weightKg: 100, reps: 5 });
  });

  it('does not claim a PR for re-hitting the same estimate', () => {
    const prior = [{ id: 'p', exerciseId: 'squat', oneRepMaxKg: 112.5 }] as ExercisePR[];
    expect(detectNewPRs(session([set({ weightKg: 100, reps: 5 })]), prior, name, makeId)).toEqual([]);
  });

  it('claims a PR only when the estimate is strictly greater', () => {
    const prior = [{ id: 'p', exerciseId: 'squat', oneRepMaxKg: 112.4 }] as ExercisePR[];
    expect(detectNewPRs(session([set({ weightKg: 100, reps: 5 })]), prior, name, makeId)).toHaveLength(1);
  });

  it('ignores sets that were not completed', () => {
    const out = detectNewPRs(
      session([set({ weightKg: 300, reps: 5, completed: false })]),
      [],
      name,
      makeId,
    );
    expect(out).toEqual([]);
  });

  it('ignores a set with no weight or no reps', () => {
    const out = detectNewPRs(
      session([set({ weightKg: null as never }), set({ reps: null as never })]),
      [],
      name,
      makeId,
    );
    expect(out).toEqual([]);
  });

  it('will not claim a PR from a set the chart would refuse to plot', () => {
    // The regression this module was unified to fix: a 20-rep set used to
    // raise "New personal record" and then never appear on the Est. 1RM chart.
    expect(estimate1RM(100, 20)).toBeNull();
    const out = detectNewPRs(session([set({ weightKg: 100, reps: 20 })]), [], name, makeId);
    expect(out).toEqual([]);
  });

  it('reports one PR per exercise in a mixed session', () => {
    const out = detectNewPRs(
      session([
        set({ exerciseId: 'squat', weightKg: 100, reps: 5 }),
        set({ exerciseId: 'squat', weightKg: 90, reps: 5 }),
        set({ exerciseId: 'bench', weightKg: 80, reps: 5 }),
      ]),
      [],
      name,
      makeId,
    );
    expect(out.map((p) => p.exerciseId).sort()).toEqual(['bench', 'squat']);
    expect(out.find((p) => p.exerciseId === 'squat')?.weightKg).toBe(100);
  });

  it('dates the PR by the session, not by when detection ran', () => {
    const out = detectNewPRs(
      session([set()], { loggedAt: '2025-11-30T23:00:00.000Z' }),
      [],
      name,
      makeId,
    );
    expect(out[0].date).toBe('2025-11-30');
  });

  // v1.18.1 (LimeLog#75): the local day, not the UTC one.
  it('dates the PR by the lifter\'s own calendar day', () => {
    process.env.TZ = 'America/New_York';
    // 20:00 on 5 January in New York is already the 6th in UTC.
    const west = detectNewPRs(session([set()], { loggedAt: '2026-01-06T01:00:00.000Z' }), [], name, makeId);
    expect(west[0].date).toBe('2026-01-05');
    process.env.TZ = 'Asia/Tokyo';
    // 07:00 on the 6th in Tokyo is still the 5th in UTC.
    const east = detectNewPRs(session([set()], { loggedAt: '2026-01-05T22:00:00.000Z' }), [], name, makeId);
    expect(east[0].date).toBe('2026-01-06');
  });

  it('takes ids from the supplied factory, so this stays free of app singletons', () => {
    const out = detectNewPRs(session([set()]), [], name, () => 'fixed-id');
    expect(out[0].id).toBe('fixed-id');
  });

  it('returns nothing for a session with no sets', () => {
    expect(detectNewPRs(session([]), [], name, makeId)).toEqual([]);
  });

  // v1.18.1 (LimeLog#72): the stored estimate is rounded to two decimals, and
  // the comparison used to take the unrounded one. 100 x 4 stores 109.09 but
  // scores 109.0909, so the same set claimed a new PR every time it was done.
  describe('re-hitting the same set', () => {
    const sq = (weightKg: number, reps: number, id: string) =>
      session([set({ weightKg, reps })], { id });

    it('is not a new PR, in another workout or in the same one finished again', () => {
      const first = detectNewPRs(sq(100, 4, 'a'), [], name, makeId);
      expect(first.map((p) => p.oneRepMaxKg)).toEqual([109.09]);
      expect(detectNewPRs(sq(100, 4, 'b'), first, name, makeId)).toEqual([]);
      expect(detectNewPRs(sq(100, 4, 'a'), first, name, makeId)).toEqual([]);
    });

    it('is not a new PR for any common weight and rep count', () => {
      const repeated: string[] = [];
      for (let w = 20; w <= 300; w += 2.5) {
        for (let r = 2; r <= 12; r++) {
          const first = detectNewPRs(sq(w, r, 'a'), [], name, makeId);
          if (detectNewPRs(sq(w, r, 'b'), first, name, makeId).length > 0) repeated.push(`${w}x${r}`);
        }
      }
      expect(repeated).toEqual([]);
    });

    it('still lets a set that beats the stored estimate by a hundredth through', () => {
      const prior = [{ id: 'p', exerciseId: 'squat', oneRepMaxKg: 109.08 }] as ExercisePR[];
      expect(detectNewPRs(sq(100, 4, 'b'), prior, name, makeId)).toHaveLength(1);
    });
  });
});
