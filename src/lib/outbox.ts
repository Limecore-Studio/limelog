// ── LimeLog v1.2 offline outbox ──────────────────────────────────────────────
//
// Ported from StudyDesk v1.1's outbox.js — same single-flight drain, same
// attempt cap, same cached-status discipline for useSyncExternalStore. The
// LimeLog-specific shape:
//
//   - Two kinds today: `upsert_workout_session` (the existing finalize push)
//     and `delete_workout_session` (a tombstone, enqueued when a workout is
//     discarded — v1.16, limelog#32). Add more here as edit/delete surfaces
//     ship.
//   - Drain triggers: `online`, `visibilitychange` (Capacitor bridges Android
//     `onResume` into the WebView's visibility events), app mount, post-sign-in,
//     manual "Retry now" button.
//   - Idempotency contract: every kind is UPSERT-style (`pushWorkoutToNexus`
//     creates a new session ID inside the handler, but the outbox item is
//     idempotent end-to-end because the payload doesn't yet reference a remote
//     ID — the retry creates a fresh row with the same data, no duplicate risk
//     because the prior call failed before the row landed). For `delete_*`,
//     the write is idempotent too: a DELETE, or for workouts a tombstone
//     UPDATE, lands the same way however many times it is retried.
//   - One-shot migration: legacy `wt_nexus_pending` items (pre-v1.2) are read
//     once on module load and re-enqueued as `upsert_workout_session`, then
//     the old key is cleared. No data loss on upgrade.
//
// Storage shape (localStorage `limelog-outbox`):
//   [ { id, createdAt, kind, payload, attempts, lastAttemptAt?, lastError? } ]
//
// Items at MAX_ATTEMPTS go to the back of the queue rather than dropping —
// silent data loss is worse than a stuck queue surfaced in the UI.

import {
  pushWorkoutToNexus,
  pushBodyMetricToNexus,
  deleteBodyMetricFromNexus,
  pushExercisePRToNexus,
  pushFeedbackToNexus,
  pushAppOpenToNexus,
  requireSessionUser,
  AccountChangedError,
  type NexusWorkoutPayload,
  type NexusBodyMetricPayload,
  type NexusExercisePRPayload,
  type NexusFeedbackPayload,
  type NexusAppOpenPayload,
} from './nexusSync';
import { supabase, isNexusConfigured } from './supabase';
import { readOwner } from './accountOwner';

const STORAGE_KEY = 'limelog-outbox';
const META_KEY = 'limelog-outbox-meta';
const LEGACY_KEY = 'wt_nexus_pending'; // pre-v1.2 PendingPush queue
const MAX_ATTEMPTS = 5;

// ── Types ─────────────────────────────────────────────────────────────────

type OutboxKind =
  | 'upsert_workout_session'
  | 'delete_workout_session'
  // v1.2 — Body Metrics. Same upsert/delete pair pattern.
  | 'upsert_body_metric'
  | 'delete_body_metric'
  // v1.6 — Personal Records. Push-only (append-only), upsert by id.
  | 'upsert_exercise_pr'
  // v1.10 - in-app feedback. Insert-only; idempotent on the client id.
  | 'submit_feedback'
  // v1.12 Item 0 - retention. Queued rather than pushed directly because a
  // cold start can foreground before the Nexus session has been adopted, and
  // RLS rejects the write with no session; offline is the same story.
  | 'record_app_open';

interface OutboxItem<K extends OutboxKind = OutboxKind> {
  id: string;
  createdAt: string;
  kind: K;
  payload: KindPayload[K];
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
}

interface KindPayload {
  upsert_workout_session: NexusWorkoutPayload;
  delete_workout_session: { id: string };
  upsert_body_metric: NexusBodyMetricPayload;
  delete_body_metric: { id: string; date?: string };
  upsert_exercise_pr: NexusExercisePRPayload;
  submit_feedback: NexusFeedbackPayload;
  record_app_open: NexusAppOpenPayload;
}

interface OutboxMeta {
  lastSuccessAt?: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
}

export interface OutboxStatus {
  pending: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  oldestEnqueuedAt: string | null;
  /** Items that have hit MAX_ATTEMPTS — surface as stuck-queue warning. */
  stuck: number;
}

// ── Storage helpers ───────────────────────────────────────────────────────

