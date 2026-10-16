// v1.12 Item 0 — retention instrumentation.
//
// One row per user per app per day, written when the app comes to the
// foreground. Ported from StudyDesk's `src/lib/appOpens.js`; the reasoning is
// identical and worth repeating here rather than cross-referencing, because
// each of these four decisions is one somebody would otherwise undo.
//
// **Foreground, not sign-in.** Sign-in is precisely the event `SESS-1`
// corrupted — the daily forced sign-out meant `last_sign_in_at` recorded a bug
// rather than a habit. "Came back" is the app being opened.
//
// **Local date, not UTC.** `new Date().toISOString().slice(0,10)` is the *UTC*
// date. In UTC+3 at 00:30 local that yields the previous day, so two real days
// collapse into one bucket. Day bucketing is the entire point of the table.
//
// **Queued, not pushed.** LimeLog inherits its Nexus session from NCC over the
// SSO bridge, so a cold start routinely foregrounds before that session exists
// and RLS would reject the write. Offline is the same story. The outbox turns
// both into a retry rather than a lost day.
//
// **Never queued without a Nexus account.** The outbox deliberately never drops
// a failed item, and `drain()` stops at the first failure — so an open queued
// with no account would fail forever and wedge every workout push behind it.

import { Capacitor } from '@capacitor/core';
import { enqueue } from './outbox';
import { supabase, isNexusConfigured } from './supabase';

const LAST_KEY = 'limelog.lastAppOpen';

/** The user's own calendar date, not UTC's. See the header. */
function localDay(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** One of 'android' | 'desktop' | 'web' — the values the table's CHECK allows. */
function platform(): string {
  if (Capacitor.isNativePlatform()) {
    return Capacitor.getPlatform() === 'android' ? 'android' : 'web';
  }
  if (typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent)) {
    return 'desktop';
  }
  return 'web';
}

/**
 * Record today's open, at most once per local day.
 *
 * The localStorage guard is a cost control, not correctness — the composite
 * primary key already makes the write idempotent, so a duplicate would only
 * waste a queue slot on every tab switch.
 */
export async function recordAppOpen(appVersion: string): Promise<boolean> {
  if (!isNexusConfigured) return false;
  // Checked here rather than left to the push: an item queued with no account
  // never succeeds, and a permanently failing head-of-queue blocks everything
  // behind it.
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return false;

  const today = localDay();
  try {
    if (localStorage.getItem(LAST_KEY) === today) return false;
  } catch {
    // Blocked storage — fall through and queue; the primary key still
    // collapses the duplicate server-side.
  }
  enqueue('record_app_open', { appVersion, platform: platform(), openedOn: today });
  try { localStorage.setItem(LAST_KEY, today); } catch { /* see above */ }
  return true;
}

/** v1.18.1 (LimeLog#82) — sign-out. The guard is "this ACCOUNT's open is
 *  queued for today"; kept, it stopped the next account's first open that day
 *  from being recorded. Clearing it costs at most a duplicate item if the same
 *  person signs back in the same day, which the upsert collapses. */
export function forgetLastAppOpen(): void {
  try {
    localStorage.removeItem(LAST_KEY);
  } catch {
    /* no storage: nothing was kept */
  }
}

/**
 * Wire foreground detection. Returns an unsubscribe function.
 *
 * Both triggers are needed: mount covers a cold start, and visibilitychange
 * covers the commoner case of the app being resumed days later without the
 * process ever having died.
 */
export function watchAppOpens(appVersion: string): () => void {
  void recordAppOpen(appVersion);
  if (typeof document === 'undefined') return () => {};
  const onVisible = () => {
    if (document.visibilityState === 'visible') void recordAppOpen(appVersion);
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => document.removeEventListener('visibilitychange', onVisible);
}
