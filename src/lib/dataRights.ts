// GDPR data-subject rights — Article 20 (portability) and Article 17 (erasure).
//
// Ported from StudyDesk's src/lib/dataRights.js, which shipped these first. The
// suite shares one account and one database, so the Edge Function and the
// cascade behaviour are identical; only the local-data shape differs.
//
// Export works signed in or as a guest: a guest's data lives only on the device,
// and it is still their data. Deletion only means anything when there is a
// server-side account to delete.

import type { Session } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';
import { SaveFile } from './saveFile';
import { storage } from '@/utils/storage';
import { supabase, isNexusConfigured, readStoredSession, clearStoredSession } from './supabase';
import { listPhotos } from './progressPhotos';
import { selectAll } from './selectAll';
import { clearOwner, ownerMirrorSettled, readOwner } from './accountOwner';
import { forgetParked } from './parkedData';

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

// v1.22 (limecore#88) — one account spans NCC, StudyDesk and LimeLog, and the
// privacy policy says "Export my data" from any of them covers all of them.
// The export held only feedback and error reports from the server; it now
// reads every user-owned table of the suite as the signed-in user, so RLS
// decides what comes back. Same list and readers as NCC's (nexus-command-
// center#317) so the three exports agree.
interface ServerTable {
  table: string;
  /** Default `*`. Only these columns are granted on some tables. */
  columns?: string;
  /** Which column names the user: `user_id` (default), `id` (profiles), or
   *  none, when RLS alone decides (audit_log, feedback). */
  owner?: 'user_id' | 'id' | 'none';
  /** Tables without an `id` column cannot use the id-keyed pager; they are
   *  read in ranges ordered by these columns. */
  orderBy?: string[];
}

export const SERVER_TABLES: readonly ServerTable[] = [
  // Account
  { table: 'profiles', owner: 'id' },
  { table: 'user_preferences', orderBy: ['user_id'] },
  { table: 'supporter_entitlements', orderBy: ['user_id'] },
  // Only these columns are granted; the verification code itself is not.
  { table: 'kofi_alt_emails', columns: 'email, verified_at, code_expires_at, last_sent_at, user_id', orderBy: ['email'] },
  { table: 'app_opens', orderBy: ['opened_on', 'app'] },
  { table: 'audit_log', owner: 'none' },
  { table: 'feedback', columns: FEEDBACK_EXPORT_COLUMNS, owner: 'none' },
  { table: 'client_errors' },
  // Nexus Command Center
  { table: 'transactions' },
  { table: 'budget_categories' },
  { table: 'budget_category_shares', orderBy: ['user_id'] },
  { table: 'manual_assets' },
  { table: 'portfolio_holdings' },
  { table: 'portfolio_lots' },
  { table: 'stock_sales' },
  { table: 'portfolio_cash_entries' },
  { table: 'watchlist_items' },
  { table: 'recurring_rules' },
  { table: 'goals' },
  { table: 'tasks' },
  { table: 'task_shares', orderBy: ['user_id'] },
  { table: 'habits' },
  { table: 'habit_completions' },
  { table: 'braindump_entries' },
  { table: 'work_quality_logs' },
  // StudyDesk
  { table: 'subjects' },
  { table: 'grades' },
  { table: 'study_sessions' },
  { table: 'assignments' },
  { table: 'assignment_attachments' },
  { table: 'exams' },
  { table: 'study_actions' },
  { table: 'notebook_entries' },
  { table: 'notebook_attachments' },
  { table: 'academic_terms' },
  { table: 'timetable_entries' },
  { table: 'lesson_attendance' },
  { table: 'planned_sessions' },
  { table: 'readings' },
  { table: 'progress_counters' },
  { table: 'progress_counter_days' },
  { table: 'commitments' },
  { table: 'focus_timers', orderBy: ['user_id'] },
  // LimeLog
  { table: 'workout_sessions' },
  { table: 'workout_sets' },
  { table: 'exercise_prs' },
  { table: 'body_metrics' },
];

const RANGE = 1000;

/** Reads a table without an `id` column in ordered ranges. */
async function readRanged(t: ServerTable, userId: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let from = 0; ; from += RANGE) {
    let q = supabase.from(t.table).select(t.columns ?? '*').eq('user_id', userId);
    for (const col of t.orderBy ?? []) q = q.order(col, { ascending: true });
    const { data, error } = await q.range(from, from + RANGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < RANGE) return rows;
  }
}

async function readTable(t: ServerTable, userId: string): Promise<unknown[]> {
  if (t.orderBy) return readRanged(t, userId);
  const owner = t.owner ?? 'user_id';
  const { data, error } = await selectAll(supabase, t.table, {
    ...(t.columns ? { columns: t.columns } : {}),
    ...(owner === 'none' ? {} : { filter: (q) => q.eq(owner, userId) }),
  });
  if (error) throw error;
  return data ?? [];
}

