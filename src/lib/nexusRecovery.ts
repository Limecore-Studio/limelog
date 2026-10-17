// LimeLog ← Nexus recovery hydrate — v1.7 (BUG-6).
//
// LimeLog is push-only by contract (see CLAUDE.md): local + the offline outbox
// are the source of truth, and NCC only reads. That left one hole — if the
// local store is lost (reinstall, new device, cleared data, or a workout that
// errored out of local state), there was NO way to get pushed workouts back,
// even though they sat safely in the cloud. That already cost a real workout.
//
// This module adds a RECOVERY-ONLY pull. It never merges, overwrites, or
// deletes a local session — it only reconstructs sessions whose id is missing
// locally (and isn't tombstoned as an intentional discard). So local stays
// authoritative for everything it already knows; the cloud is consulted purely
// to refill genuine gaps. This is deliberately NOT the bidirectional LWW model
// StudyDesk uses — workout_sets have no natural merge key, so two-way merge
// would risk duplicate/stale sets.
//
// Reconstruction is best-effort by design: the cloud stores each set by
// exercise NAME (not the local exerciseId), and doesn't store programId /
// sessionTemplateId / setNumber. We resolve names back to local exercise ids
// where we can (so recovered sets re-link to progress/PR views), fall back to a
// stable synthetic id per unmatched name, and leave the template/program refs
// empty. A recovered session therefore shows its date, notes, exercises,
// weights, reps and RPE — enough to be real history again — but won't be tied
// to a program template. Recovered sessions are marked finalized (they're
// historical) so they never reopen as an in-progress workout.

import { supabase, isNexusConfigured } from './supabase';
import { selectAll, PAGE_SIZE } from './selectAll';
import type { SessionLog, SetLog } from '@/types/logging';
import type { Exercise } from '@/types/program';

interface CloudSessionRow {
  id: string;
  session_type: string | null;
  // v1.9 (Item 4) — cardio. NULL on every pre-v1.9 row and on every strength
  // session, which is how the two shapes are told apart coming back in.
  activity_type: string | null;
  duration_seconds: number | null;
  distance_meters: number | null;
  date: string | null;
  notes: string | null;
  ai_debrief_raw: string | null;
  ai_rpe: number | null;
  ai_pain_flags: string[] | null;
  ai_mood: string | null;
  ai_note_summary: string | null;
}

interface CloudSetRow {
  id: string;
  session_id: string;
  exercise: string | null;
  weight_kg: number | null;
  reps: number | null;
  rpe: number | null;
}

const VALID_MOODS = ['great', 'good', 'neutral', 'bad', 'terrible'] as const;
type Mood = (typeof VALID_MOODS)[number];
function coerceMood(m: string | null): Mood | null {
  return m && (VALID_MOODS as readonly string[]).includes(m) ? (m as Mood) : null;
}

/** Slug for a stable synthetic exercise id when a cloud set's exercise name
 *  doesn't match any local exercise. Keeps same-named sets grouped together. */
function syntheticExerciseId(name: string): string {
  return `rec:${name.trim().toLowerCase().replace(/\s+/g, '-')}`;
}

const SET_COLUMNS = 'id, session_id, exercise, weight_kg, reps, rpe';

/** Sessions per request. At the usual 15–20 sets a session this stays well
 *  under the 1000-row cap; a batch that does hit it is split, below. */
const SESSIONS_PER_REQUEST = 40;

/**
 * Every set belonging to `sessionIds`, with each session's sets in the order
 * they were inserted.
 *
 * Deliberately NOT paged by id like everything else (v1.16, limecore#28). The
 * set order in a recovered workout comes from arrival order below
 * (`setNumber: i + 1`), and no column records it: there is no set_number, and
 * `created_at` is tied for 28 of 30 multi-set sessions because a workout's
 * sets are inserted in one statement. The only signal is insertion order,
 * which an UNORDERED select returns. Keyset paging orders by uuid — random —
 * and would restore a warm-up as set 3.
 *
 * So each request fetches every set for a batch of sessions, unordered, and a
 * session's sets always come back from ONE request. Truncation is detected
 * from the exact count, and a batch that hit the cap is split in half and
 * fetched again. Only a single session with more sets than the cap — not a
 * real workout — falls back to id paging, where its order is lost but no set
 * is.
 */
async function fetchSetsForSessions(userId: string, sessionIds: string[]): Promise<CloudSetRow[]> {
  const out: CloudSetRow[] = [];
  const queue: string[][] = [];
  for (let i = 0; i < sessionIds.length; i += SESSIONS_PER_REQUEST) {
    queue.push(sessionIds.slice(i, i + SESSIONS_PER_REQUEST));
  }

  while (queue.length > 0) {
    const batch = queue.shift()!;
    const { data, error, count } = await supabase
      .from('workout_sets')
      .select(SET_COLUMNS, { count: 'exact' })
      .eq('user_id', userId)
      .in('session_id', batch);
    if (error) throw error;
    const rows = (data ?? []) as CloudSetRow[];

    const truncated = typeof count === 'number' ? count > rows.length : rows.length >= PAGE_SIZE;
    if (!truncated) {
      out.push(...rows);
      continue;
    }
    if (batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      queue.unshift(batch.slice(0, mid), batch.slice(mid));
      continue;
    }
    const whole = await selectAll<CloudSetRow>(supabase, 'workout_sets', {
      columns: SET_COLUMNS,
      filter: (q) => q.eq('user_id', userId).eq('session_id', batch[0]),
    });
    if (whole.error) throw whole.error;
    out.push(...(whole.data ?? []));
  }
  return out;
}