function loadItems(): OutboxItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveItems(items: OutboxItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch (e) {
    // Quota-exceeded is unrecoverable for the outbox — log and continue.
    // The next mutation will overwrite + try again with whatever fits.
     
    console.error('[outbox] storage write failed:', e);
  }
  cachedStatus = null;
}

function loadMeta(): OutboxMeta {
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? (JSON.parse(raw) as OutboxMeta) : {};
  } catch {
    return {};
  }
}

function saveMeta(meta: OutboxMeta): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch { /* see saveItems */ }
  cachedStatus = null;
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Public API ────────────────────────────────────────────────────────────

/** Enqueue a mutation for upstream sync. Triggers an immediate drain attempt.
 *  Returns synchronously — does NOT block on the drain. Failure surfaces via
 *  the meta + Settings panel; callers don't need to await.
 */
// v1.16 (limecore#27, registry P6) — stamp the SAVE, not the send.
//
// The session push used `updated_at: now` at SEND time, so a workout saved
// offline and pushed hours later arrived newer than an edit made in between
// on another device, and overwrote it. The stamp is taken here, when the save
// is enqueued, and each save of one session is stamped strictly later than the
// last even if the clock steps backwards — `max(now, previous + 1 ms)`.
//
// LimeLog is push-only: it never pulls a session back to edit it (the
// recovery pull only restores), so the only stamps it has seen for a session
// are its own. Memory only; after a restart the plain clock is used, which is
// what every push did before.
const lastStamp = new Map<string, number>();

function stampWorkout(payload: NexusWorkoutPayload): NexusWorkoutPayload {
  const now = Date.now();
  const prev = lastStamp.get(payload.sessionId);
  const at = prev !== undefined && now <= prev ? prev + 1 : now;
  lastStamp.set(payload.sessionId, at);
  return { ...payload, updatedAt: new Date(at).toISOString() };
}

/** Test seam. */
export function resetWorkoutStamps(): void {
  lastStamp.clear();
}

export function enqueue<K extends OutboxKind>(kind: K, payload: KindPayload[K]): void {
  if (!KIND_DISPATCH[kind]) {
     
    console.error('[outbox] unknown kind:', kind);
    return;
  }
  if (kind === 'upsert_workout_session') {
    payload = stampWorkout(payload as NexusWorkoutPayload) as KindPayload[K];
  }
  const items = loadItems();
  items.push({
    id: makeId(),
    createdAt: new Date().toISOString(),
    kind,
    payload,
    attempts: 0,
  });
  saveItems(items);
  // Fire-and-forget drain. Single-flight inside drain() coalesces overlapping
  // calls so this is safe even if many enqueues land in quick succession.
  void drain();
}

let draining = false;

/** Process pending items oldest-first. Coalesces concurrent calls via the
 *  `draining` flag. Stops on the first persistent failure to avoid burning
 *  through the queue with the same network error.
 *
 *  Returns the new queue depth so callers can decide whether to flash a
 *  result message. */
