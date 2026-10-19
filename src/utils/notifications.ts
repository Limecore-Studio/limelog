/**
 * Workout reminder notifications via @capacitor/local-notifications.
 *
 * REQUIRED (one-time setup):
 *   npm install @capacitor/local-notifications
 *   npx cap sync android
 *
 * Schedules a weekly 9 AM notification for every day that has a session
 * in the active program. Safe to call on web (no-ops when not on native).
 */

import { Capacitor } from '@capacitor/core';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — installed separately; see setup comment above
import { LocalNotifications } from '@capacitor/local-notifications';
import type { Exercise, SessionTemplate } from '@/types/program';
import i18n from '@/i18n';
import { weekdayNames } from '@/utils/helpers';

const CHANNEL_ID = 'workout-reminders';
/** Notification IDs 100–106 are reserved for days 0 (Sun) – 6 (Sat). */
const BASE_ID = 100;
const SLOT_COUNT = 7;


/**
 * Action-type ID for the workout reminder. Registered once at app start via
 * `registerWorkoutActionTypes()` and attached to every scheduled reminder
 * via `actionTypeId`. The "start" action ID is what's compared in the
 * `localNotificationActionPerformed` handler to know it was the button
 * (vs a plain notification tap).
 */
const ACTION_TYPE_ID = 'workout-reminder';
export const WORKOUT_ACTION_START = 'start';

/**
 * v1.3.1 BUG-12 — wide ID range for the legacy phantom-alarm sweep. The
 * v1.0.3 LL-1 fix only cancelled IDs 100–106 (the current BASE_ID + 0..6
 * scheme). But the v1.0 release scheduled notifications with IDs derived
 * from `session.id` hashes — arbitrary numbers that landed across the
 * full int32 space. Those phantom alarms outlive the SharedPreferences
 * entry the plugin uses to track them (see docstring on cancelAllSlots),
 * so `getPending()` can't see them but they keep firing on the user's
 * pre-v1.0.3 schedule whenever they pick up the wrong day-of-week. We
 * sweep a generous 0–999 range every reschedule and at app start to
 * vacuum the AlarmManager queue clean of historical entries. Cancel on
 * a non-existent ID is a no-op on Android, so the sweep is cheap.
 *
 * The current scheme uses IDs 100–106 only; the 0–999 sweep is a
 * defense-in-depth net for any LimeLog install that ever ran a pre-v1.3.1
 * build. Future versions can shrink this once we're confident no v1.0/v1.1
 * installs remain in the field.
 */
const LEGACY_SWEEP_LOW = 0;
const LEGACY_SWEEP_HIGH = 999;

/**
 * Unconditional cancel of every reserved slot.
 *
 * Why blind-cancel instead of `getPending() → filter → cancel`:
 *
 *   1. `@capacitor/local-notifications.getPending()` reads SharedPreferences.
 *      Recurring alarms (`every: 'week'`) live in AlarmManager but their
 *      SharedPreferences entries can get evicted after the first fire — so
 *      `getPending()` returns nothing while the underlying alarm keeps
 *      firing on its old schedule.
 *   2. `Settings → Storage → Clear data` wipes SharedPreferences but does
 *      NOT cancel the AlarmManager alarms the plugin scheduled — the
 *      `RECEIVE_BOOT_COMPLETED` re-registrations are gone, but any alarm
 *      not yet fired is still queued.
 *   3. Switching active programs (Mon/Wed/Fri → Tue/Thu) used to leak the
 *      old day-slots: Mon/Wed/Fri alarms with the old session bodies kept
 *      firing because `getPending()` couldn't see them to cancel them.
 *   4. v1.3.1 BUG-12: pre-v1.0.3 installs scheduled notifications with
 *      arbitrary IDs (not yet pinned to BASE_ID + dayOfWeek). Those
 *      phantom alarms survive the LL-1 v1.0.3 fix because cancelAllSlots
 *      only swept the current 7-slot range. We now also sweep 0–999
 *      defensively to catch any legacy ID — see LEGACY_SWEEP_LOW/HIGH.
 *
 * Cancelling each ID blindly always reaches the underlying alarm because
 * `AlarmManager.cancel(PendingIntent)` matches on intent action + ID, not
 * on SharedPreferences presence. Calling `cancel` on a non-existent ID is
 * a no-op on Android — safe to sweep an entire range every time.
 */
