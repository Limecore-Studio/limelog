// v1.20 Block A (LimeLog#110, limecore#68) — live sync v2: the hint protocol.
//
// Every signed-in device joins the private Realtime topic `user:<uid>`. After
// a successful push it broadcasts one `changed` event per table it wrote, and
// the other devices pull just those tables. The payload names tables, never
// rows: the data always comes from an RLS-scoped pull.
//
//     { app: 'limelog', table: 'workout_sessions', at: <epoch ms>, device: <id> }
//
// NCC reads workouts and pulls on these hints; StudyDesk ignores them. LimeLog
// itself only ever reads workouts (nexusRecovery.ts), so the only hints it acts
// on are for a workout finished on another of the user's devices.

export const HINT_EVENT = 'changed';
export const HINT_APP = 'limelog';

/** The private topic for a user. Realtime Authorization only lets the user's
 *  own JWT join or send on it (realtime.messages RLS, limecore#68). */
export const hintTopic = (userId: string): string => `user:${userId}`;

/** The tables a hint can make LimeLog pull: the two the workout pull reads. */
export const PULLED_TABLES: ReadonlySet<string> = new Set(['workout_sessions', 'workout_sets']);

/** This page's id. `broadcast.self: false` already keeps a channel's own sends
 *  from coming back to it; the id covers a second channel instance in the same
 *  page (a rejoin racing the old one). */
export const DEVICE_ID: string = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `d-${Math.random().toString(36).slice(2)}`;
  }
})();

/** The tables a hint asks LimeLog to pull, or [] for one to ignore: its own
 *  echo, malformed, or a table LimeLog does not read. */
export function tablesFromHint(payload: unknown, ownDevice: string = DEVICE_ID): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as { table?: unknown; device?: unknown };
  if (p.device && p.device === ownDevice) return [];
  return typeof p.table === 'string' && PULLED_TABLES.has(p.table) ? [p.table] : [];
}

/** Rejoin delay after the n-th consecutive failure: 1 s, 2 s, 4 s … 30 s. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
}