export async function serverOnlyData(userId: string): Promise<Record<string, unknown[] | { error: string }>> {
  const out: Record<string, unknown[] | { error: string }> = {};
  for (const t of SERVER_TABLES) {
    try {
      out[t.table] = await readTable(t, userId);
    } catch (e) {
      out[t.table] = { error: (e as Error).message ?? String(e) };
    }
  }
  return out;
}

/** v1.22 (limecore#88) — the user's uploaded files, by bucket: path, size and
 *  date of each object under their own folder (every storage policy scopes a
 *  user to `<user_id>/`). A listing, not the files: StudyDesk owns them. */
export const STORAGE_BUCKETS = ['avatars', 'notebook', 'assignment-attachments'] as const;

interface StorageEntry { path: string; size: number | null; createdAt: string | null; contentType: string | null }

async function listFolder(bucket: string, prefix: string, out: StorageEntry[], depth = 0): Promise<void> {
  if (depth > 4) return;
  for (let offset = 0; ; offset += RANGE) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: RANGE, offset });
    if (error) throw error;
    for (const o of data ?? []) {
      const path = `${prefix}/${o.name}`;
      // A folder has no id and no metadata; recurse into it.
      if (!o.id) await listFolder(bucket, path, out, depth + 1);
      else
        out.push({
          path,
          size: (o.metadata as { size?: number } | null)?.size ?? null,
          createdAt: o.created_at ?? null,
          contentType: (o.metadata as { mimetype?: string } | null)?.mimetype ?? null,
        });
    }
    if (!data || data.length < RANGE) return;
  }
}

