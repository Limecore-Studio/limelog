import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RecoveryAuthState } from './recoveryGate';
import type { SessionLog } from '@/types/logging';

// v1.20 (LimeLog#110, limecore#68) — live sync: when it runs, what a hint
// pulls, and the channel's recovery.

type Cb = (...a: unknown[]) => void;
interface Sent { topic: string; event: string; payload: Record<string, unknown> }
interface FakeChannel {
  name: string;
  opts?: unknown;
  state: string;
  broadcast: Cb[];
  cb: Cb | null;
}
const h = vi.hoisted(() => ({ channels: [] as FakeChannel[], sent: [] as Sent[], tokens: [] as string[] }));
vi.mock('./supabase', () => ({
  isNexusConfigured: true,
  supabase: {
    channel(name: string, opts?: unknown) {
      const ch = {
        name,
        opts,
        state: 'joining',
        broadcast: [] as Cb[],
        cb: null as Cb | null,
        on(type: string, _f: unknown, cb: Cb) {
          if (type === 'broadcast') this.broadcast.push(cb);
          return this;
        },
        subscribe(cb: Cb) {
          this.cb = cb;
          return this;
        },
        send(msg: Omit<Sent, 'topic'>) {
          h.sent.push({ topic: name, ...msg });
          return Promise.resolve('ok');
        },
      };
      h.channels.push(ch);
      return ch;
    },
    removeChannel(ch: FakeChannel) {
      ch.state = 'closed';
      return Promise.resolve('ok');
    },
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok-2' } } }) },
    realtime: { setAuth: async (t: string) => void h.tokens.push(t) },
  },
}));

vi.stubGlobal('window', new EventTarget());
const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
vi.stubGlobal('document', doc);

const engine = await import('./liveEngine');
const { createLiveSync } = await import('./liveSync');
const { DEVICE_ID } = await import('./liveHints');

const signedIn: RecoveryAuthState = {
  configured: true, userId: 'u-1', sessionUnverified: false, signingOut: false, signOutPending: false,
};

function setup(over: Partial<RecoveryAuthState> = {}) {
  let auth: RecoveryAuthState = { ...signedIn, ...over };
  let owner: string | null = auth.userId;
  let pushed: ((t: string[]) => void) | null = null;
  const pulls: string[] = [];
  const applied: SessionLog[][] = [];
  let release: (() => void) | null = null;
  let holdPull = false;
  const live = createLiveSync({
    read: () => auth,
    ready: (uid) => owner === uid,
    pull: async (uid) => {
      pulls.push(uid);
      if (holdPull) await new Promise<void>((r) => { release = r; });
      return [{ id: 'w-1' } as SessionLog];
    },
    apply: (logs) => { applied.push(logs); return logs.length; },
    load: async () => engine,
    onPushed: (l) => { pushed = l; return () => {}; },
  });
  return {
    live,
    pulls,
    applied,
    set: (next: Partial<RecoveryAuthState>) => { auth = { ...auth, ...next }; },
    setOwner: (o: string | null) => { owner = o; },
    push: (t: string[]) => pushed!(t),
    hold: () => { holdPull = true; },
    release: () => release?.(),
  };
}

const chans = () => h.channels.filter((c) => c.name === 'user:u-1');
const last = () => chans()[chans().length - 1];
const deliver = (payload: unknown) => last().broadcast.forEach((cb: Cb) => cb({ payload }));

beforeEach(() => {
  vi.useFakeTimers();
  h.channels.length = 0;
  h.sent.length = 0;
  h.tokens.length = 0;
});
afterEach(() => {
  engine.stopLive();
  vi.useRealTimers();
});

describe('when live sync runs', () => {
  it('joins the private topic for a confirmed, signed-in owner', async () => {
    const s = setup();
    s.live.evaluate();
    await vi.advanceTimersByTimeAsync(0);
    expect(chans()).toHaveLength(1);
    expect(chans()[0].opts).toEqual({ config: { private: true, broadcast: { self: false } } });
  });

  it.each([
    ['an unconfirmed session', { sessionUnverified: true }],
    ['a sign-out in progress', { signingOut: true }],
    ['a guest', { userId: null }],
  ])('does not run for %s', async (_n, over) => {
    const s = setup(over as Partial<RecoveryAuthState>);
    s.live.evaluate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.channels).toHaveLength(0);
  });

  it('waits until the local data is this account\'s', async () => {
    const s = setup();
    s.setOwner(null);
    s.live.evaluate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.channels).toHaveLength(0);
    s.setOwner('u-1');
    s.live.evaluate();
    await vi.advanceTimersByTimeAsync(0);
    expect(chans()).toHaveLength(1);
  });

  it('stops on sign-out', async () => {
    const s = setup();
    s.live.evaluate();
    await vi.advanceTimersByTimeAsync(0);
    s.set({ userId: null });
    s.live.evaluate();
    expect(chans()[0].state).toBe('closed');
  });
});

