// v1.4 — cross-app SSO consumer (LimeLog side).
//
// Queries NCC's signature-protected SessionContentProvider for an active
// Supabase session and exchanges it, through the `suite-session` function,
// for a session of LimeLog's own, so the user inherits NCC's sign-in without
// a separate Google round-trip.
//
// Failure modes (all surface via { ok: false, reason }):
//   - NCC not installed
//   - LimeLog signed with a different cert than NCC
//   - NCC has no active session (user signed out, or never signed in)
//   - NCC's published session has expired ('nexus-stale')
//   - NCC is signed in to another account than the caller allows ('other-account')
//
// Caller flow: show "Continue with Nexus" button → call inheritFromNexus()
// → on { ok: true } the supabase client is now authenticated and the
// normal store init (nexusStore.init in App.tsx) takes over. On
// { ok: false } show the reason and fall back to the existing sign-in UI.

import { Capacitor, registerPlugin } from '@capacitor/core';
import { FunctionsFetchError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

interface SuiteSsoPluginAndroid {
  getNexusSession(): Promise<{
    available: boolean;
    reason?: string;
    bundleJson?: string;
    publishedAt?: number;
  }>;
  /** v1.21.1 (limecore#101) — bring NCC to the front so it publishes a fresh
   *  session. { opened: false } when NCC is not there. */
  openNexus(): Promise<{ opened: boolean }>;
}

// Plugin name MUST match @CapacitorPlugin(name = "SuiteSso") on the Java
// side. registerPlugin is the canonical Capacitor 5+ binding for custom
// plugins registered via MainActivity.registerPlugin(...).
const SuiteSso = registerPlugin<SuiteSsoPluginAndroid>('SuiteSso');

export interface InheritResult {
  ok: boolean;
  /** Text to show, or one of two codes the callers handle themselves:
   *  - 'nexus-stale': NCC's published session has expired (NCC has not run
   *    lately). Nothing was sent; opening NCC once publishes a fresh one.
   *  - 'other-account': NCC is signed in to an account other than
   *    `onlyUserId`, so nothing was adopted (limecore#111). */
  reason?: string;
  email?: string;
}

/** A bundle whose access token expires within this margin counts as stale:
 *  `suite-session` would answer 401 by the time the request arrived. */
const STALE_MARGIN_MS = 60_000;

/** The `sub` claim of a JWT, or null when it cannot be read. Only compared
 *  with this device's recorded owner; nothing else is trusted on it (the
 *  function verifies the token itself). */
export function tokenUserId(accessToken: string): string | null {
  try {
    const seg = accessToken.split('.')[1];
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    return typeof json.sub === 'string' ? json.sub : null;
  } catch {
    return null;
  }
}

/** Opens NCC so it can publish a fresh session. False when it could not. */
export async function openNexus(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    return (await SuiteSso.openNexus()).opened === true;
  } catch {
    return false;
  }
}