export async function serverFiles(userId: string): Promise<Record<string, StorageEntry[] | { error: string }>> {
  const out: Record<string, StorageEntry[] | { error: string }> = {};
  for (const bucket of STORAGE_BUCKETS) {
    try {
      const entries: StorageEntry[] = [];
      await listFolder(bucket, userId, entries);
      out[bucket] = entries;
    } catch (e) {
      out[bucket] = { error: (e as Error).message };
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
function readLocalJson(key: string, fallback: unknown): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export async function buildExport(
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
      bodyMetrics: (readLocalJson('limelog-body-metrics', []) as unknown[]).length,
    },
    notes: {
      progressPhotos: 'Photos are stored only on this device and are never '
        + 'uploaded. Only the dates they were taken are listed here. To keep the '
        + 'images, save a copy of each from Body > Progress photos.',
      server: 'Everything the account holds on the server, across NCC, StudyDesk '
        + 'and LimeLog, as read with your sign-in. A table that could not be read '
        + 'says so instead of being left out.',
      files: 'Files you uploaded (avatar, StudyDesk notebook and assignment '
        + 'attachments), listed by path and size. The files themselves are '
        + 'downloadable in StudyDesk.',
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
      // v1.22 (limecore#88): the body log (weight, measurements and the
      // smart-scale fields) and its settings, as held on this device.
      bodyMetrics: readLocalJson('limelog-body-metrics', []),
      bodyMetricsPrefs: readLocalJson('limelog-body-metrics-prefs', null),
    },
    ...(user && isNexusConfigured ? { server: await serverOnlyData(user.id), files: await serverFiles(user.id) } : {}),
  };
}

/** The signed-in account for an export, or null for a guest. Lives here, not
 *  in the crash screen, so the startup chunk does not carry it (v1.21.1). */
export async function sessionAccount(): Promise<{ id: string; email?: string } | null> {
  if (!isNexusConfigured) return null;
  const u = (await supabase.auth.getSession()).data.session?.user;
  return u ? { id: u.id, email: u.email } : null;
}

// v1.21.1 (limecore#103) — the native "create document" picker
// (SaveFilePlugin.java), registered in saveFile.ts.

/** Save the export as a .json file. Returns the filename once it is written,
 *  or null when the user cancelled the picker; throws when it could not be
 *  written. Callers say "Saved" only for a filename.
 *
 *  v1.21.1 (limecore#103): on Android the blob anchor below wrote nothing (a
 *  WebView needs a DownloadListener for it, and none is registered) while the
 *  app said "Saved". There the system picker writes the file instead. */
export async function downloadExport(
  user: { id: string; email?: string } | null,
): Promise<string | null> {
  const payload = await buildExport(user);
  const json = JSON.stringify(payload, null, 2);
  const name = `limelog-export-${new Date().toISOString().slice(0, 10)}.json`;
  if (Capacitor.isNativePlatform()) {
    const { saved } = await SaveFile.save({ filename: name, mimeType: 'application/json', data: json });
    return saved ? name : null;
  }
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
 * wipes an explicit list of keys (since v1.18.1, LimeLog#82, some of the
 * `limelog.` flags below too; see there), which is right for sign-out — programs
 * and exercise definitions are not personal data and a returning user wants
 * them kept. Erasure is the opposite case: anything missed is data surviving a
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
 * v1.18.1 (LimeLog#90/#91/#92) — also under `limelog.`: the account the
 * local data is tied to and its email (`limelog.dataOwner`,
 * `limelog.dataOwnerEmail`), and the records and profiles set aside per
 * account at sign-out (`limelog.parked`, every slot: an erase leaves nothing
 * of LimeLog's here). The owner's Preferences mirror goes in deleteAccount
 * (clearOwner).
 * The language (`limecore_lang`) is a device setting shared with the other
 * apps, so it stays, as before.
 */
export function wipeAllLocalData(): void {
  const PREFIXES = ['wt_', 'limelog-', 'limelog.'];
  // Device settings under those prefixes that are not the person's data: the
  // F-Droid update check (fdroidUpdate.ts) is a choice about this device, and
  // an erase silently turned it back on.
  const KEEP = new Set(['limelog-fdroid-check']);
  // v1.18.1 (LimeLog#75): keys no prefix covers, named one by one (the two
  // auth-metadata names, in case anything mirrored them here).
  const KEYS = ['referral_source', 'limecore_origin'];
  try {
    const doomed = Object.keys(localStorage).filter((k) =>
      !KEEP.has(k) && (KEYS.includes(k) || PREFIXES.some((p) => k.startsWith(p))),
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
 * After the account is deleted the local data goes too, including progress
 * photos, which never reached the server and would otherwise be the one thing
 * left behind after a user asked to be erased.
 *
 * v1.21.1 (limecore#102) — never pretends. Account or guest is decided from
 * the device (the recorded data owner, or a session in auth storage), not from
 * getSession() alone: an expired session that cannot be refreshed (offline, or
 * the refresh token refused) answers exactly like a guest, and this used to
 * wipe the phone, keep the server account and every row in all three apps,
 * and say it was done. Results:
 *   - 'account': the function deleted it; the device is cleared and the stored
 *     session removed (on Android it lives in Preferences and outlived the wipe);
 *   - 'local': a real guest; the device was the whole of it, cleared;
 *   - 'none': an account exists but there is no usable session. Nothing was
 *     deleted, here or on the server; the caller says so.
 */
export type DeleteResult = { deleted: 'local' | 'account' | 'none' };

/** limecore#124: how long the delete waits for the session before refusing. */
export const SESSION_TIMEOUT_MS = 8000;

export async function deleteAccount({
  clearLocal,
}: {
  clearLocal: () => Promise<void>;
}): Promise<DeleteResult> {
  // v1.18.1 (LimeLog#88) — the local data has no owner after an erase. The
  // prefix wipe removes the record too (`limelog.`); this does not depend on
  // the caller's clearLocal doing so.
  // v1.18.1 (LimeLog#90) — and the deleted account's records and profile set
  // aside on this device (parkedData.ts) go with it. The prefix wipe removes
  // every slot too (`limelog.parked`); this does not depend on it either.
  const clearAll = async (userId?: string) => {
    await clearLocal();
    // v1.22 (limecore#122) — the user's own Gemini key and model name, kept
    // in Preferences where the prefix wipe does not reach.
    await import('./aiProvider').then((m) => Promise.all([m.clearAiKey(), m.setAiModel('')])).catch(() => {});
    if (userId) forgetParked(userId);
    clearOwner();
    // The caller reloads next (ProfilePage); the Preferences clear has to
    // land first, or the deleted account's id and email outlive it there.
    await ownerMirrorSettled();
  };
  if (!isNexusConfigured) {
    await clearAll();
    return { deleted: 'local' };
  }

  // v1.21.1 (limecore#124) — the session check is bounded. Offline with an
  // expired access token, getSession() keeps retrying the refresh and never
  // returns, so the button sat on "Deleting…" with the delete still pending in
  // memory: had the network come back minutes later, the account would have
  // gone with nothing on screen saying so. Now: offline, ask nothing (a guest
  // can still be erased, that needs no network); online, wait at most
  // SESSION_TIMEOUT_MS and treat a timeout as a failed session, so the refusal
  // below shows and nothing is wiped. A getSession() that answers later finds
  // this call already over.
  let session: Session | null = null;
  let sessionError = false;
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (offline) {
    sessionError = !!readOwner() || !!(await readStoredSession());
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([
        supabase.auth.getSession(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), SESSION_TIMEOUT_MS);
        }),
      ]);
      session = r.data.session;
      sessionError = !!r.error;
    } catch {
      sessionError = true;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!session || sessionError) {
    const hasAccount = sessionError || !!readOwner() || !!(await readStoredSession());
    // An account with no usable session: refuse, and touch nothing.
    if (hasAccount) return { deleted: 'none' };
    // A real guest: there is no server-side account. Clearing the device is
    // the whole of the erasure.
    await clearAll();
    return { deleted: 'local' };
  }

  const { error } = await supabase.functions.invoke('delete-account', {
    body: { confirm: true },
  });
  if (error) throw new Error(error.message || 'Account deletion failed');

  // Local scope: the user is gone on the server, so there is nothing to ask it,
  // and a global sign-out that fails there leaves the session in storage.
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    /* removed below either way */
  }
  await clearStoredSession();
  await clearAll(session.user.id);
  return { deleted: 'account' };
}
