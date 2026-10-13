// LimeLog → Nexus push handler.
//
// v1.0–v1.1: this file owned BOTH the push (`pushWorkoutToNexus`) AND the
// retry queue (`pushOrQueue`, `drainPendingQueue`, `wt_nexus_pending`
// localStorage). v1.2 split the queue out to `lib/outbox.ts` — that's where
// persistence, single-flight, attempt cap, and online/visibility re-triggers
// now live. The legacy `wt_nexus_pending` key is auto-migrated by outbox.ts
// on first load.
//
// This file is now just the handler + the payload mapper. Call sites use
// `enqueue('upsert_workout_session', payload)` from outbox.ts instead of the
// removed `pushOrQueue` wrapper.

import { supabase, isNexusConfigured } from './supabase';
import type { SessionLog } from '@/types/logging';
import type { Exercise, SessionTemplate } from '@/types/program';

interface NexusSetPayload {
  exercise: string;
  weightKg?: number;
  reps?: number;
  rpe?: number;
}

export interface NexusWorkoutPayload {
  /** v1.16 (limecore#27, registry P6): when this version of the workout was
   *  saved, stamped by `outbox.enqueue`. Absent on items queued by an older
   *  build, which push with the send time as before. */
  updatedAt?: string;
  // v1.6.1 — the LOCAL SessionLog id. Threaded through so the push upserts a
  // stable row instead of minting a fresh random id every dispatch. Without
  // this, an outbox retry / double-dispatch inserted a NEW session each time —
  // one workout became N duplicate cloud sessions (the "6 workouts" bug).
  sessionId: string;
  sessionType: string;
  date: string;
  notes?: string;
  sets: NexusSetPayload[];
  // v1.9 (Item 4) — cardio. Absent on a strength session, which is exactly what
  // NULL means in `workout_sessions`.
  activityType?: string;
  durationSeconds?: number;
  distanceMeters?: number;
  // v1.4 — optional AI debrief fields (null when not used).
  aiDebriefRaw?: string | null;
  aiRpe?: number | null;
  aiPainFlags?: string[] | null;
  aiMood?: string | null;
  aiNoteSummary?: string | null;
}

export function mapSessionLogToNexus(
  log: SessionLog,
  session: SessionTemplate | undefined,
  exercises: Exercise[],
): NexusWorkoutPayload {
  const exerciseById = new Map(exercises.map((e) => [e.id, e]));

  const sets: NexusSetPayload[] = log.sets
    .filter((s) => s.completed)
    .map((s) => {
      const ex = exerciseById.get(s.exerciseId);
      return {
        exercise: ex?.name ?? 'Unknown exercise',
        weightKg: s.weightKg ?? undefined,
        reps: s.reps ?? undefined,
        rpe: s.rpe ?? undefined,
      };
    });

  return {
    sessionId: log.id,
    // v1.9 — `session_type` is NOT NULL and is what NCC and older LimeLog
    // builds display, so a cardio session puts its activity there rather than
    // falling through to the generic 'workout'. The row then reads sensibly on
    // a client that knows nothing about `activity_type`.
    sessionType: session?.name ?? log.activityType ?? 'workout',
    date: log.finalizedAt ?? log.loggedAt,
    notes: log.notes,
    sets,
    activityType: log.activityType,
    durationSeconds: log.durationSeconds,
    distanceMeters: log.distanceMeters,
    aiDebriefRaw: log.aiDebriefRaw ?? null,
    aiRpe: log.aiRpe ?? null,
    aiPainFlags: log.aiPainFlags ?? null,
    aiMood: log.aiMood ?? null,
    aiNoteSummary: log.aiNoteSummary ?? null,
  };
}

/**
 * Deterministic UUID for the set at `index` of `sessionId` (limelog#28).
 * SHA-256 of the pair, shaped as an RFC 4122 version-8 ("custom") UUID so the
 * `uuid` column accepts it. Session ids are unique per workout, so two
 * sessions — or two users — never share a set id.
 */
export async function setRowId(sessionId: string, index: number): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`limelog-set:${sessionId}:${index}`)),
  ).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // version 8
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Push one workout payload to Supabase: upsert the session row, upsert its
 * sets under deterministic ids, then drop the session's other set rows.
 * Idempotent — any number of pushes, sequential or overlapping, converge on
 * the same rows. Throws on any failure; the caller decides whether to retry.
 *
 * Called by:
 *   - outbox.ts dispatch for the `upsert_workout_session` kind (typical path)
 *   - directly during dev/testing if needed
 */
