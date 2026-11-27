// v1.22 (limecore#127) — deep links into the router:
//   com.limecore.workouttracker://open/today          Today
//   com.limecore.workouttracker://open/today?start=1  Today, starting today's workout (shortcut)
//   com.limecore.workouttracker://open/progress       Progress
//   com.limecore.workouttracker://open/body?add=1     Body, at the entry form (shortcut)
//   com.limecore.workouttracker://open/workout/<id>   a workout
// Used by the launcher shortcuts (res/xml/shortcuts.xml), the rest-timer
// notification and NCC's cross-app links.
//
// MainActivity is exported and BROWSABLE, so anything can send one: only the
// routes above are accepted, and an id must look like an id. A link is never
// more than navigation. It is held until the router is up (DeepLinkBridge in
// App.tsx), so one that arrives at the sign-in screen opens after sign-in.
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';

const PREFIX = 'com.limecore.workouttracker://open/';

/** The router path for a deep link, or null if it is not one of ours. */
export function routeForDeepLink(url: string): string | null {
  if (!url.startsWith(PREFIX)) return null;
  const rest = url.slice(PREFIX.length);
  const [path, query = ''] = rest.split('?', 2);
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  switch (parts[0]) {
    case 'today':
      return parts.length === 1 ? (params.get('start') === '1' ? '/today?start=1' : '/today') : null;
    case 'progress':
      return parts.length === 1 ? '/progress' : null;
    case 'body':
      return parts.length === 1 ? (params.get('add') === '1' ? '/body?add=1' : '/body') : null;
    case 'workout':
      return parts.length === 2 && /^[A-Za-z0-9-]{1,64}$/.test(parts[1]) ? `/workout/${parts[1]}` : null;
    default:
      return null;
  }
}

let pending: string | null = null;
const listeners = new Set<(route: string) => void>();

function deliver(url: string | undefined | null): void {
  const route = url ? routeForDeepLink(url) : null;
  if (!route) return;
  if (listeners.size === 0) {
    pending = route;
    return;
  }
  for (const l of listeners) l(route);
}

/** The router side: called with each link, and with one that came first. */
export function onDeepLink(listener: (route: string) => void): () => void {
  listeners.add(listener);
  if (pending) {
    const route = pending;
    pending = null;
    listener(route);
  }
  return () => listeners.delete(listener);
}

let started = false;

/** Listen for links: the one that launched the app, and later ones. */
export function initDeepLinks(): void {
  if (started || !Capacitor.isNativePlatform()) return;
  started = true;
  void App.getLaunchUrl()
    .then((r) => deliver(r?.url))
    .catch(() => {
      /* no launch URL */
    });
  void App.addListener('appUrlOpen', ({ url }) => deliver(url));
}

/** Test seam. */
export function deliverForTest(url: string): void {
  deliver(url);
}