// -- v1.10: inherit the IDENTITY, not the refresh token -------------------
// This used to call supabase.auth.setSession() with NCC's tokens, which put
// this app into NCC's refresh-token rotation family. Supabase rotates a
// refresh_token on every use and treats a second presentation of a spent one
// as theft, revoking the whole family - so whichever sibling woke up second
// signed all three apps out. That was the "logged out every day or two"
// report, and the server-side record agreed: six sessions died in seventeen
// days, all Android, each one minutes after a successful rotation by another
// app rather than after any idle period.
//
// Now we hand NCC's access_token to the `suite-session` Edge Function, which
// verifies it and returns a one-time credential; redeeming it gives this app a
// session with its own independent rotation chain. The apps can no longer
// revoke one another.
//
// v1.21.1 (limecore#101) - the setSession fallback is gone. It handed NCC's
// refresh token to this app whenever the function failed, and the function
// failed whenever NCC had not run in the last hour (its published access token
// had expired), so the "degraded" path was the usual one and the revocation
// above kept happening. No path here uses NCC's refresh token any more: an
// expired bundle is not sent at all ('nexus-stale'), and any failure of the
// function or of the one-time credential is a plain failure.
//
// v1.19 - LL#64: offline fails fast. A request that never reached the
// function says nothing about the backend, only that there is no network.
const offline = (e: unknown) => e instanceof FunctionsFetchError || e instanceof TypeError;
const OFFLINE: InheritResult = { ok: false, reason: 'Nexus sign-in needs a network connection.' };
// v1.19 (LimeLog#67 review): the time limit below also ends in a fetch
// error, and on a slow but working network "needs a network connection" was
// the wrong thing to say. The abort shows as an AbortError/TimeoutError on the
// error or its `context`; with the device online, say it timed out instead.
const timedOut = (e: unknown) => {
  const inner = (e as { context?: unknown } | null)?.context ?? e;
  const name = (inner as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
};
const TIMED_OUT: InheritResult = { ok: false, reason: 'Nexus sign-in timed out. Check the connection and try again.' };
const failFast = (e: unknown): InheritResult =>
  timedOut(e) && typeof navigator !== 'undefined' && navigator.onLine !== false ? TIMED_OUT : OFFLINE;
const FAILED: InheritResult = { ok: false, reason: 'Nexus sign-in failed. Sign in another way.' };

async function adoptSession(bundle: { access_token: string; email?: string }): Promise<InheritResult> {
  try {
    const { data, error } = await supabase.functions.invoke('suite-session', {
      body: { app: 'limelog' },
      headers: { Authorization: 'Bearer ' + bundle.access_token },
      // v1.19 - LL#64: bounded. Unset, a network that hangs rather than fails
      // holds this call until the OS gives up on the socket. The abort
      // surfaces as a FunctionsFetchError, so it takes the offline exit below.
      // 10 s rather than 5: a slow mobile network needs the room.
      timeout: 10000,
    });
    if (offline(error)) return failFast(error);
    if (error) {
      console.warn('[sso] suite-session refused:', error.message);
    } else if (data?.token_hash) {
      // v1.11 — try each credential type rather than betting on one.
      //
      // `suite-session` mints with `generateLink({ type: 'magiclink' })`, but
      // GoTrue has no `magiclink` value in its `one_time_token_type` enum — it
      // files a magiclink under `recovery_token`. Which string `verifyOtp`
      // wants for that row has moved between GoTrue versions, and getting it
      // wrong fails as `403 "One-time token not found"`, which the server logs
      // show happening.
      //
      // Trying the three plausible types costs one round trip on the unlucky
      // path and nothing on the lucky one, and it stops a version difference
      // in Auth from failing every Nexus sign-in.
      const TYPES = ['magiclink', 'email', 'recovery'] as const;
      let otpErr: { message?: string } | null = null;
      for (const type of TYPES) {
        const { error } = await supabase.auth.verifyOtp({
          token_hash: data.token_hash as string,
          type,
        });
        if (!error) return { ok: true, email: bundle.email };
        otpErr = error;
        // A consumed one-time token cannot be retried with another type, so
        // stop rather than burning the remaining attempts on a dead credential.
        if (!/not found|invalid|expired/i.test(error.message || '')) break;
      }
      console.warn('[sso] one-time credential rejected:', otpErr?.message);
    }
  } catch (e) {
    if (offline(e)) return failFast(e);
    console.warn('[sso] suite-session threw:', (e as Error).message);
  }
  return FAILED;
}

/** Sign in as the account NCC is signed in to, through `suite-session`.
 *  No-op on web (sibling apps don't exist there).
 *
 *  `onlyUserId` (limecore#111, as StudyDesk's suiteSso.js): refuse a bundle
 *  for any other account (`reason: 'other-account'`). The automatic sign-in at
 *  startup passes this device's data owner, so a different account signed in
 *  to NCC is never adopted silently and the account-switch wipe never runs
 *  without the user choosing it; the sign-in screen can still pick it. */
export async function inheritFromNexus({ onlyUserId }: { onlyUserId?: string | null } = {}): Promise<InheritResult> {
  if (!Capacitor.isNativePlatform()) {
    return { ok: false, reason: 'Cross-app sign-in is only available on Android.' };
  }
  let queryResult: Awaited<ReturnType<SuiteSsoPluginAndroid['getNexusSession']>>;
  try {
    queryResult = await SuiteSso.getNexusSession();
  } catch (e) {
    return { ok: false, reason: 'SSO plugin unavailable: ' + (e as Error).message };
  }
  if (!queryResult.available) {
    return { ok: false, reason: queryResult.reason ?? 'No Nexus session available.' };
  }
  let bundle: { access_token?: string; expires_at?: number; email?: string };
  try {
    bundle = JSON.parse(queryResult.bundleJson ?? '{}');
  } catch {
    return { ok: false, reason: 'Nexus returned a malformed session bundle.' };
  }
  if (!bundle.access_token) {
    return { ok: false, reason: 'Nexus session missing required tokens.' };
  }
  if (onlyUserId && tokenUserId(bundle.access_token) !== onlyUserId) {
    return { ok: false, reason: 'other-account' };
  }
  // expires_at is in seconds (NCC's ssoPublisher passes Supabase's value on).
  // Missing or past: the function could only answer 401, so do not ask it.
  const expiresAt = Number(bundle.expires_at) * 1000;
  if (!(expiresAt > Date.now() + STALE_MARGIN_MS)) {
    return { ok: false, reason: 'nexus-stale' };
  }
  // A redeemed credential fires onAuthStateChange, so LimeLog's existing
  // nexusStore.init wiring takes over automatically.
  return adoptSession({ access_token: bundle.access_token, email: bundle.email });
}
