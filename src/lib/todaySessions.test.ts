import { describe, it, expect } from 'vitest';
import { sessionsForDay, resolvePhase, phaseSessions, deloadTargetReps, resumableLogs } from './todaySessions';
import { missedRepRatio } from '@/utils/oneRepMax';
import type { Phase, SessionExercise, SessionTemplate } from '@/types/program';
import type { SessionLog } from '@/types/logging';

// limelog#43: Today offers the active phase's sessions, not every phase's.

const SAT = 6;
const MON = 1;

function s(id: string, phaseId: string, dayOfWeek: number): SessionTemplate {
  return { id, phaseId, dayOfWeek, name: id, exercises: [], orderIndex: 0 } as unknown as SessionTemplate;
}

const program = {
  sessions: [
    s('acc-push-sat', 'acc', SAT),
    s('acc-pull-mon', 'acc', MON),
    s('int-push-sat', 'int', SAT),
    s('int-pull-mon', 'int', MON),
  ],
};

describe('sessionsForDay', () => {
  it('reproduces #43: the weekday alone matches both phases', () => {
    // What Today used to do. Kept as the documented reproduction.
    expect(program.sessions.filter((x) => x.dayOfWeek === SAT).map((x) => x.id)).toEqual(['acc-push-sat', 'int-push-sat']);
  });

  it('offers only the current phase\'s session for the day', () => {
    expect(sessionsForDay(program, SAT, 'acc').map((x) => x.id)).toEqual(['acc-push-sat']);
    expect(sessionsForDay(program, SAT, 'int').map((x) => x.id)).toEqual(['int-push-sat']);
  });

  it('offers nothing on a rest day of the current phase even if another phase trains that day', () => {
    const p = { sessions: [s('acc-push-sat', 'acc', SAT), s('int-legs-sun', 'int', 0)] };
    expect(sessionsForDay(p, 0, 'acc')).toEqual([]);
  });

  it('falls back to every phase when the current phase has no sessions at all', () => {
    const p = { sessions: [s('int-push-sat', 'int', SAT)] };
    expect(sessionsForDay(p, SAT, 'acc').map((x) => x.id)).toEqual(['int-push-sat']);
  });

  it('keeps the old behaviour with no phase resolved, and is empty with no program', () => {
    expect(sessionsForDay(program, SAT, null)).toHaveLength(2);
    expect(sessionsForDay(null, SAT, 'acc')).toEqual([]);
  });
});

// v1.18.1 (LimeLog#73) — one phase rule for Today, the reminders and the
// "Next phase" button, and deload targets taken from each workout's own session.
describe('resolvePhase', () => {
  const phases = [
    { id: 'int', orderIndex: 1 },
    { id: 'acc', orderIndex: 0 },
    { id: 'peak', orderIndex: 2 },
  ] as unknown as Phase[];

  it('takes activePhaseId, and the phase after it by orderIndex', () => {
    const r = resolvePhase({ phases, activePhaseId: 'int' });
    expect([r.current?.id, r.next?.id]).toEqual(['int', 'peak']);
  });

  it('falls back to the first phase for an activePhaseId that names no phase', () => {
    // What deletePhase used to leave behind. Today showed "Next phase" from the
    // first phase; advancePhase now resolves the same way (programStore test).
    const r = resolvePhase({ phases, activePhaseId: 'deleted' });
    expect([r.current?.id, r.next?.id]).toEqual(['acc', 'int']);
  });

  it('has no next phase on the last one, and nothing without phases', () => {
    expect(resolvePhase({ phases, activePhaseId: 'peak' }).next).toBeNull();
    expect(resolvePhase({ phases: [] })).toEqual({ current: null, next: null });
  });
});

describe('phaseSessions (what the reminders are scheduled from)', () => {
  it('is the current phase\'s sessions only, not every phase\'s', () => {
    // Accumulation trains Monday and Saturday, Intensification only Saturday:
    // in Intensification, Monday gets no reminder.
    expect(phaseSessions(program, 'int').map((x) => x.id)).toEqual(['int-push-sat', 'int-pull-mon']);
    const p = { sessions: [s('acc-push-sat', 'acc', SAT), s('acc-pull-mon', 'acc', MON), s('int-push-sat', 'int', SAT)] };
    expect(phaseSessions(p, 'int').map((x) => x.id)).toEqual(['int-push-sat']);
  });

  it('keeps sessionsForDay\'s fallback for a phase with no sessions at all', () => {
    expect(phaseSessions({ sessions: [s('int-push-sat', 'int', SAT)] }, 'acc').map((x) => x.id)).toEqual(['int-push-sat']);
    expect(phaseSessions(null, 'acc')).toEqual([]);
  });
});