export async function drain(): Promise<{ sent: number; remaining: number }> {
  if (draining) return { sent: 0, remaining: loadItems().length };
  // Limekana/limelog#28 — claimed BEFORE the first await. The flag used to be
  // set only after `getUser()` below, a network round trip, so every drain()
  // fired meanwhile (each enqueue fires one; finishing a workout enqueues
  // several) passed the check and ran the same queue head in parallel: five
  // parallel pushes of one workout in production, and parallel loops writing
  // stale queue snapshots back over items enqueued in between. The early
  // exits below are inside the try so `finally` always releases it.
  draining = true;
  let sent = 0;
  try {
    // Skip if offline — items stay queued. `online` event will re-trigger.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { sent: 0, remaining: loadItems().length };
    }
    // Skip if Supabase not configured — nothing to push to.
    if (!isNexusConfigured) {
      return { sent: 0, remaining: loadItems().length };
    }
    // Skip if no auth session — let post-sign-in path re-trigger.
    // (drainPendingQueue legacy did the same gate.)
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { sent: 0, remaining: loadItems().length };
    // v1.18.1 (LimeLog#88) — the queue is sent only under the account it
    // belongs to. Every drain comes through here (enqueue, `online`,
    // `visibilitychange`, init, sign-in, Retry now), so this one check covers
    // them all. It only checks: taking the data up (and clearing another
    // account's) is left to the auth paths in nexusStore, which do it before
    // the account is set. This reply may be stale — a getUser() still in
    // flight when another account signed in — and claiming from it would
    // clear the newer account's data. No owner yet means not taken up yet:
    // send nothing and wait for the auth path to take it up.
    if (readOwner() !== user.id) return { sent: 0, remaining: loadItems().length };

    for (;;) {
      // And before each item: an explicit sign-out (record cleared) or another
      // account taking the data up while this pass awaited a push ends it.
      if (readOwner() !== user.id) break;
      const items = loadItems();
      if (items.length === 0) break;
      const item = items[0];
      const handler = KIND_DISPATCH[item.kind];
      if (!handler) {
        // Unknown kind — came from an older app version or a typo. Log + drop
        // so we notice in dev but the queue stays healthy.
         
        console.error('[outbox] dropping item with unknown kind:', item.kind);
        saveItems(items.slice(1));
        continue;
      }
      let failure: unknown = null;
      try {
        await handler(item.payload as never, user.id);
      } catch (e) {
        failure = e;
      }
      // v1.18.1 (LimeLog#88) — nothing is written back once the queue has
      // changed hands during the push: a push can hang (no fetch timeout)
      // across a sign-out or another account's arrival, and re-saving the
      // item, or its retry state, into the emptied queue would let the next
      // drain send it under the new account. Nor does a push that found
      // another account signed in count as a failed attempt.
      if (readOwner() !== user.id || failure instanceof AccountChangedError) break;
      if (failure === null) {
        // Success — remove THIS item from the queue as it is now, not from the
        // snapshot read before the push: anything enqueued during the await
        // would otherwise be overwritten out of storage (limelog#28).
        saveItems(loadItems().filter((i) => i.id !== item.id));
        saveMeta({ ...loadMeta(), lastSuccessAt: new Date().toISOString(), lastError: null });
        sent++;
      } else {
        const e = failure;
        const attempts = (item.attempts || 0) + 1;
        const errMsg = (e instanceof Error ? e.message : String(e));
        const failed = { ...item, attempts, lastAttemptAt: new Date().toISOString(), lastError: errMsg };
        // Same rule as the success path: rebuild from the live queue so items
        // enqueued during the await survive (limelog#28).
        const others = loadItems().filter((i) => i.id !== item.id);
        // At ceiling? Move to the back of the queue so subsequent items can
        // still attempt. We never silently drop — the stuck-queue warning in
        // Settings surfaces this.
        saveItems(attempts >= MAX_ATTEMPTS ? [...others, failed] : [failed, ...others]);
        saveMeta({ ...loadMeta(), lastError: errMsg, lastErrorAt: new Date().toISOString() });
        // Stop the drain pass — most likely the next item would hit the same
        // error. Next trigger (online / visibility / manual) tries again.
        break;
      }
    }
  } finally {
    draining = false;
  }
  return { sent, remaining: loadItems().length };
}

// v1.2 — cached snapshot. Same stable-reference contract as StudyDesk's:
// `useSyncExternalStore` requires getSnapshot to return a stable reference
// between actual state changes. Returning a fresh object each call would
// cause an infinite render loop.
let cachedStatus: OutboxStatus | null = null;

/** Current queue depth + meta for the Settings panel. */
export function getStatus(): OutboxStatus {
  if (cachedStatus) return cachedStatus;
  const items = loadItems();
  const meta = loadMeta();
  cachedStatus = {
    pending: items.length,
    lastSuccessAt: meta.lastSuccessAt ?? null,
    lastError: meta.lastError ?? null,
    lastErrorAt: meta.lastErrorAt ?? null,
    oldestEnqueuedAt: items[0]?.createdAt ?? null,
    stuck: items.filter((i) => (i.attempts || 0) >= MAX_ATTEMPTS).length,
  };
  return cachedStatus;
}

/** Clear the outbox. Called on auth sign-out — we don't want to retry the
 *  signed-out user's pending writes as the next signed-in user. */
/** v1.18.1 (LimeLog#88) — record why the queue is not being sent, for the
 *  Settings panel (sync.lastError), when no push has failed to say so. */
