import { create } from 'zustand';
import { Capacitor } from '@capacitor/core';
import { supabase, isNexusConfigured, readStoredSession, clearStoredSession, storedRefreshToken } from '@/lib/supabase';
import { withCaptcha } from '@/lib/captcha';
import { signInWithGoogle as oauthSignInWithGoogle, initOAuthDeepLinkListener } from '@/lib/oauth';
import { setGuestMode, isGuestMode } from '@/lib/guestMode';
import { inheritFromNexus } from '@/lib/suiteSso';
import { scheduleOriginStamp } from '@/lib/originMarker';
// v1.2 — outbox replaces nexusSync's drainPendingQueue/getPendingCount as the
// persistence + retry layer. The actual push handler (pushWorkoutToNexus) is
// still in nexusSync.ts; the outbox dispatches to it via kind tables.
import {
  drain as outboxDrain,
  getStatus as outboxStatus,
  clear as outboxClear,
  installDrainTriggers as outboxInstallTriggers,
  type OutboxStatus,
} from '@/lib/outbox';
// v1.2.1 — AUDIT-LL-FSG-2: stores whose state we wipe on sign-out so
// User A's workout history / body data / progress photos don't surface
// under User B on a shared device. The cloud-side replay path is already
// closed (outboxClear above), so this is the LOCAL view-only leak fix.
// useProgramStore is intentionally NOT wiped — programs / exercises /
// workout templates are tool configuration, not history, and a global
// wipe would clobber the user's custom builtin overrides + force a
// re-seed of BUILTIN_EXERCISES that would lose their tweaks. The
// per-user scope of programs is tracked as a v1.3 design item.
import { watchAppOpens, recordAppOpen, forgetLastAppOpen } from '@/lib/appOpens';
import { releaseOnboardingOnSignOut } from '@/lib/onboarding';
import { forgetReferralAskedLocally } from '@/lib/referralSource';
import { clearEntitlement } from '@/lib/entitlement';
import { useThemeStore } from '@/store/themeStore';
import pkgJson from '../../package.json';
import { useLogStore } from '@/store/logStore';
import { useBodyMetricsStore } from '@/store/bodyMetricsStore';
import { DEFAULT_PREFS as DEFAULT_BODY_METRICS_PREFS } from '@/types/bodyMetrics';

const SYNC_ENABLED_KEY = 'wt_nexus_sync_enabled';

function readSyncEnabled(): boolean {
  const raw = localStorage.getItem(SYNC_ENABLED_KEY);
  return raw === null ? true : raw === 'true';
}

function writeSyncEnabled(v: boolean): void {
  localStorage.setItem(SYNC_ENABLED_KEY, String(v));
}

interface NexusStore {
  configured: boolean;
  syncEnabled: boolean;
  userEmail: string | null;
  /** Display name from the identity provider, when it gives one. Needed so the
   *  avatar can show the same initials as NCC and StudyDesk, which both derive
   *  from the name and fall back to the address. Tracking only the email meant
   *  LimeLog could never agree with them. */
  userName: string | null;
  /** v1.18.1 (LimeLog#85) — the signed-in account's id, set with `userEmail`.
   *  The recovery pull is keyed by it (lib/recoveryGate.ts): the email can
   *  change under the same account, and a token refresh or a resume reports
   *  the same id again, which must not count as a new sign-in. */
  userId: string | null;
  /** A session exists in storage but this launch could not confirm it — the
   *  refresh needed the network and the network was not there.
   *
   *  It is deliberately NOT the same as being signed out, and the auth gate
   *  treats it differently. Signing someone out because a request failed is
   *  the bug this flag exists to close: the credentials were fine, the radio
   *  was not, and the app threw the session away on their behalf. Set only
   *  when storage HAD something (a fresh install errors with no session and
   *  no error, so it never lands here). */
  sessionUnverified: boolean;
  /** v1.18.1 (LimeLog#66): a sign-out that could not reach the server is
   *  still settling. Signing in waits until it has (NexusSyncCard). */
  signOutPending: boolean;
  /** v1.18.1 (LimeLog#85) — `signOut()` is running, from before it wipes the
   *  local logs until it returns. The recovery pull does not start meanwhile,
   *  and a pull already running is not let write its results. */
  signingOut: boolean;
  loading: boolean;
  lastError: string | null;
  pendingCount: number;
  lastPushAt: string | null;
  /** v1.2 — full outbox snapshot for the Settings status panel. Includes
   *  oldestEnqueuedAt, stuck count, lastError, lastSuccessAt — surfaced in
   *  the NexusSyncCard for diagnostic visibility. */
  outboxStatus: OutboxStatus;

