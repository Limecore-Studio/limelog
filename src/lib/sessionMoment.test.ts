import { describe, expect, it } from 'vitest';
import { isFutureMoment, localParts, momentFromLocal, sessionMoment } from './sessionMoment';

describe('sessionMoment (LL#103)', () => {
  it('an activity is dated by its chosen moment, not when it was saved', () => {
    const run = { activityType: 'run' as const, loggedAt: '2026-10-21T17:30:00.000Z', finalizedAt: '2026-10-22T08:00:00.000Z' };
    expect(sessionMoment(run)).toBe('2026-10-21T17:30:00.000Z');
  });
  it('a workout is dated by when it was finished', () => {
    const lift = { activityType: undefined, loggedAt: '2026-10-21T17:30:00.000Z', finalizedAt: '2026-10-21T18:45:00.000Z' };
    expect(sessionMoment(lift)).toBe('2026-10-21T18:45:00.000Z');
    expect(sessionMoment({ ...lift, finalizedAt: undefined })).toBe(lift.loggedAt);
  });
});

describe('the When fields', () => {
  it('round-trip a local date and time', () => {
    const d = new Date(2026, 9, 21, 7, 5);
    expect(localParts(d)).toEqual({ date: '2026-10-21', time: '07:05' });
    expect(new Date(momentFromLocal('2026-10-21', '07:05')!).getTime()).toBe(d.getTime());
  });
  it('an incomplete field gives no moment', () => {
    expect(momentFromLocal('', '07:05')).toBeNull();
    expect(momentFromLocal('2026-10-21', '')).toBeNull();
  });
  it('yesterday is fine; the future is refused, with a minute of slack', () => {
    const now = new Date(2026, 9, 22, 12, 0).getTime();
    expect(isFutureMoment(new Date(now - 86_400_000).toISOString(), now)).toBe(false);
    expect(isFutureMoment(new Date(now + 30_000).toISOString(), now)).toBe(false);
    expect(isFutureMoment(new Date(now + 3_600_000).toISOString(), now)).toBe(true);
  });
});
