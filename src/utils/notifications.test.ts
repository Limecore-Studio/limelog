import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionTemplate } from '@/types/program';

// v1.19 (LL#63) — what the weekly reminder actually asks the plugin for, and
// in what order. @capacitor/local-notifications 8.0.2 turns `at` + `repeats`
// into setRepeating(RTC, at, at - now): a "weekly" reminder that repeated at
// whatever the lead time was when the app last scheduled it.

const LN = vi.hoisted(() => ({
  createChannel: vi.fn(async () => {}),
  registerActionTypes: vi.fn(async () => {}),
  getPending: vi.fn(async () => ({ notifications: [] })),
  cancel: vi.fn(async () => {}),
  schedule: vi.fn(async () => ({ notifications: [] })),
  requestPermissions: vi.fn(async () => ({ display: 'granted' })),
  checkPermissions: vi.fn(async () => ({ display: 'granted' })),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: LN }));
vi.mock('@/i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('@/utils/helpers', () => ({ weekdayNames: () => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] }));

const NOW = new Date(2026, 9, 10, 12, 0, 0); // local noon
const session = (dayOfWeek: number) =>
  ({ id: `s${dayOfWeek}`, phaseId: 'p', name: 'Push', dayOfWeek, orderIndex: 0, exercises: [] }) as unknown as SessionTemplate;

async function load() {
  vi.resetModules(); // the setup memo and the schedule queue are module state
  return import('./notifications');
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const fn of Object.values(LN)) fn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('scheduleWorkoutReminders', () => {
  it('schedules a one-shot exact alarm for the next occurrence, not a repeating one', async () => {
    const { scheduleWorkoutReminders } = await load();
    const day = (NOW.getDay() + 2) % 7;
    await scheduleWorkoutReminders([session(day)]);

    expect(LN.schedule).toHaveBeenCalledTimes(1);
    const [n] = (LN.schedule.mock.calls[0] as unknown as [{ notifications: { id: number; schedule: object }[] }])[0].notifications;
    expect(n.id).toBe(100 + day);
    expect(n.schedule).toEqual({ at: new Date(2026, 9, 12, 9, 0, 0, 0), allowWhileIdle: true });
    expect(n.schedule).not.toHaveProperty('repeats');
    expect(n.schedule).not.toHaveProperty('every');
  });

  it("arms next week's alarm when today's 9:00 has passed", async () => {
    const { scheduleWorkoutReminders } = await load();
    await scheduleWorkoutReminders([session(NOW.getDay())]);
    const [n] = (LN.schedule.mock.calls[0] as unknown as [{ notifications: { schedule: { at: Date } }[] }])[0].notifications;
    expect(n.schedule.at).toEqual(new Date(2026, 9, 17, 9, 0, 0, 0));
  });

  it('waits for the start-up sweep, so the sweep cannot cancel what it schedules', async () => {
    const channel = deferred();
    LN.createChannel.mockImplementationOnce(() => channel.promise);
    const { setupNotificationChannel, scheduleWorkoutReminders } = await load();

    void setupNotificationChannel(); // as App.tsx calls it: not awaited
    const scheduled = scheduleWorkoutReminders([session(1)]);
    await Promise.resolve();
    await Promise.resolve();
    expect(LN.requestPermissions).not.toHaveBeenCalled();
    expect(LN.schedule).not.toHaveBeenCalled();

    channel.resolve();
    await scheduled;
    expect(LN.createChannel).toHaveBeenCalledTimes(1); // memoised, not re-run by the schedule
    expect(LN.cancel).toHaveBeenCalledTimes(2); // the start-up sweep, then the schedule's own
    const lastCancel = Math.max(...LN.cancel.mock.invocationCallOrder);
    expect(LN.schedule.mock.invocationCallOrder[0]).toBeGreaterThan(lastCancel);
  });

  it('runs overlapping calls in order, so the newer program wins', async () => {
    const slow = deferred();
    LN.requestPermissions.mockImplementationOnce(async () => {
      await slow.promise;
      return { display: 'granted' };
    });
    const { scheduleWorkoutReminders } = await load();
    const first = scheduleWorkoutReminders([session(1)]);
    const second = scheduleWorkoutReminders([session(2)]);
    slow.resolve();
    await Promise.all([first, second]);
    const ids = (LN.schedule.mock.calls as unknown as [{ notifications: { id: number }[] }][]).map(
      ([arg]) => arg.notifications[0].id,
    );
    expect(ids).toEqual([101, 102]);
  });

  it('the resume re-arm never raises the permission dialog', async () => {
    const { scheduleWorkoutReminders } = await load();
    await scheduleWorkoutReminders([session(1)], [], { prompt: false });
    expect(LN.requestPermissions).not.toHaveBeenCalled();
    expect(LN.checkPermissions).toHaveBeenCalledTimes(1);
    expect(LN.schedule).toHaveBeenCalledTimes(1);

    LN.checkPermissions.mockResolvedValueOnce({ display: 'denied' });
    await scheduleWorkoutReminders([session(1)], [], { prompt: false });
    expect(LN.schedule).toHaveBeenCalledTimes(1);
  });
});