async function cancelAllSlots(): Promise<void> {
  // Build the union of current-scheme slot IDs + legacy sweep range. The
  // overlap is harmless (the current 100–106 IDs sit inside 0–999) and the
  // Set dedupe just keeps the request payload tidy.
  const ids = new Set<number>();
  for (let i = 0; i < SLOT_COUNT; i++) ids.add(BASE_ID + i);
  for (let i = LEGACY_SWEEP_LOW; i <= LEGACY_SWEEP_HIGH; i++) ids.add(i);
  const allSlotIds = Array.from(ids, (id) => ({ id }));
  try {
    // Diagnostic: log what SharedPreferences still thinks is pending so a
    // logcat sweep can confirm phantom alarms (those NOT in this list but
    // still firing) are the reason we blind-cancel.
    const { notifications: pending } = await LocalNotifications.getPending();
    const ours = pending.filter(
      (n: { id: number }) => n.id >= BASE_ID && n.id < BASE_ID + SLOT_COUNT,
    );
    const legacy = pending.filter(
      (n: { id: number }) =>
        (n.id >= LEGACY_SWEEP_LOW && n.id <= LEGACY_SWEEP_HIGH) &&
        !(n.id >= BASE_ID && n.id < BASE_ID + SLOT_COUNT),
    );
    console.log(
      `[notifications] cancelAllSlots: getPending reports ${ours.length} current-scheme + ${legacy.length} legacy IDs visible — blind-cancelling ${allSlotIds.length} slot IDs across 0–999 + ${BASE_ID}–${BASE_ID + SLOT_COUNT - 1}`,
    );
    if (legacy.length > 0) {
      console.log(
        `[notifications] legacy phantom IDs detected: ${legacy.map((n: { id: number }) => n.id).join(', ')}`,
      );
    }
  } catch {
    /* getPending failed — cancel anyway */
  }
  await LocalNotifications.cancel({ notifications: allSlotIds });
}

/**
 * Create the channel and register the action type, in the app's current
 * language. v1.18.1 (LimeLog#75): both were English in every language. Android
 * keeps what was registered, so App calls this again when the language changes
 * (re-creating an existing channel id renames it) and then re-schedules the
 * reminders, which are built with the button as registered at that moment.
 */
export async function labelNotifications(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await LocalNotifications.createChannel({
    id: CHANNEL_ID,
    name: i18n.t('notif.channelName'),
    description: i18n.t('notif.channelDescription'),
    importance: 4, // IMPORTANCE_HIGH
    vibration: true,
    sound: 'default',
    lights: true,
  });
  // Register the action-type (idempotent — re-registering with the same
  // id replaces the prior set). Must happen before any notification with
  // `actionTypeId: 'workout-reminder'` fires, or the button won't render.
  await LocalNotifications.registerActionTypes({
    types: [
      {
        id: ACTION_TYPE_ID,
        actions: [
          { id: WORKOUT_ACTION_START, title: i18n.t('notif.startAction') },
        ],
      },
    ],
  });
}

export async function setupNotificationChannel(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await labelNotifications();
    // App-startup defensive sweep: blind-cancel every slot in case AlarmManager
    // is still holding phantom alarms from a previous install / data clear /
    // older program. `scheduleWorkoutReminders` will re-issue fresh schedules
    // immediately after this when the activeProgram effect mounts. The 1.0.1
    // fix relied on the scheduling path alone to clean up — that left a window
    // where a phantom alarm could fire between app launch and the program
    // effect running. This sweep closes that window.
    await cancelAllSlots();
  } catch { /* best-effort cleanup — ignore if the plugin call fails */ }
}