export function noteError(message: string): void {
  saveMeta({ ...loadMeta(), lastError: message, lastErrorAt: new Date().toISOString() });
}

// v1.18.1 (LimeLog#88) — false when storage refused, so an account switch
// can tell a clear that did not happen (accountWipe.ts).
export function clear(): boolean {
  cachedStatus = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(META_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Wire `online` + `visibilitychange` drain triggers. Idempotent — safe to
 *  call multiple times (e.g. from React StrictMode double-mount). Returns a
 *  teardown helper for unit tests / hot reload. */
export function installDrainTriggers(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onOnline = () => void drain();
  const onVis = () => {
    if (document.visibilityState === 'visible') void drain();
  };
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVis);
  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVis);
  };
}

// ── Legacy migration ──────────────────────────────────────────────────────
//
// Pre-v1.2 LimeLog stored a flat array of PendingPush at `wt_nexus_pending`.
// Read it once on module load, re-enqueue every item as the v1.2 kind, and
// clear the legacy key. Safe across re-runs — once the legacy key is empty,
// this is a no-op.
//
// PendingPush shape (legacy): { id: string; payload: NexusWorkoutPayload; createdAt: string }

interface LegacyPendingPush {
  id: string;
  payload: NexusWorkoutPayload;
  createdAt: string;
}

function migrateLegacyQueue(): void {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) {
      localStorage.removeItem(LEGACY_KEY);
      return;
    }
    const items = loadItems();
    for (const legacy of arr as LegacyPendingPush[]) {
      items.push({
        id: legacy.id || makeId(),
        createdAt: legacy.createdAt || new Date().toISOString(),
        kind: 'upsert_workout_session',
        payload: legacy.payload,
        attempts: 0,
      });
    }
    saveItems(items);
    localStorage.removeItem(LEGACY_KEY);
     
    console.log(`[outbox] migrated ${arr.length} legacy items from ${LEGACY_KEY}`);
  } catch (e) {
     
    console.warn('[outbox] legacy migration failed:', e);
  }
}

// Run migration on module load. Module-level execution happens once per app
// session at the import boundary — exactly what we want.
migrateLegacyQueue();

// ── Kind dispatch ─────────────────────────────────────────────────────────
//
// Each kind maps to its handler. The payload shape MUST match the handler's
// expectations. New mutation type? Add a kind to the OutboxKind union, the
// KindPayload map, and an entry here. Existing call sites in logStore /
// nexusStore route through `enqueue('kind', payload)`.

// v1.18.1 (LimeLog#88) — each handler gets the account the drain is sending
// for, and refuses (AccountChangedError) when the session is now another's.
const KIND_DISPATCH: { [K in OutboxKind]: (p: KindPayload[K], forUserId: string) => Promise<unknown> } = {
  upsert_workout_session: (p, uid) => pushWorkoutToNexus(p, uid),
  delete_workout_session: async (p, uid) => {
    if (!isNexusConfigured) throw new Error('Nexus not configured');
    await requireSessionUser(uid);
    // v1.16 (limelog#32, registry P6) — a tombstone, never a DELETE. A hard
    // delete left nothing behind, so a later push of the same workout from
    // another device simply inserted it again. The server's guard lets a
    // tombstone land whatever its stamp, and a workout upsert never sends
    // `deleted_at`, so it cannot un-delete one. NCC's pull filters tombstoned
    // sessions out (and prunes their sets); `purge_soft_deleted()` removes the
    // row after 90 days, and its sets cascade with it then. Matching no row —
    // a workout that was never pushed — is a no-op, not an error.
    const stamp = new Date().toISOString();
    const { error } = await supabase
      .from('workout_sessions')
      .update({ deleted_at: stamp, updated_at: stamp })
      .eq('id', p.id);
    if (error) throw error;
  },
  upsert_body_metric: (p, uid) => pushBodyMetricToNexus(p, uid),
  delete_body_metric: (p, uid) => deleteBodyMetricFromNexus(p.id, p.date, uid),
  upsert_exercise_pr: (p, uid) => pushExercisePRToNexus(p, uid),
  submit_feedback: (p, uid) => pushFeedbackToNexus(p, uid),
  record_app_open: (p, uid) => pushAppOpenToNexus(p, uid),
};