  init: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  /** Resolves with whether the account still needs email confirmation — see
   *  the implementation note. Callers that don't care may ignore it. */
  signUp: (email: string, password: string) => Promise<{ needsConfirmation: boolean }>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  setSyncEnabled: (v: boolean) => void;
  retryPending: () => Promise<{ sent: number; remaining: number }>;
  refreshPendingCount: () => void;
  setLastPushAt: (iso: string) => void;
}

/** The provider's display name, or null. Supabase puts Google's on
 *  user_metadata.full_name; some providers use `name`. */
function displayNameOf(user: { user_metadata?: Record<string, unknown> } | null | undefined): string | null {
  const meta = user?.user_metadata ?? {};
  const n = String(meta.full_name || meta.name || '').trim();
  return n || null;
}

// v1.18.1 (LimeLog#66): a sign-out that could not reach the server removes
// the stored session itself. Its signOut() call is still queued behind any
// token refresh in flight, and that refresh can save the session again and
// report it; until the call settles, a session reported is not taken up.
let signOutHold = false;
/** How long sign-out waits for the server before removing the session here. */
const SIGN_OUT_WAIT_MS = 5000;

export const useNexusStore = create<NexusStore>((set, get) => ({
  configured: isNexusConfigured,
  syncEnabled: readSyncEnabled(),
  userEmail: null,
  userName: null,
  userId: null,
  sessionUnverified: false,
  signOutPending: false,
  signingOut: false,
  loading: false,
  lastError: null,
  pendingCount: outboxStatus().pending,
  outboxStatus: outboxStatus(),
  lastPushAt: null,

  init: async () => {
    if (!isNexusConfigured) return;
    initOAuthDeepLinkListener();
    // v1.2 — install global drain triggers (window.online + visibilitychange).
    // Idempotent — safe to call multiple times. Returns a teardown helper that
    // we intentionally don't use; the listeners live for the app's lifetime.
    outboxInstallTriggers();
    set({ loading: true });
    try {
      // v1.19 — LL#64: render from the stored session first.
      //
      // The v1.13 race below bounded the wait for `getSession()` at six
      // seconds, but it was still a wait, and every offline launch more than
      // about an hour after the last refresh paid all of it: an expired
      // access token sends `getSession()` into auth-js's refresh retry chain
      // (~25 s offline, up to ~51 s), so the race always lost to its timer.
      //
      // A session in storage is enough to know who to render for. Read it
      // with no network, open the app on it, and resolve init now; the
      // `getSession()` that used to gate the launch carries on in `settle()`
      // and the auth listener below reports what it finds. Flagged
      // unverified on every launch, not only when the token is past expiry:
      // it means "shown from storage, auth-js has not answered yet", which
      // for a fresh token lasts milliseconds, and it closes the window where
      // a token that read as fresh here crosses auth-js's 90 s expiry margin
      // before its answer arrives. Only the auth gate and the recovery pull
      // read the flag, and with an email set the gate is satisfied anyway.
      const stored = await readStoredSession();
      if (stored) {
        if (stored.expired) console.warn('[nexus] access token expired; opening on the stored session while it refreshes');
        set({
          userEmail: stored.user.email ?? null,
          userName: displayNameOf(stored.user),
          userId: stored.user.id ?? null,
          sessionUnverified: true,
          loading: false,
        });
      }

      // v1.19 — LL#65: the listener goes up BEFORE anything asks for the
      // session, so it hears every answer that request produces. It used to
      // be registered after the race, so the refresh that eventually failed
      // offline surfaced as an `INITIAL_SESSION` with a null session while
      // the stored session was still there — and the handler took that as a
      // sign-out, about 76 s into an offline launch.
      //
      // `answers` counts the events that settle the session (everything but
      // INITIAL_SESSION, which is the same answer `getSession()` gives).
      // `settle()` checks it before writing, so its older answer never
      // overwrites one that landed while it was still waiting.
      let answers = 0;
      supabase.auth.onAuthStateChange((event, session) => {
        if (signOutHold && session) return;
        // INITIAL_SESSION with no session is auth-js reporting that it could
        // not load one — offline, that means the refresh failed, not that
        // the account is gone. A real sign-out arrives as SIGNED_OUT (a
        // refresh token the server rejects removes the session and emits it),
        // so while the stored session is unconfirmed this is not an answer.
        if (event === 'INITIAL_SESSION' && !session && get().sessionUnverified) return;
        if (event !== 'INITIAL_SESSION') answers++;
        const wasSignedIn = Boolean(get().userEmail);
        const wasUnverified = get().sessionUnverified;
        const nowSignedIn = Boolean(session?.user);
        // Anything that gets here is an ANSWER about the session — a refresh
        // that landed, a session auth-js loaded, or a sign-out the server
        // actually asserted. Either way the "could not reach the server to
        // ask" state is over, so the flag clears; leaving it set would hold
        // the auth gate open after a real sign-out.
        set({
          userEmail: session?.user?.email ?? null,
          userName: displayNameOf(session?.user),
          userId: session?.user?.id ?? null,
          sessionUnverified: false,
        });
        scheduleOriginStamp(session?.user ?? null);
        // v1.1 — clear guestMode on any successful sign-in. Without this,
        // a user who signed out (which sets guestMode=true) and later signs
        // in via NexusSyncCard's form would keep guestMode=true while
        // having a real session. The gate would still work (userEmail
        // wins), but if their session ever expired, the next cold start
        // would silently land them in guest mode instead of attempting
        // auto-inherit. Centralizing the clear here means every sign-in
        // path (email, Google, Nexus inherit, restored session) converges
        // to the same state.
        if (event === 'SIGNED_IN') {
          void setGuestMode(false);
          window.dispatchEvent(new CustomEvent('limelog:guest-mode-changed'));
          // v1.12 Item 5 — a supporter who signs in mid-session should see the
          // perk without restarting. `force` skips the six-hour cache, which
          // would otherwise serve the "not entitled" answer cached moments ago
          // while signed out.
          if (session?.user?.id) void useThemeStore.getState().syncEntitlement(session.user.id, { force: true });
          // v1.18.1 (LimeLog#82) — record the new account's open now. Opens
          // are recorded at launch and on resume; someone who signs in
          // mid-launch (the next person on a shared device, after sign-out
          // cleared the day guard) otherwise waited for the next resume.
          // Deferred: recordAppOpen asks auth-js for the session, and auth-js
          // holds its lock while this listener runs (see referralSource.ts).
          // A repeat is a no-op: the day guard stops it.
          setTimeout(() => void recordAppOpen(pkgJson.version), 0);
        }
        // Signing out ends the entitlement with it. `syncEntitlement(null)`
        // clears the cache and hands the store `false`, which drops a paid
        // theme back to lime — otherwise signing out of a supporter account
        // leaves the perk running on a device with no account behind it.
        if (event === 'SIGNED_OUT') {
          void useThemeStore.getState().syncEntitlement(null);
        }
        // v1.19 — `wasUnverified`: an unconfirmed session now carries its
        // email from storage, so "was signed out" alone no longer catches the
        // moment it is confirmed — the moment queued work can finally go.
        if ((!wasSignedIn || wasUnverified) && nowSignedIn && get().syncEnabled) {
          void outboxDrain().then((result) => {
            const status = outboxStatus();
            set({ pendingCount: result.remaining, outboxStatus: status });
          });
        }
      });

      const settle = async () => {
        try {
          // v1.13 — getSession(), not getUser().
          //
          // `getUser()` is a REQUEST to /auth/v1/user on every single cold start,
          // and the old code read `.data.user` while discarding the error. So a
          // launch with no signal — a tunnel, a dead zone, wifi that associates
          // before it routes, a phone whose radio is not up yet — produced
          // `user = null`, indistinguishable from being signed out. The inherit
          // below then needed the network too, failed the same way, and the app
          // rendered FirstLaunchAuth over a session that was sitting in storage,
          // valid, the whole time.
          //
          // That is the "I keep getting logged out" report with nothing on the
          // server to corroborate it: 66 token refreshes in the sample window,
          // all 200, no revoked families, no time-boxed sessions. Nothing
          // happened server-side because nothing was ever asked of it.
          //
          // `getSession()` reads local storage and only touches the network when
          // the access token has actually expired. StudyDesk and NCC have both
          // resolved their session this way all along; this app was the outlier.
          // Bounded, for the reason StudyDesk's suiteSso.js records as item G: an
          // unbounded await in a session-init path does not fail, it HANGS, and
          // the app sits on its loading label until the OS-level TCP timeout —
          // minutes, not seconds. `getSession()` refreshes an expired token, and
          // supabase-js retries that refresh with backoff, so a dead network here
          // is measured in retries rather than one failure. Reproduced: an
          // offline cold start with an expired token left the app on "LOADING…"
          // past nine seconds with six refresh attempts made.
          //
          // Six seconds is longer than any plausible refresh on a slow mobile
          // connection and far shorter than a TCP timeout. Expiring early costs a
          // launch that starts in the unverified state and resolves itself the
          // moment the refresh lands; not expiring at all costs an app that never
          // opens.
          //
          // v1.19 — LL#64: with a stored session this no longer gates the
          // launch (see above); the bound now only decides when the follow-up
          // work at the end of this function runs.
          const resolved = await Promise.race([
            supabase.auth.getSession().then(
              (r) => ({ data: r.data, error: r.error }),
              (error: unknown) => ({ data: { session: null }, error: error as { message?: string } }),
            ),
            new Promise<{ data: { session: null }; error: { message: string } }>((res) =>
              setTimeout(() => res({ data: { session: null }, error: { message: 'timed out resolving the session' } }), 6000),
            ),
          ]);
          const { data: sessionData, error: sessionError } = resolved;
          let user = sessionData.session?.user ?? null;
          // An empty store returns {session: null, error: null}. An error with no
          // session therefore means there WAS one and it could not be refreshed —
          // keep that apart from being signed out. See `sessionUnverified`.
          const unverified = !user && !!sessionError;
          if (unverified) {
            console.warn('[nexus] session present but unverifiable this launch:', sessionError?.message);
          }

          // v1.1 — auto-inherit from NCC on cold start when no local session.
          //
          // Why: Supabase rotates refresh_tokens on every refresh (default
          // behavior). NCC + LimeLog + StudyDesk all share ONE logical session
          // via the SSO bundle, but each app's supabase client persists its own
          // copy. Whichever side refreshes second gets a stale refresh_token,
          // its auto-refresh fails, and onAuthStateChange fires SIGNED_OUT.
          // Symptom: every cold start of LimeLog (after NCC has rotated in the
          // background) lands the user on the auth screen needing to tap
          // "Continue with Nexus" again. Reported 2026-05-28.
          //
          // Fix: when getUser() returns no user, probe NCC's ContentProvider
          // and silently inherit. As long as NCC is signed in, this re-syncs
          // LimeLog to the latest published bundle. The user never sees the
          // auth screen unless NCC itself has signed out. Guest mode and the
          // web platform short-circuit this path — guests opted out of auth
          // explicitly; web has no native plugin to call.
          //
          // `!unverified` is new: inheriting is for an app that has no session,
          // not for one whose session merely could not be reached. Probing NCC
          // over the same dead network would only spend the SSO timeout before
          // failing the same way.
          if (!user && !unverified && Capacitor.isNativePlatform() && !isGuestMode()) {
            try {
              // v1.19 — LL#64: bounded. The inherit is two network calls (the
              // suite-session function, then redeeming its credential), and
              // with no stored session the launch is waiting on it. Past three
              // seconds the app opens on the sign-in screen and the inherit
              // carries on; if it lands, its SIGNED_IN reaches the listener
              // above and flips the gate.
              const result = await Promise.race([
                inheritFromNexus(),
                new Promise<null>((res) => setTimeout(() => res(null), 3000)),
              ]);
              if (!result) console.warn('[nexus] auto-inherit still running after 3 s; not holding the launch for it');
              if (result?.ok) {
                user = (await supabase.auth.getSession()).data.session?.user ?? null;
              }
            } catch (e) {
              // Silent — fall through to no-user state, FirstLaunchAuth will
              // render with the manual Continue-with-Nexus affordance as the
              // user-visible fallback.
              console.warn('[nexus] auto-inherit on init failed:', e);
            }
          }

          // v1.19 — two cases where this answer is not the one to write:
          //   - an auth event landed while it was being fetched (`answers`),
          //     which is newer than anything computed here;
          //   - the session came from storage and could not be checked. The
          //     app is already showing it; writing `user` (null) would sign
          //     the user out of the screen for want of a network. Leave it
          //     unverified and let the refresh, when it lands, answer.
          // ...and not while a sign-out is settling: the session this read
          // found is the one being signed out (v1.18.1, LimeLog#66).
          if (!answers && !(stored && unverified) && !signOutHold) {
            set({
              userEmail: user?.email ?? null,
              userName: displayNameOf(user),
              userId: user?.id ?? null,
              sessionUnverified: unverified,
            });
          }
          set({ loading: false });

          // ACT-5 — cover the restored-session path too, not just fresh sign-ins.
          // Every account that predates this instrumentation only ever appears here.
          scheduleOriginStamp(user ?? null);

          // v1.12 Item 0 — retention. Placed after the SSO inherit above rather
          // than at component mount: on a cold start LimeLog usually has no
          // session until that call resolves, and an open recorded before it would
          // find no user and be skipped. The visibilitychange listener installed
          // here covers the commoner case — the app resumed from the background
          // days later without the process having died.
          watchAppOpens(pkgJson.version);

          // v1.12 Item 5 — supporter entitlement, sited here for the same reason
          // as the line above: on a cold start there is usually no session until
          // the SSO inherit resolves, and asking earlier would cache a "not
          // entitled" answer for six hours.
          // Routed through the theme store rather than calling
          // `refreshEntitlement` directly. The raw call updates the cache and
          // nothing else — the store's `setEntitled` is what demotes a paid theme
          // when an entitlement has lapsed, and without it a lapsed supporter
          // keeps Cast Iron until they happen to restart the app.
          if (user?.id) void useThemeStore.getState().syncEntitlement(user.id);

          if (user && get().syncEnabled) {
            const result = await outboxDrain();
            set({ pendingCount: result.remaining, outboxStatus: outboxStatus() });
          }
        } catch (err) {
          set({ loading: false, lastError: err instanceof Error ? err.message : String(err) });
        }
      };
      // With a stored session the app is already open on it; nothing here
      // may hold the launch. Without one the gate needs this answer first —
      // bounded by the six-second race and the three-second inherit above.
      if (stored) void settle();
      else await settle();
    } catch (err) {
      set({ loading: false, lastError: err instanceof Error ? err.message : String(err) });
    }
  },

  signIn: async (email, password) => {
    set({ loading: true, lastError: null });
    // withCaptcha only involves hCaptcha if the server asks for it — see
    // lib/captcha.ts for why this is not a widget on the screen.
    const { data, error } = await withCaptcha((captchaToken) =>
      supabase.auth.signInWithPassword({ email, password, options: { captchaToken } }));
    if (error) {
      set({ loading: false, lastError: error.message });
      throw error;
    }
    set({ userEmail: data.user?.email ?? null, userName: displayNameOf(data.user), userId: data.user?.id ?? null, loading: false });

    if (get().syncEnabled) {
      const result = await outboxDrain();
      set({ pendingCount: result.remaining, outboxStatus: outboxStatus() });
    }
  },

  signUp: async (email, password) => {
    set({ loading: true, lastError: null });
    const { data, error } = await withCaptcha((captchaToken) =>
      supabase.auth.signUp({ email, password, options: { captchaToken } }));
    if (error) {
      set({ loading: false, lastError: error.message });
      throw error;
    }
    // v1.18.1 (LimeLog#85) — the id only with a session: an account still
    // awaiting confirmation cannot be pulled for yet, and its SIGNED_IN, when
    // confirmed, sets the id and starts the recovery pull then.
    set({
      userEmail: data.user?.email ?? null,
      userName: displayNameOf(data.user),
      userId: data.session ? data.user?.id ?? null : null,
      loading: false,
    });
    // AUTH-2 — Supabase returns a session only when the project auto-confirms.
    // With confirmation required, `session` is null and the caller has to show
    // the code step rather than waiting on an auth-state change that never
    // comes. Reported rather than inferred: previously a successful signup
    // awaiting confirmation looked identical to a stall.
    return { needsConfirmation: !data.session };
  },

  signInWithGoogle: async () => {
    set({ loading: true, lastError: null });
    try {
      await oauthSignInWithGoogle();
      // Web flow redirects away; native flow returns here and the auth-state listener picks up the session.
      set({ loading: false });
    } catch (err) {
      set({ loading: false, lastError: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  signOut: async () => {
    // v1.18.1 (LimeLog#85) — first, before the wipe below: a recovery pull
    // still running must not write the signed-out account's workouts back
    // into the emptied store, and none may start until this returns.
    // `finally`, so a sign-out that throws part-way cannot block the pull for
    // the rest of the launch.
    set({ signingOut: true });
    try {
      set({ loading: true, lastError: null });
      // v1.2 — clear the outbox BEFORE the auth round-trip. Anything not yet
      // drained is forfeit vs. potentially leaking writes to the next signed-in
      // user on a shared device. Matches StudyDesk's sign-out hygiene contract.
      outboxClear();
      // v1.12 Item 5 — the supporter entitlement is cached locally so a perk
      // survives being offline. That cache is per-account, so it has to go with
      // everything else here: leaving it would hand the next signed-in user on a
      // shared device someone else's paid perk.
      clearEntitlement();
      // v1.2.1 — AUDIT-LL-FSG-2: wipe the personal-data stores so the next
      // signed-in user (on a shared device) doesn't inherit User A's
      // workout history, bodyweight log, or progress photos in the UI.
      // Cloud-side data stays scoped to A's user_id; this only addresses
      // the on-device residue. Wipe order doesn't matter — each call
      // both clears the in-memory zustand state and removes the underlying
      // localStorage key so a refresh after sign-out doesn't re-hydrate.
      try {
        localStorage.removeItem('wt_session_logs');
        localStorage.removeItem('wt_jump_logs');
        localStorage.removeItem('wt_stall_flags');
        useLogStore.setState({ sessionLogs: [], jumpLogs: [], stallFlags: [] });
      } catch (e) {
        console.warn('[nexus] log-store wipe failed:', e);
      }
      try {
        localStorage.removeItem('limelog-body-metrics');
        localStorage.removeItem('limelog-body-metrics-prefs');
        // bodyMetricsStore reads DEFAULT_PREFS from types/bodyMetrics on the
        // next mount; the setState below restores in-memory state to that
        // baseline so an already-mounted BodyMetricsPanel re-renders empty
        // immediately rather than holding A's last-seen values.
        useBodyMetricsStore.setState({ metrics: [], prefs: DEFAULT_BODY_METRICS_PREFS });
      } catch (e) {
        console.warn('[nexus] body-metrics wipe failed:', e);
      }
      try {
        localStorage.removeItem('limelog-progress-photos');
      } catch (e) {
        console.warn('[nexus] progress-photos wipe failed:', e);
      }
      // v1.18.1 (LimeLog#82) — the per-person flags go too, as an erase removes
      // them (dataRights.wipeAllLocalData). Each helper says why it is safe:
      // the training goal is display-only, the referral mirror is backed by the
      // account's metadata, and the app-open guard costs at most a duplicate
      // the upsert collapses. The onboarding flag is re-marked, not removed: a
      // guest carrying on is not sent through the wizard again, and the next
      // account's own answer resets it at sign-in. Device settings stay: the
      // language (limecore_lang), the F-Droid update check, the sync toggle,
      // programs and exercises. guestMode is set below, not cleared — see there.
      releaseOnboardingOnSignOut();
      forgetReferralAskedLocally();
      forgetLastAppOpen();
      // v1.18.1 (LimeLog#66): the data above is already gone, so the session
      // has to go too, server or not. Offline, auth-js first resolves the
      // session (an expired token means its refresh retry chain, up to ~51 s)
      // and then returns a network error WITHOUT removing it: the user stayed
      // signed in with an empty app. Give the server a few seconds; past that,
      // or on any error, remove the stored session here. auth-js then emits no
      // SIGNED_OUT, so the entitlement is dropped here as that event would.
      signOutHold = true;
      // The session being signed out, so the clean-up below can tell it from a
      // sign-in that lands meanwhile.
      const signedOutToken = await storedRefreshToken();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const call = supabase.auth
        .signOut({ scope: 'local' })
        .then(({ error }) => error ?? null, (e: unknown) => (e instanceof Error ? e : new Error(String(e))));
      const outcome = await Promise.race([
        call,
        new Promise<'timeout'>((res) => {
          timer = setTimeout(() => res('timeout'), SIGN_OUT_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
      if (outcome) {
        console.warn('[nexus] sign-out did not reach the server; removing the local session:', outcome === 'timeout' ? 'timed out' : outcome.message);
        await clearStoredSession();
        void useThemeStore.getState().syncEntitlement(null);
        // A refresh ahead of the call may save the session again before the
        // call runs; when it settles, remove it once more if it failed, but
        // only if it is still the signed-out one. Signing in is disabled until
        // then (signOutPending), so nothing newer should be there; this makes
        // sure of it.
        set({ signOutPending: true });
        void call.then(async (late) => {
          if (late && signedOutToken !== undefined) await clearStoredSession(signedOutToken);
          signOutHold = false;
          set({ signOutPending: false });
        });
      } else {
        signOutHold = false;
      }
      // v1.1 — set guestMode TRUE on sign-out (was previously cleared to false).
      //
      // Why: nexusStore.init silently re-inherits from NCC on cold start if
      // the local session is missing AND guestMode is false (see the
      // refresh-token-rotation fix earlier in this file). Setting guestMode
      // to false here would mean the user's next app launch silently undoes
      // their sign-out by inheriting NCC's still-active session — bug report
      // 2026-05-28 "sign out buttons don't seem to do anything."
      //
      // Setting it to TRUE achieves two goals:
      //   1. The user lands in guest mode immediately. The app stays usable
      //      (no FirstLaunchAuth bounce); NexusSyncCard flips from the
      //      signed-in view to the sign-in form, which is the clear visible
      //      confirmation that sign-out completed.
      //   2. The next cold start respects guestMode and skips auto-inherit.
      //      The sign-out actually sticks.
      //
      // To re-sign-in later, the user opens Profile → Settings → Nexus sync
      // and uses Continue with Nexus / Google / email. Those paths each
      // clear guestMode via their own success handlers.
      // v1.18.1 (LimeLog#85): the account is cleared before the guest-mode
      // write, so a failure there cannot leave the old user on screen (and
      // the recovery gate re-pulling for them when `signingOut` drops).
      set({
        userEmail: null,
        userName: null,
        userId: null,
        // A fallback sign-out emits no SIGNED_OUT to clear this (v1.18.1).
        sessionUnverified: false,
      });
      await setGuestMode(true);
      window.dispatchEvent(new CustomEvent('limelog:guest-mode-changed'));
      set({
        loading: false,
        pendingCount: 0,
        outboxStatus: outboxStatus(),
      });
    } finally {
      set({ signingOut: false });
    }
  },

  setSyncEnabled: (v) => {
    writeSyncEnabled(v);
    set({ syncEnabled: v });
  },

  retryPending: async () => {
    const result = await outboxDrain();
    set({ pendingCount: result.remaining, outboxStatus: outboxStatus() });
    return result;
  },

  refreshPendingCount: () => {
    const status = outboxStatus();
    set({ pendingCount: status.pending, outboxStatus: status });
  },

  setLastPushAt: (iso) => {
    set({ lastPushAt: iso });
  },
}));
