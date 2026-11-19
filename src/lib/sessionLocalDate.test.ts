import { describe, it, expect, afterEach, vi } from 'vitest';
import type { SessionLog } from '@/types/logging';

// v1.22 (limelog#123) — workout_sessions.date is a `date` column, and it was
// sent the ISO moment, of which Postgres keeps the UTC day. NCC reads it as the
// user's local day, so late-evening (Americas) and after-midnight (Finland)
// workouts landed on the wrong day there and, on the way back, in recovery.

vi.mock('./supabase', () => ({ isNexusConfigured: true, supabase: {} }));
const { mapSessionLogToNexus } = await import('./nexusSync');
const { momentOfCloudDate } = await import('./nexusRecovery');
const { localParts } = await import('./sessionMoment');

afterEach(() => {
  process.env.TZ = 'UTC';
});

const lift = (finalizedAt: string): SessionLog =>
  ({ id: 'w', sessionTemplateId: 't', programId: 'p', loggedAt: finalizedAt, finalizedAt, perceivedFatigue: null, sets: [] }) as SessionLog;

/** What the `date` column stores from the value sent: its literal date part. */
const stored = (sent: string) => sent.slice(0, 10);

describe('the pushed session date is the local day', () => {
  it('Helsinki, finished at 00:30 on 7 November: stored on the 7th, not the 6th', () => {
    process.env.TZ = 'Europe/Helsinki';
    const sent = mapSessionLogToNexus(lift('2026-11-06T22:30:00.000Z'), undefined, []).date;
    expect(sent).toBe('2026-11-07');
    expect(stored(sent)).toBe('2026-11-07');
  });

  it('New York, finished at 20:00 on 6 November: stored on the 6th, not the 7th', () => {
    process.env.TZ = 'America/New_York';
    expect(mapSessionLogToNexus(lift('2026-11-07T01:00:00.000Z'), undefined, []).date).toBe('2026-11-06');
  });

  it('a back-dated run keeps its chosen day', () => {
    process.env.TZ = 'America/Los_Angeles';
    const run = { ...lift('2026-11-08T09:00:00.000Z'), activityType: 'run', loggedAt: '2026-11-07T04:30:00.000Z' } as SessionLog;
    expect(mapSessionLogToNexus(run, undefined, []).date).toBe('2026-11-06');
  });
});

describe('a recovered session keeps its day', () => {
  for (const tz of ['America/Los_Angeles', 'UTC', 'Europe/Helsinki', 'Pacific/Auckland']) {
    it(`in ${tz}`, () => {
      process.env.TZ = tz;
      expect(localParts(new Date(momentOfCloudDate('2026-11-06'))).date).toBe('2026-11-06');
    });
  }

  it('a full moment passes through unchanged', () => {
    expect(momentOfCloudDate('2026-01-05T10:00:00Z')).toBe('2026-01-05T10:00:00Z');
  });

  it('push and recovery round-trip to the same local day', () => {
    process.env.TZ = 'America/New_York';
    const day = mapSessionLogToNexus(lift('2026-11-07T01:00:00.000Z'), undefined, []).date;
    expect(localParts(new Date(momentOfCloudDate(day))).date).toBe('2026-11-06');
  });
});
