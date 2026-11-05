// v1.20 (LimeLog#110) — the live-sync channel: the private `user:<uid>` hint
// topic (liveHints.ts), and its lifecycle. Loaded on demand by liveSync.ts once
// a user is signed in, so none of it counts against the startup bundle.
//
// LimeLog binds no postgres_changes (limecore#24: every bound table would have
// to be in the publication, and LimeLog only ever reads its own workouts). The
// hint channel is the whole of it:
//   - after a successful push, one `changed` per table written goes out, so NCC
//     and the user's other devices pull at once instead of on their next sync;
//   - a hint for workouts from another device pulls them here.
//
// A channel that drops is removed and joined again, backing off 1 s → 30 s,
// and at once on resume, visibilitychange or online. Every rejoin after the
// first runs `onResync`, to cover what was missed while it was down.

import type { RealtimeChannel } from '@supabase/supabase-js';
import type { SessionLog } from '@/types/logging';
import { supabase } from './supabase';
import { HINT_APP, HINT_EVENT, DEVICE_ID, hintTopic, tablesFromHint, backoffMs } from './liveHints';

export interface LiveOptions {
  userId: string;
  /** Still the account live sync started for (see liveSync.ts). */
  isCurrent: () => boolean;
  /** The recovery pull, and what reinstates its result. */
  pull: (userId: string) => Promise<SessionLog[]>;
  apply: (logs: SessionLog[]) => number;
}

const HINT_COALESCE_MS = 300;

interface Live extends LiveOptions {
  refreshing: boolean;
  again: boolean;
  channel: RealtimeChannel | null;
  joined: boolean;
  joinedOnce: boolean;
  refused: boolean;
  attempt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  batch: Set<string>;
  batchTimer: ReturnType<typeof setTimeout> | null;
  detach: () => void;
}
let live: Live | null = null;

/**
 * Pull workouts and reinstate what is missing, for a hint or a resync. One at a
 * time; a request during a run gets one more. A result that arrives after the
 * account changed is dropped, as in the recovery gate.
 */
async function refresh(session: Live): Promise<void> {
  if (session.refreshing) {
    session.again = true;
    return;
  }
  session.refreshing = true;
  try {
    do {
      session.again = false;
      if (live !== session || !session.isCurrent()) return;
      const logs = await session.pull(session.userId);
      if (live === session && session.isCurrent()) session.apply(logs);
    } while (session.again);
  } catch (e) {
    console.warn('[live] workout pull failed:', e instanceof Error ? e.message : e);
  } finally {
    session.refreshing = false;
  }
}

async function refreshRealtimeAuth(): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (token) await supabase.realtime.setAuth(token);
  } catch {
    /* the join reports its own failure */
  }
}

export function startLive(opts: LiveOptions): void {
  if (live?.userId === opts.userId) return;
  if (live) stopLive();
  const session: Live = {
    ...opts,
    refreshing: false,
    again: false,
    channel: null,
    joined: false,
    joinedOnce: false,
    refused: false,
    attempt: 0,
    retryTimer: null,
    batch: new Set(),
    batchTimer: null,
    detach: () => {},
  };
  live = session;
  join(session);

  // `resume` is Capacitor's own foreground event on Android; the WebView's
  // visibilitychange is not always delivered after a long pause.
  const revive = () => reviveChannel(session);
  const onVisible = () => {
    if (document.visibilityState === 'visible') revive();
  };
  window.addEventListener('online', revive);
  document.addEventListener('visibilitychange', onVisible);
  document.addEventListener('resume', revive);
  session.detach = () => {
    window.removeEventListener('online', revive);
    document.removeEventListener('visibilitychange', onVisible);
    document.removeEventListener('resume', revive);
  };
}

function join(session: Live): void {
  const c = supabase.channel(hintTopic(session.userId), {
    config: { private: true, broadcast: { self: false } },
  });
  c.on('broadcast', { event: HINT_EVENT }, (msg: { payload?: unknown }) => {
    const tables = tablesFromHint(msg?.payload);
    if (tables.length === 0 || live !== session) return;
    for (const t of tables) session.batch.add(t);
    if (session.batchTimer) return;
    session.batchTimer = setTimeout(() => {
      session.batchTimer = null;
      session.batch.clear();
      void refresh(session);
    }, HINT_COALESCE_MS);
  });
  session.channel = c;
  c.subscribe((status, err) => {
    if (live !== session || session.channel !== c) return;
    if (status === 'SUBSCRIBED') {
      session.attempt = 0;
      session.joined = true;
      if (session.joinedOnce) void refresh(session);
      session.joinedOnce = true;
      return;
    }
    session.joined = false;
    session.channel = null;
    void supabase.removeChannel(c);
    // Refused by Realtime Authorization: the server does not have the
    // `realtime.messages` policy yet (limecore#68). Retrying cannot fix that.
    // Pushes still go out; the other apps just learn of them a little later.
    if (/unauthori[sz]ed|permission/i.test(err?.message ?? '')) {
      session.refused = true;
      console.info('[live] hints unavailable:', err?.message);
      return;
    }
    console.warn(`[live] channel ${status}`, err?.message ?? '');
    scheduleRejoin(session);
  });
}

function scheduleRejoin(session: Live): void {
  if (session.retryTimer) return;
  session.retryTimer = setTimeout(() => {
    session.retryTimer = null;
    void rejoin(session);
  }, backoffMs(session.attempt++));
}

async function rejoin(session: Live): Promise<void> {
  await refreshRealtimeAuth();
  if (live !== session || session.channel || session.refused) return;
  join(session);
}

/** Foreground or back online: rejoin now if the channel is not live. */
function reviveChannel(session: Live): void {
  if (live !== session || session.refused) return;
  const c = session.channel;
  if (c && c.state !== 'closed' && c.state !== 'errored') return;
  if (c) {
    session.channel = null;
    session.joined = false;
    void supabase.removeChannel(c);
  }
  if (session.retryTimer) clearTimeout(session.retryTimer);
  session.retryTimer = null;
  session.attempt = 0;
  void rejoin(session);
}

/**
 * Tell this user's other devices and apps which tables a push just wrote.
 * Called from the outbox's pushed listener, so a failed push announces
 * nothing. A no-op until the channel is joined: a send on an unjoined channel
 * would fall back to a REST call per table.
 */
export function announceChanged(tables: string[]): void {
  const c = live?.channel;
  if (!live?.joined || !c) return;
  const at = Date.now();
  for (const table of new Set(tables)) {
    void Promise.resolve(
      c.send({ type: 'broadcast', event: HINT_EVENT, payload: { app: HINT_APP, table, at, device: DEVICE_ID } }),
    ).catch(() => {
      /* a lost hint costs only latency */
    });
  }
}

export function stopLive(): void {
  const session = live;
  live = null;
  if (!session) return;
  session.detach();
  if (session.retryTimer) clearTimeout(session.retryTimer);
  if (session.batchTimer) clearTimeout(session.batchTimer);
  if (session.channel) void supabase.removeChannel(session.channel);
  session.channel = null;
}