describe('hints', () => {
  it('a workout hint from another device pulls workouts once, after 300 ms', async () => {
    const s = setup();
    s.live.evaluate();
    await vi.advanceTimersByTimeAsync(0);
    last().cb!('SUBSCRIBED');
    deliver({ app: 'limelog', table: 'workout_sessions', device: 'phone-2' });
    deliver({ app: 'limelog', table: 'workout_sets', device: 'phone-2' });
    deliver({ app: 'limelog', table: 'workout_sessions', device: DEVICE_ID });
    deliver({ app: 'ncc', table: 'transactions', device: 'ncc' });
    await vi.advanceTimersByTimeAsync(299);
    expect(s.pulls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.pulls).toEqual(['u-1']);
    expect(s.applied).toHaveLength(1);
  });

  it('a pull that finishes after a sign-out is dropped', async () => {
    const s = setup();
    s.live.evaluate();
    await vi.advanceTimersByTimeAsync(0);
    last().cb!('SUBSCRIBED');
    s.hold();
    deliver({ table: 'workout_sessions', device: 'phone-2' });
    await vi.advanceTimersByTimeAsync(300);
    s.set({ signingOut: true });
    s.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.pulls).toEqual(['u-1']);
    expect(s.applied).toEqual([]);
  });

  it('announces pushes once joined, names only', async () => {
    const s = setup();
    s.live.evaluate();
    await vi.advanceTimersByTimeAsync(0);
    s.push(['workout_sessions']);
    expect(h.sent).toEqual([]);
    last().cb!('SUBSCRIBED');
    s.push(['workout_sessions', 'workout_sets']);
    expect(h.sent.map((m) => [m.topic, m.event, m.payload.app, m.payload.table, m.payload.device])).toEqual([
      ['user:u-1', 'changed', 'limelog', 'workout_sessions', DEVICE_ID],
      ['user:u-1', 'changed', 'limelog', 'workout_sets', DEVICE_ID],
    ]);
    expect(Object.keys(h.sent[0].payload).sort()).toEqual(['app', 'at', 'device', 'table']);
  });
});

describe('channel lifecycle', () => {
  it('rejoins with backoff after an error, with a fresh token, and resyncs', async () => {
    const s = setup();
    s.live.evaluate();
    await vi.advanceTimersByTimeAsync(0);
    last().cb!('SUBSCRIBED');
    expect(s.pulls).toEqual([]);
    last().cb!('CHANNEL_ERROR', new Error('socket closed'));
    await vi.advanceTimersByTimeAsync(999);
    expect(chans()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(chans()).toHaveLength(2);
    expect(h.tokens).toEqual(['tok-2']);
    last().cb!('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.pulls).toEqual(['u-1']);
  });

  it.each(['resume', 'visibilitychange', 'online'])('rejoins at once on %s', async (event) => {
    const s = setup();
    s.live.evaluate();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i++) {
      last().cb!('TIMED_OUT');
      await vi.advanceTimersByTimeAsync(30_000);
    }
    last().cb!('TIMED_OUT');
    const before = chans().length;
    (event === 'online' ? (window as unknown as EventTarget) : doc).dispatchEvent(new Event(event));
    await vi.advanceTimersByTimeAsync(0);
    expect(chans()).toHaveLength(before + 1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(chans()).toHaveLength(before + 1);
  });

  it('stands down when Realtime Authorization refuses the topic', async () => {
    const s = setup();
    s.live.evaluate();
    await vi.advanceTimersByTimeAsync(0);
    last().cb!('CHANNEL_ERROR', new Error('Unauthorized: You do not have permissions to read from this Channel topic: user:u-1'));
    await vi.advanceTimersByTimeAsync(60_000);
    doc.dispatchEvent(new Event('resume'));
    await vi.advanceTimersByTimeAsync(0);
    expect(chans()).toHaveLength(1);
  });
});