export async function pushWorkoutToNexus(workout: NexusWorkoutPayload): Promise<string> {
  if (!isNexusConfigured) throw new Error('Nexus not configured');

  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not signed in to Nexus');

  // v1.6.1 — idempotent push, honouring the outbox's UPSERT-style contract.
  // Use the STABLE local session id (not a fresh random one) and UPSERT, so a
  // retry / double-dispatch converges on the same row instead of inserting a
  // duplicate. Sets follow the same rule below (limelog#28).
  const sessionId = workout.sessionId;
  const now = new Date().toISOString();

  const { error: sessionErr } = await supabase
    .from('workout_sessions')
    .upsert({
      id: sessionId,
      user_id: user.id,
      session_type: workout.sessionType,
      activity_type: workout.activityType ?? null,
      duration_seconds: workout.durationSeconds ?? null,
      distance_meters: workout.distanceMeters ?? null,
      date: workout.date,
      notes: workout.notes ?? null,
      ai_debrief_raw: workout.aiDebriefRaw ?? null,
      ai_rpe: workout.aiRpe ?? null,
      ai_pain_flags: workout.aiPainFlags ?? null,
      ai_mood: workout.aiMood ?? null,
      ai_note_summary: workout.aiNoteSummary ?? null,
      // The moment the workout was saved, not the moment it was sent — a
      // session saved offline and pushed hours later must not beat an edit
      // made in between on another device (limecore#27, registry P6).
      updated_at: workout.updatedAt ?? now,
    });
  if (sessionErr) throw sessionErr;

  // Limekana/limelog#28 — sets are written idempotently. The old
  // delete-everything-then-insert-fresh-uuids shape multiplied rows whenever
  // two pushes of one session overlapped (5 parallel pushes → 5 copies, seen in
  // production), and a failed insert after the delete left the session empty.
  //
  // Each set now has an id derived from (session, position), so any number of
  // pushes of the same workout upsert the SAME rows. Only after that succeeds
  // are this session's other rows removed — sets the user deleted, and the
  // random-id duplicates older versions left behind, which a re-push therefore
  // also cleans up.
  const setRows = await Promise.all(workout.sets.map(async (s, i) => ({
    id: await setRowId(sessionId, i),
    user_id: user.id,
    session_id: sessionId,
    exercise: s.exercise,
    weight_kg: s.weightKg ?? null,
    reps: s.reps ?? null,
    rpe: s.rpe ?? null,
  })));

  if (setRows.length > 0) {
    const { error: setsErr } = await supabase.from('workout_sets').upsert(setRows);
    if (setsErr) throw setsErr;
  }

  let clear = supabase.from('workout_sets').delete().eq('session_id', sessionId);
  if (setRows.length > 0) clear = clear.not('id', 'in', `(${setRows.map((r) => r.id).join(',')})`);
  const { error: clearErr } = await clear;
  if (clearErr) throw clearErr;

  return sessionId;
}

// ── v1.2 Body Metrics push ────────────────────────────────────────────────
//
// Upsert by (user_id, date) — the UNIQUE constraint at the DB lets us write
// a fresh row OR overwrite an existing one for the same day in a single
// statement. Useful when the user weighs themselves in the morning, logs
// it, then edits later that day to add measurements.

export interface NexusBodyMetricPayload {
  id: string;
  date: string;
  weightKg?: number;
  chestCm?: number;
  waistCm?: number;
  hipsCm?: number;
  armsCm?: number;
  legsCm?: number;
  notes?: string;
}

export async function pushBodyMetricToNexus(p: NexusBodyMetricPayload): Promise<void> {
  if (!isNexusConfigured) throw new Error('Nexus not configured');
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not signed in to Nexus');

  // v1.18.1 (LimeLog#76): two devices that log the same day hold the row
  // under different local ids. Upserting on (user_id, date) while sending
  // `id` rewrote the row's primary key to the second device's id, so the
  // first device's delete by id then matched nothing, and every field the
  // second device had not set was written as null. Now the day's row is
  // updated in place with only the fields this device has, and inserted
  // (with this device's id, as the column has no default) only when there
  // is none. An update that matches no row, or changes nothing (the no-op
  // guard skips it), falls through to an insert that does nothing if the
  // day's row exists.
  const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const set = (col: string, v: number | string | undefined) => {
    if (v !== undefined) fields[col] = v;
  };
  set('weight_kg', p.weightKg);
  set('chest_cm', p.chestCm);
  set('waist_cm', p.waistCm);
  set('hips_cm', p.hipsCm);
  set('arms_cm', p.armsCm);
  set('legs_cm', p.legsCm);
  set('notes', p.notes);

  const { data, error } = await supabase
    .from('body_metrics')
    .update(fields)
    .eq('user_id', user.id)
    .eq('date', p.date)
    .select('id');
  if (error) throw error;
  if (data && data.length > 0) return;
  const { error: insertError } = await supabase
    .from('body_metrics')
    .upsert({ id: p.id, user_id: user.id, date: p.date, ...fields }, { onConflict: 'user_id,date', ignoreDuplicates: true });
  if (insertError) throw insertError;
}