/**
 * Fetch all cloud workouts for the signed-in user and reconstruct them as local
 * SessionLogs. Pure fetch + map — the caller decides which to actually insert
 * (see logStore.recoverSessions, which skips ids that already exist locally or
 * are tombstoned). Returns [] when Nexus isn't configured or nobody's signed
 * in. Throws on a genuine query error so the caller can log it.
 *
 * @param exercises local exercise list, used to resolve set names → ids.
 * @param forUserId the account the caller started the pull for. When given,
 *   a different signed-in account throws instead of being pulled.
 */
export async function pullWorkoutsFromCloud(exercises: Exercise[], forUserId?: string): Promise<SessionLog[]> {
  if (!isNexusConfigured) return [];
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr) throw authErr;
  if (!user) return [];
  // v1.18.1 (LimeLog#85) — the pull is deferred and can run late; by then
  // someone else may be signed in. Their workouts are not this pull's to
  // fetch: the gate drops the result anyway, and this stops the request.
  if (forUserId !== undefined && user.id !== forUserId) {
    throw new Error('the signed-in account changed before the pull started');
  }

  // v1.16 (limecore#28): both pulls used to be one bare select, which PostgREST
  // truncates at its row cap without an error. A regular lifter crosses 1000
  // sets in a few months, so a reinstall gave them back only part of their
  // history, with older sessions restored empty.
  const { data: sessions, error: sErr } = await selectAll<CloudSessionRow>(supabase, 'workout_sessions', {
    columns: 'id, session_type, activity_type, duration_seconds, distance_meters, date, notes, ai_debrief_raw, ai_rpe, ai_pain_flags, ai_mood, ai_note_summary',
    // v1.16 (limelog#32): a discarded workout is a tombstone upstream now, and
    // recovery must not bring it back.
    filter: (q) => q.eq('user_id', user.id).is('deleted_at', null),
  });
  if (sErr) throw sErr;
  if (!sessions?.length) return [];

  const sets = await fetchSetsForSessions(
    user.id,
    sessions.map((s) => s.id),
  );

  // Resolve exercise NAME → local id (case-insensitive). Unmatched names get a
  // stable synthetic id so recovered sets for the same movement still group.
  const idByName = new Map<string, string>();
  for (const e of exercises) {
    const key = e.name.toLowerCase();
    if (!idByName.has(key)) idByName.set(key, e.id); // first match wins
  }
  const resolveExerciseId = (name: string): string =>
    idByName.get(name.trim().toLowerCase()) ?? syntheticExerciseId(name);

  // Group sets by session.
  const setsBySession = new Map<string, CloudSetRow[]>();
  for (const raw of (sets ?? []) as CloudSetRow[]) {
    const arr = setsBySession.get(raw.session_id);
    if (arr) arr.push(raw);
    else setsBySession.set(raw.session_id, [raw]);
  }

  return (sessions as CloudSessionRow[]).map((s) => {
    const date = s.date ?? new Date().toISOString();
    const rows = setsBySession.get(s.id) ?? [];
    const setLogs: SetLog[] = rows.map((r, i) => ({
      id: r.id,
      sessionLogId: s.id,
      exerciseId: resolveExerciseId(r.exercise ?? 'Exercise'),
      setNumber: i + 1,
      weightKg: r.weight_kg,
      reps: r.reps,
      rpe: r.rpe,
      completed: true, // only completed sets were ever pushed
    }));
    // v1.9 (Item 4) — a recovered cardio session must come back as cardio.
    // Without this it would restore as a strength session with no sets: a 10 km
    // run reappearing as an empty workout.
    const isCardio = !!s.activity_type;
    const log: SessionLog = {
      id: s.id,
      // Cardio genuinely has no template or program, so these stay absent
      // rather than being blanked. A recovered strength session keeps the
      // existing '' — its template is unknown, not nonexistent.
      ...(isCardio
        ? {
            activityType: s.activity_type ?? undefined,
            durationSeconds: s.duration_seconds ?? undefined,
            distanceMeters: s.distance_meters ?? undefined,
          }
        : { sessionTemplateId: '', programId: '' }),
      loggedAt: date,
      finalizedAt: date, // historical → finalized, never reopens in-progress
      perceivedFatigue: s.ai_rpe ?? null,
      notes: s.notes ?? undefined,
      sets: setLogs,
      aiDebriefRaw: s.ai_debrief_raw,
      aiRpe: s.ai_rpe,
      aiPainFlags: s.ai_pain_flags,
      aiMood: coerceMood(s.ai_mood),
      aiNoteSummary: s.ai_note_summary,
    };
    return log;
  });
}
