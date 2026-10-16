// GDPR data-subject rights — Article 20 (portability) and Article 17 (erasure).
//
// Ported from StudyDesk's src/lib/dataRights.js, which shipped these first. The
// suite shares one account and one database, so the Edge Function and the
// cascade behaviour are identical; only the local-data shape differs.
//
// Export works signed in or as a guest: a guest's data lives only on the device,
// and it is still their data. Deletion only means anything when there is a
// server-side account to delete.

import { storage } from '@/utils/storage';
import { supabase, isNexusConfigured } from './supabase';
import { listPhotos } from './progressPhotos';
import { selectAll } from './selectAll';

const EXPORT_SCHEMA_VERSION = 1;

interface ExportPayload {
  schemaVersion: number;
  exportedAt: string;
  application: string;
  account: Record<string, unknown>;
  counts: Record<string, number>;
  notes: Record<string, string>;
  data: Record<string, unknown>;
  server?: Record<string, unknown[] | { error: string }>;
}

/**
 * v1.16 (limecore#16) — the two things we hold that exist ONLY on the server:
 * feedback the user sent, and error reports (kept 90 days). Neither is in
 * local storage, so an export built from it alone would omit them, and the
 * privacy policy (NCC#50) promises the export includes both. Signed-in only;
 * a guest has sent neither. A failed read is recorded in the export rather
 * than dropped, so an incomplete export says so.
 */
export const SERVER_ONLY_TABLES = ['feedback', 'client_errors'] as const;

// v1.18.1 (LimeLog#76): signed-in users may read only these columns of
// `feedback` (the grant in StudyDesk's 20261005_feedback_status_columns
// migration). `select('*')` and the user_id filter both asked for a column
// outside it, so the export held "permission denied" instead of the user's
// feedback. RLS already limits the rows to the user's own. `client_errors` still has every column granted,
// user_id included. Same list as NCC's and StudyDesk's.
export const FEEDBACK_EXPORT_COLUMNS = 'id, app, app_version, category, rating, message, status, shipped_in, created_at';

export async function serverOnlyData(userId: string): Promise<Record<string, unknown[] | { error: string }>> {
  const out: Record<string, unknown[] | { error: string }> = {};
  for (const table of SERVER_ONLY_TABLES) {
    try {
      const { data, error } =
        table === 'feedback'
          ? await selectAll(supabase, table, { columns: FEEDBACK_EXPORT_COLUMNS })
          : await selectAll(supabase, table, { filter: (q) => q.eq('user_id', userId) });
      out[table] = error ? { error: error.message } : (data ?? []);
    } catch (e) {
      out[table] = { error: (e as Error).message };
    }
  }
  return out;
}

/**
 * Everything we hold about the user, as a plain object.
 *
 * Built from local storage rather than by re-reading the server: LimeLog pushes
 * to Nexus but never pulls, so the device is authoritative and the server copy
 * is a subset. Article 20 asks for "structured, commonly used and
 * machine-readable" — JSON qualifies, and unlike CSV it carries the nested set
 * structure without inventing a flattening the user then has to undo.
 */
async function buildExport(
  user: { id: string; email?: string } | null,
): Promise<ExportPayload> {
  const programs = storage.getPrograms();
  const exercises = storage.getExercises();
  const sessionLogs = storage.getSessionLogs();
  const jumpLogs = storage.getJumpLogs();
  const stallFlags = storage.getStallFlags();
  const exercisePRs = storage.getExercisePRs();
  const workoutTemplates = storage.getWorkoutTemplates();
  const profile = storage.getProfile();

  // Photos are listed but not embedded. They live only on this device, they are
  // already JPEGs the user can keep, and inlining thirty base64 images would
  // turn a readable file into something no tool will open. The dates are the
  // part that is data about them; the images they already have.
  let photoDates: string[] = [];
  try {
    photoDates = listPhotos().map((p) => p.date);
  } catch {
    photoDates = [];
  }

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    application: 'LimeLog',
    account: user
      ? { email: user.email ?? null, userId: user.id }
      : { mode: 'guest', note: 'No account — this data has never left the device.' },
    counts: {
      programs: programs.length,
      exercises: exercises.length,
      sessionLogs: sessionLogs.length,
      jumpLogs: jumpLogs.length,
      stallFlags: stallFlags.length,
      exercisePRs: exercisePRs.length,
      workoutTemplates: workoutTemplates.length,
      progressPhotos: photoDates.length,
    },
    notes: {
      progressPhotos: 'Photos are stored only on this device and are never '
        + 'uploaded. Only the dates they were taken are listed here; the images '
        + 'themselves are already in the app on this device.',
    },
    data: {
      profile,
      programs,
      exercises,
      workoutTemplates,
      sessionLogs,
      jumpLogs,
      stallFlags,
      exercisePRs,
      progressPhotoDates: photoDates,
    },
    ...(user && isNexusConfigured ? { server: await serverOnlyData(user.id) } : {}),
  };
}

