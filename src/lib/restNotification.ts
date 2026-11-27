// v1.22 (limecore#127 item 4) — the running rest as an ongoing Android
// notification with Skip and +30 s (RestTimerPlugin.java). The countdown is
// Android's own chronometer, so it keeps time in the background and after a
// kill; the notification removes itself when the rest ends.
//
// A button opens MainActivity (the rest lives in the WebView's storage, so
// only JS can change it) and arrives here: at once when the app is running,
// or from the plugin's queue when the tap launched it. Loaded on demand,
// native only (activeRest.ts and App.tsx).
import { registerPlugin } from '@capacitor/core';
import i18n from '@/i18n';
import { loadActiveRest, saveActiveRest, clearActiveRest, type PersistedRest } from './activeRest';

interface RestTimerPlugin {
  show(o: { endsAt: number; title: string; skipLabel: string; plusLabel: string }): Promise<void>;
  hide(): Promise<void>;
  consumeActions(): Promise<{ actions: string[] }>;
  addListener(event: 'restAction', cb: (e: { action: string }) => void): Promise<{ remove: () => void }>;
}

const RestTimer = registerPlugin<RestTimerPlugin>('RestTimer');

/** Fired when a notification button changed the rest; the workout page and
 *  the pill re-read it from storage. */
export const REST_CHANGED_EVENT = 'limelog:rest-changed';

export function showRest(rest: PersistedRest): void {
  void RestTimer.show({
    endsAt: rest.endsAt,
    title: i18n.t('log.restNotifTitle', { name: rest.exerciseName }),
    skipLabel: i18n.t('log.restNotifSkip'),
    plusLabel: i18n.t('log.restNotifPlus30'),
  }).catch(() => {
    /* best-effort: the rest still runs in the app */
  });
}

export function hideRest(): void {
  void RestTimer.hide().catch(() => {});
}

/** Apply one button: 'skip' ends the rest, 'plus30' adds 30 s. */
export function applyRestAction(action: string, now: number = Date.now()): void {
  const rest = loadActiveRest();
  if (!rest) return;
  if (action === 'skip') {
    clearActiveRest();
  } else if (action === 'plus30') {
    const { logId, ...state } = rest;
    saveActiveRest({ ...state, endsAt: Math.max(rest.endsAt, now) + 30_000, total: rest.total + 30 }, logId);
  } else {
    return;
  }
  try {
    window.dispatchEvent(new Event(REST_CHANGED_EVENT));
  } catch {
    /* no window (tests) */
  }
}

let started = false;

/** At app start (native): taps that launched the app, then later ones. */
export function initRestActions(): void {
  if (started) return;
  started = true;
  void RestTimer.addListener('restAction', (e) => applyRestAction(e.action));
  void RestTimer.consumeActions()
    .then(({ actions }) => actions.forEach((a) => applyRestAction(a)))
    .catch(() => {});
}