/**
 * Build the notification body for one session: session name + up to 3
 * exercise names joined by arrows. Truncated to ~80 chars so the collapsed
 * notification line doesn't get cropped mid-word.
 *
 * Why the library lookup: `SessionExercise` only carries `exerciseId` (FK
 * into the library), not the display name. Without this lookup the only
 * info on the notification is the session name itself.
 */
function buildSessionBody(
  session: SessionTemplate,
  exerciseLibrary: Exercise[],
): string {
  const byId = new Map(exerciseLibrary.map((e) => [e.id, e]));
  const names = session.exercises
    .slice(0, 3)
    .map((se) => byId.get(se.exerciseId)?.name)
    .filter((n): n is string => !!n);
  if (names.length === 0) return session.name;
  const preview = names.join(' → '); // "Bench → OHP → Pushdowns"
  const full = `${session.name} · ${preview}`; // "Push Day A · ..."
  return full.length > 80 ? full.slice(0, 77) + '…' : full;
}

export async function scheduleWorkoutReminders(
  sessions: SessionTemplate[],
  exerciseLibrary: Exercise[] = [],
): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const { display } = await LocalNotifications.requestPermissions();
    if (display !== 'granted') return;

    // Blind-cancel all 7 reserved slots before scheduling. See cancelAllSlots
    // docstring for why this can't trust getPending(). Always cancel even
    // when sessions.length === 0 so an empty program clears prior alarms.
    await cancelAllSlots();

    if (sessions.length === 0) return;

    const now = new Date();

    // De-dupe by dayOfWeek (multiple sessions on the same day share an ID slot;
    // keep the first so we don't try to schedule two notifications under one id).
    const seen = new Set<number>();
    const unique = sessions.filter((s) => {
      if (seen.has(s.dayOfWeek)) return false;
      seen.add(s.dayOfWeek);
      return true;
    });

    const toSchedule = unique
      .map((s: SessionTemplate) => {
        // Next future occurrence of this day-of-week at 09:00
        const target = new Date(now);
        target.setHours(9, 0, 0, 0);
        const diff = (s.dayOfWeek - now.getDay() + 7) % 7;
        const daysToAdd = diff === 0 && now.getTime() >= target.getTime() ? 7 : diff;
        target.setDate(target.getDate() + daysToAdd);

        // Hard guard: never schedule a past time. If math still produced one, push a week.
        if (target.getTime() <= now.getTime()) {
          target.setDate(target.getDate() + 7);
        }

        return {
          id: BASE_ID + s.dayOfWeek,
          // Localised at schedule time. Both the weekday and the surrounding
          // wording were English here regardless of app language.
          title: i18n.t('notif.sessionTitle', { day: weekdayNames('long')[s.dayOfWeek] }),
          body: buildSessionBody(s, exerciseLibrary),
          schedule: {
            at: target,
            repeats: true,
            every: 'week' as const,
            allowWhileIdle: true,
          },
          channelId: CHANNEL_ID,
          // Custom small icon derived from launcher (see
          // limecore/derive_notification_icons.py). Status-bar icons MUST be
          // white-on-transparent or Android renders a fallback glyph.
          smallIcon: 'ic_stat_limelog',
          // Brand lime accent — applied by the OS as the channel/notif color
          // (the small icon's tint and heads-up accent stripe). Matches the
          // CSS --color-lime token (#c8f135) used throughout the app.
          iconColor: '#c8f135',
          // Surfaces the "Start session" action button (registered in
          // setupNotificationChannel). Action click is observed in App.tsx
          // via the localNotificationActionPerformed listener.
          actionTypeId: ACTION_TYPE_ID,
          sound: 'default',
        };
      })
      .filter((n) => n.schedule.at.getTime() > now.getTime());

    if (toSchedule.length === 0) return;
    await LocalNotifications.schedule({ notifications: toSchedule });
  } catch (err) {
    console.warn('[notifications] scheduling failed:', err);
  }
}