/** v1.18.1 (LimeLog#76): by day, as the row may carry another device's id
 *  (see pushBodyMetricToNexus). A delete queued by an older build carries no
 *  date and still goes by id. */
export async function deleteBodyMetricFromNexus(id: string, date?: string): Promise<void> {
  if (!isNexusConfigured) throw new Error('Nexus not configured');
  if (!date) {
    const { error } = await supabase.from('body_metrics').delete().eq('id', id);
    if (error) throw error;
    return;
  }
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not signed in to Nexus');
  const { error } = await supabase.from('body_metrics').delete().eq('user_id', user.id).eq('date', date);
  if (error) throw error;
}

// v1.6 — Personal Records. Push-only, append-only: each detected PR is one row.
// Upsert by primary id keeps retries idempotent (the local PR keeps a stable
// id). All derived from already-pushed workout sets — no new user input.
export interface NexusExercisePRPayload {
  id: string;
  exerciseId: string;
  exerciseName: string;
  weightKg: number;
  reps: number;
  oneRepMaxKg: number;
  sessionId: string;
  date: string;
}

// -- v1.10: in-app feedback ------------------------------------------------
// `id` comes from the caller so an outbox retry files the same report rather
// than a second one. Retry safety is INSERT + duplicate-key check rather than
// UPSERT: `feedback` deliberately has no UPDATE policy, and an UPSERT onto an
// existing row becomes an UPDATE, which RLS would refuse. A 23505 means the
// first attempt landed, so it is success, not an error to surface.
export interface NexusFeedbackPayload {
  id: string;
  category: string;
  rating: number | null;
  message: string;
  appVersion: string;
  platform: string;
}

export async function pushFeedbackToNexus(p: NexusFeedbackPayload): Promise<void> {
  if (!isNexusConfigured) throw new Error('Nexus not configured');
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not signed in to Nexus');

  const { error } = await supabase.from('feedback').insert({
    id: p.id,
    user_id: user.id,
    app: 'limelog',
    app_version: p.appVersion || null,
    platform: p.platform || null,
    category: p.category,
    rating: p.rating,
    message: p.message,
  });
  if (error && (error as { code?: string }).code !== '23505') throw error;
}

// ── retention (v1.12 Item 0) ─────────────────────────────────────────────────

export interface NexusAppOpenPayload {
  appVersion: string;
  platform: string;
  /** The user's own calendar date (YYYY-MM-DD), never the UTC one. */
  openedOn: string;
}

/**
 * Record that the user opened LimeLog today.
 *
 * Retention across the suite was previously inferred from content-row
 * timestamps and `auth.users.last_sign_in_at`; the latter moves on a silent
 * token refresh, so it recorded that the client woke up rather than that the
 * person came back.
 *
 * `app_opens`'s primary key is (user_id, app, opened_on), so this is idempotent
 * by construction — the caller upserts on every foreground and the database
 * collapses same-day repeats.
 */
export async function pushAppOpenToNexus(p: NexusAppOpenPayload): Promise<void> {
  if (!isNexusConfigured) throw new Error('Nexus not configured');
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not signed in to Nexus');

  const { error } = await supabase.from('app_opens').upsert({
    user_id: user.id,
    app: 'limelog',
    app_version: p.appVersion || null,
    platform: p.platform || null,
    opened_on: p.openedOn,
  }, { onConflict: 'user_id,app,opened_on' });
  if (error) throw error;
}

export async function pushExercisePRToNexus(p: NexusExercisePRPayload): Promise<void> {
  if (!isNexusConfigured) throw new Error('Nexus not configured');
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) throw new Error('Not signed in to Nexus');

  const row = {
    id: p.id,
    user_id: user.id,
    exercise_id: p.exerciseId,
    exercise_name: p.exerciseName,
    weight_kg: p.weightKg,
    reps: p.reps,
    one_rep_max_kg: p.oneRepMaxKg,
    session_id: p.sessionId,
    pr_date: p.date,
  };
  const { error } = await supabase.from('exercise_prs').upsert(row);
  if (error) throw error;
}