/** Trigger a download of the export as a .json file. Returns the filename. */
export async function downloadExport(
  user: { id: string; email?: string } | null,
): Promise<string> {
  const payload = await buildExport(user);
  const json = JSON.stringify(payload, null, 2);
  const name = `limelog-export-${new Date().toISOString().slice(0, 10)}.json`;
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — revoking synchronously can cancel the download on
  // some Android WebView versions before it has started.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

/**
 * Remove every LimeLog key from local storage.
 *
 * Prefix-based rather than a list of names, deliberately. nexusStore.signOut
 * wipes an explicit six keys, which is right for sign-out — programs and
 * exercise definitions are not personal data and a returning user wants them
 * kept. Erasure is the opposite case: anything missed is data surviving a
 * deletion request, so the default has to be "remove it" and a hand-written
 * list would silently miss whatever gets added next.
 *
 * v1.18.1 (LimeLog#77) — `limelog.` (dot) was missing, so these survived an
 * erasure. Each is about the person, not the device:
 *   - `limelog.onboarded`: "this person has done the first-run wizard". v1.10
 *     moved its truth to the account (user_preferences); the local copy is a
 *     cache of an account fact, and the account is gone.
 *   - `limelog.guestMode`: "this person chose to use the app without an
 *     account". Kept, the next launch would skip the first-launch screen and
 *     treat whoever opens the app next as having made that choice.
 *   - `limelog.lastAppOpen`: the local day this account's app-open row was
 *     last queued (appOpens.ts). It is a record of the erased person's use,
 *     and kept, it would stop a new account's first open that day from being
 *     recorded. Losing it costs at most one duplicate queue item, which the
 *     table's primary key already collapses.
 *   - `limelog.trainingGoal` and `limelog.referralAsked` are the person's
 *     answers to the wizard and the referral prompt, so they go too (the
 *     training PR, #79, also names these two one by one).
 * The language (`limecore_lang`) is a device setting shared with the other
 * apps, so it stays, as before.
 */
export function wipeAllLocalData(): void {
  const PREFIXES = ['wt_', 'limelog-', 'limelog.'];
  // Device settings under those prefixes that are not the person's data: the
  // F-Droid update check (fdroidUpdate.ts) is a choice about this device, and
  // an erase silently turned it back on.
  const KEEP = new Set(['limelog-fdroid-check']);
  try {
    const doomed = Object.keys(localStorage).filter((k) =>
      !KEEP.has(k) && PREFIXES.some((p) => k.startsWith(p)),
    );
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    // Private mode / storage disabled — nothing was persisted to begin with.
  }
}

/**
 * Erase the account and everything attached to it.
 *
 * Runs the shared `delete-account` Edge Function, which needs the service-role
 * key that must never ship in a client bundle. It authenticates the caller by
 * their own JWT and deletes only that user, so it cannot be aimed at anyone
 * else. Every user-owned table cascades from `auth.users(id)`.
 *
 * Deliberately the same function StudyDesk and NCC call: one account spans all
 * three apps, so deleting from any of them must erase everything.
 *
 * Local data is cleared regardless of what the server says — including progress
 * photos, which never reached the server and would otherwise be the one thing
 * left behind after a user asked to be erased.
 */
export async function deleteAccount({
  clearLocal,
}: {
  clearLocal: () => Promise<void>;
}): Promise<{ deleted: 'local' | 'account' }> {
  if (!isNexusConfigured) {
    await clearLocal();
    return { deleted: 'local' };
  }

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    // Guest: there is no server-side account. Clearing the device is the whole
    // of the erasure.
    await clearLocal();
    return { deleted: 'local' };
  }

  const { error } = await supabase.functions.invoke('delete-account', {
    body: { confirm: true },
  });
  if (error) throw new Error(error.message || 'Account deletion failed');

  try {
    await supabase.auth.signOut();
  } catch {
    // The user row is already gone, so the sign-out call may fail. Not fatal.
  }
  await clearLocal();
  return { deleted: 'account' };
}