describe('deloadTargetReps', () => {
  const se = (id: string, exerciseId: string, targetReps: string) => ({ id, exerciseId, targetReps }) as SessionExercise;
  const prog = {
    sessions: [
      { ...s('acc-legs', 'acc', MON), exercises: [se('a1', 'squat', '8-12')] },
      { ...s('int-legs', 'int', MON), exercises: [se('i1', 'squat', '3-5')] },
    ],
  };
  const fiveRepWeek = (id: string, sessionTemplateId: string) => ({
    id, sessionTemplateId, finalizedAt: `2026-10-0${id}T11:00:00Z`,
    sets: Array.from({ length: 5 }, (_, i) => ({ id: `${id}${i}`, exerciseId: 'squat', reps: 5, completed: true })),
  }) as unknown as SessionLog;

  it('judges an Intensification workout against its own 3-5, not Accumulation\'s 8-12', () => {
    // The false banner: every prescribed 5-rep set scored as missed.
    const logs = ['1', '2', '3'].map((id) => fiveRepWeek(id, 'int-legs'));
    expect(missedRepRatio(logs, deloadTargetReps(prog, 'int'), 3)).toEqual({ ratio: 0, missedSets: 0, totalSets: 15 });
  });

  it('still judges an Accumulation workout against 8-12', () => {
    const logs = [fiveRepWeek('1', 'acc-legs')];
    expect(missedRepRatio(logs, deloadTargetReps(prog, 'int'), 3).missedSets).toBe(5);
  });

  it('uses the current phase\'s targets for a workout whose session is gone', () => {
    const logs = [fiveRepWeek('1', 'deleted')];
    expect(missedRepRatio(logs, deloadTargetReps(prog, 'int'), 3).missedSets).toBe(0);
  });

  it('follows a swap to the slot it filled', () => {
    const log = { ...fiveRepWeek('1', 'int-legs'), exerciseSwaps: { i1: 'legpress' } } as SessionLog;
    log.sets = log.sets.map((x) => ({ ...x, exerciseId: 'legpress' }));
    expect(deloadTargetReps(prog, 'acc')(log, 'legpress')).toBe('3-5');
  });
});

// v1.18.1 (LimeLog#74) — Today only showed a log of one of today's sessions
// started today, so a workout begun before midnight could not be reached after.
describe('resumableLogs', () => {
  // Monday 5 January 2026, 23:50, and Tuesday 00:10, in local time.
  const mondayNight = new Date(2026, 0, 5, 23, 50).toISOString();
  const now = new Date(2026, 0, 6, 0, 10);
  const TUE = 2;
  const week = {
    sessions: [s('mon-legs', 'acc', MON), s('tue-push', 'acc', TUE)],
  };
  const log = (id: string, sessionTemplateId: string | undefined, loggedAt: string, over: Partial<SessionLog> = {}) =>
    ({ id, sessionTemplateId, loggedAt, sets: [], perceivedFatigue: null, ...over }) as SessionLog;

  it('offers a workout started before midnight', () => {
    const today = sessionsForDay(week, TUE, 'acc');
    expect(today.map((x) => x.id)).toEqual(['tue-push']);
    const out = resumableLogs([log('late', 'mon-legs', mondayNight)], today, now);
    expect(out.map((l) => l.id)).toEqual(['late']);
  });

  it('leaves out what a session card already shows, and anything finished or cardio', () => {
    const today = sessionsForDay(week, TUE, 'acc');
    const logs = [
      log('on-card', 'tue-push', new Date(2026, 0, 6, 0, 5).toISOString()),
      log('finished', 'mon-legs', mondayNight, { finalizedAt: mondayNight }),
      log('run', undefined, mondayNight, { activityType: 'run', finalizedAt: mondayNight }),
      log('late', 'mon-legs', mondayNight),
    ];
    expect(resumableLogs(logs, today, now).map((l) => l.id)).toEqual(['late']);
  });

  const done = { sets: [{ id: 's', sessionLogId: 'l', exerciseId: 'e', setNumber: 1, weightKg: 100, reps: 5, rpe: null, completed: true }] } as Partial<SessionLog>;

  it('offers every unfinished workout, newest first, on a rest day or with no program', () => {
    const logs = [log('old', 'x', new Date(2026, 0, 2, 10).toISOString(), done), log('late', 'mon-legs', mondayNight)];
    expect(resumableLogs(logs, [], now).map((l) => l.id)).toEqual(['late', 'old']);
  });

  it('drops one older than a week, and an empty one older than a day (review)', () => {
    const logs = [
      log('stale', 'x', new Date(2025, 11, 20, 10).toISOString(), done),
      log('mistap', 'x', new Date(2026, 0, 4, 18).toISOString()),
      log('kept', 'x', new Date(2026, 0, 4, 18).toISOString(), done),
    ];
    expect(resumableLogs(logs, [], now).map((l) => l.id)).toEqual(['kept']);
  });
});
