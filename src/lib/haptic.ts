// v1.22 (limecore#130, owner decision 2026-11-19) — haptics that confirm the
// user's own action, never interrupt.
//   light:   checking a set done (which also starts the rest);
//   success: finishing a workout, the end of a rest;
//   warning: confirming a destructive dialog.
// Nothing on scroll, page loads, sync or other background events. The plugin
// follows the system setting: with touch feedback off it does nothing.
//
// It replaces `navigator.vibrate`, which did nothing in the app: a WebView
// ignores it unless the app holds android.permission.VIBRATE, which no plugin
// merged in before this one. Native only; the web build stays silent. The
// plugin loads on the first use, so it costs the startup bundle nothing.
import { Capacitor } from '@capacitor/core';

type Kind = 'light' | 'success' | 'warning';

/** One import for the life of the page, shared by every call. */
let plugin: Promise<typeof import('@capacitor/haptics')> | null = null;

function fire(kind: Kind): void {
  if (!Capacitor.isNativePlatform()) return;
  plugin ??= import('@capacitor/haptics');
  void plugin
    .then(({ Haptics, ImpactStyle, NotificationType }) =>
      kind === 'light'
        ? Haptics.impact({ style: ImpactStyle.Light })
        : Haptics.notification({ type: kind === 'success' ? NotificationType.Success : NotificationType.Warning }),
    )
    .catch(() => {
      /* best-effort: no haptics is never an error worth surfacing */
    });
}

export const haptic = {
  light: () => fire('light'),
  success: () => fire('success'),
  warning: () => fire('warning'),
};
