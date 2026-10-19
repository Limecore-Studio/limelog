// v1.4 — cross-app SSO consumer (LimeLog side).
//
// Queries NCC's signature-protected SessionContentProvider for an active
// Supabase session and hands the bundle to supabase.auth.setSession so
// the user inherits NCC's sign-in without a separate Google round-trip.
//
// Failure modes (all surface via { available: false, reason }):
//   - NCC not installed
//   - LimeLog signed with a different cert than NCC
//   - NCC has no active session (user signed out, or never signed in)
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
}

// Plugin name MUST match @CapacitorPlugin(name = "SuiteSso") on the Java
// side. registerPlugin is the canonical Capacitor 5+ binding for custom
// plugins registered via MainActivity.registerPlugin(...).
const SuiteSso = registerPlugin<SuiteSsoPluginAndroid>('SuiteSso');

interface InheritResult {
  ok: boolean;
  reason?: string;
  email?: string;
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
// The setSession path is kept as a fallback for one reason: if the function is
// unreachable (offline, not yet deployed, an older backend) the old behaviour
// is still better than refusing to sign in. It is strictly the degraded path -
// it restores the collision risk - so it says so in the log.
//
// v1.19 - LL#64: except offline. A request that never reached the function
// says nothing about the backend, only that there is no network, and
// setSession() with an expired access token would then run auth-js's refresh
// retry chain over that same dead network (~25 s, or never returning on a
// network that hangs instead of failing). Fail fast and leave the manual
// "Continue with Nexus" for when there is signal.
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

async function adoptSession(bundle: {
  access_token: string;
  refresh_token: string;
  email?: string;
}): Promise<InheritResult> {
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
      console.warn('[sso] suite-session unavailable, using shared-token fallback:', error.message);
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
      // That failure is not cosmetic: it drops us to the shared-token fallback
      // below, which is exactly the refresh-token collision this whole SSO
      // rewrite exists to prevent. The server-side record shows the result —
      // healthy rotation for hours, then the entire token family revoked and a
      // fresh session seconds later, i.e. all three apps signed out.
      //
      // Trying the three plausible types costs one round trip on the unlucky
      // path and nothing on the lucky one, and it stops a version difference
      // in Auth from silently re-enabling a daily logout.
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
      console.warn('[sso] one-time credential rejected, using fallback:', otpErr?.message);
    }
  } catch (e) {
    if (offline(e)) return failFast(e);
    console.warn('[sso] suite-session threw, using shared-token fallback:', (e as Error).message);
  }

  // Degraded path - shares NCC's refresh token, so the revocation collision
  // this release exists to fix is possible again until the function is back.
  const { error } = await supabase.auth.setSession({
    access_token: bundle.access_token,
    refresh_token: bundle.refresh_token,
  });
  if (error) {
    return { ok: false, reason: 'Supabase rejected the inherited session: ' + error.message };
  }
  return { ok: true, email: bundle.email };
}

/** Pull NCC's active session and apply it to LimeLog's Supabase client.
 *  No-op on web (sibling apps don't exist there). */
export async function inheritFromNexus(): Promise<InheritResult> {
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
  let bundle: { access_token?: string; refresh_token?: string; email?: string };
  try {
    bundle = JSON.parse(queryResult.bundleJson ?? '{}');
  } catch {
    return { ok: false, reason: 'Nexus returned a malformed session bundle.' };
  }
  if (!bundle.access_token || !bundle.refresh_token) {
    return { ok: false, reason: 'Nexus session missing required tokens.' };
  }
  // Either path fires onAuthStateChange, so LimeLog's existing
  // nexusStore.init wiring takes over automatically.
  return adoptSession({
    access_token: bundle.access_token,
    refresh_token: bundle.refresh_token,
    email: bundle.email,
  });
}
