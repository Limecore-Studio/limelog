import { createClient, type SupportedStorage, type User } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';

// Supabase backend — overridable at build time via Vite env vars so the app
// can be re-built against a self-hosted Supabase instance without forking
// (see `.env.example`). The defaults below point at the canonical Limecore
// project, matching NCC (`src/lib/supabase.ts`) and StudyDesk
// (`src/lib/supabase.js`), so any public build keeps working.
//
// These MUST have hardcoded defaults, not env-only values. Vite inlines
// `import.meta.env` at build time and `.env` is gitignored, so a build from a
// clean source checkout — which is exactly what F-Droid does — baked in
// `undefined` and shipped an app whose createClient threw "supabaseUrl is
// required." at startup: no sign-in, no sync. It also made the build
// unreproducible, since our local output embedded values the public source
// could not produce. The anon key is publishable (RLS is the access gate) and
// is already inlined in every released APK, so committing it exposes nothing.
const url =
  import.meta.env.VITE_SUPABASE_URL || 'https://hkktorzhaqnfqsnlstda.supabase.co';
const anonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_ykHLJ4QuFm2HKXACygwezw_c_cvR_yf';

// ── Where the session actually lives ───────────────────────────────────────
//
// With no `storage` option supabase-js defaults to the WebView's
// localStorage. NCC has used Capacitor Preferences since v1.7 and StudyDesk
// since v1.10, both for the reason their comments give: Preferences is
// Android SharedPreferences, and localStorage is WebView storage that Android
// evicts under pressure. This app was the one that never got the port, so it
// was the one whose users were silently signed out when the system decided it
// needed the space — with nothing on the server to show for it, because from
// Supabase's side nothing happened at all.
//
// `getItem` falls back to localStorage on a MISSING value, not only on a
// thrown one. That is the upgrade path: every existing install has its session
// in localStorage right now, and without the read-through every one of them
// would be signed out by this very fix. Found once, it is written into
// Preferences, so the fallback is a migration rather than a permanent second
// home.
const capacitorStorage: SupportedStorage = {
  async getItem(key) {
    try {
      const { value } = await Preferences.get({ key });
      if (value !== null && value !== undefined) return value;
      // Nothing in Preferences: this is either a fresh install or an install
      // upgrading from the localStorage era. Migrate rather than sign out.
      const legacy = localStorage.getItem(key);
      if (legacy !== null) {
        try {
          await Preferences.set({ key, value: legacy });
          localStorage.removeItem(key);
        } catch {
          /* keep the legacy copy; it is still the live session */
        }
      }
      return legacy;
    } catch {
      return localStorage.getItem(key);
    }
  },
  async setItem(key, value) {
    try {
      await Preferences.set({ key, value });
    } catch {
      localStorage.setItem(key, value);
    }
  },
  async removeItem(key) {
    try {
      await Preferences.remove({ key });
    } catch {
      /* fall through — the localStorage copy below must go either way */
    }
    try {
      localStorage.removeItem(key);
    } catch {
      /* private mode */
    }
  },
};

const STORAGE_KEY = 'wt_nexus_auth';

export const supabase = createClient(url, anonKey, {
  auth: {
    // Web keeps localStorage: there is no Preferences plugin in a browser, the
    // eviction problem is an Android WebView one, and wrapping a synchronous
    // store in an async shim there buys nothing.
    storage: Capacitor.isNativePlatform() ? capacitorStorage : undefined,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
    storageKey: STORAGE_KEY,
  },
});

// ── The stored session, without asking anyone (v1.19 — LL#64) ─────────────
//
// `getSession()` is local only while the access token is fresh. Once it has
// expired — any launch more than about an hour after the last refresh — it
// refreshes first, and offline auth-js retries that refresh with backoff for
// ~25 s (up to ~51 s) before answering. Cold start awaited that answer, so
// every such offline launch sat on "LOADING…" for the full init timeout.
//
// This reads the same entry from the same adapter the client persists to and
// does nothing else: no refresh, no lock, no network. It decides what to RENDER;
// auth-js still decides whether the session is good, and says so through
// onAuthStateChange (nexusStore.init).
export interface StoredSession {
  user: User;
  /** Access-token expiry, epoch seconds — auth-js's `expires_at`. */
  expiresAt: number;
  /** Past auth-js's own expiry margin, i.e. `getSession()` will refresh. */
  expired: boolean;
}

/** auth-js treats a token as expired 90 s early (3 ticks of 30 s —
 *  EXPIRY_MARGIN_MS in auth-js's constants). Same margin, same answer. */
const EXPIRY_MARGIN_MS = 90_000;

/** Parse a persisted auth entry. Null for anything auth-js would not accept
 *  as a session (its `_isValidSession`), or that carries no user to show. */
export function parseStoredSession(raw: string | null, now = Date.now()): StoredSession | null {
  try {
    const s = raw ? JSON.parse(raw) : null;
    const exp = s?.expires_at;
    if (!s?.access_token || !s.refresh_token || typeof exp !== 'number' || !s.user?.id) return null;
    return { user: s.user, expiresAt: exp, expired: exp * 1000 - now < EXPIRY_MARGIN_MS };
  } catch {
    return null;
  }
}

export async function readStoredSession(): Promise<StoredSession | null> {
  try {
    return parseStoredSession(
      Capacitor.isNativePlatform() ? await capacitorStorage.getItem(STORAGE_KEY) : localStorage.getItem(STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

/** Remove the stored session without asking the server (v1.18.1, LimeLog#66).
 *  For a sign-out that could not reach it: offline, auth-js returns a network
 *  error from signOut() BEFORE removing the session, so the user stayed
 *  signed in. auth-js reads the session from storage on every use, so once
 *  this entry is gone it has none. */
export async function clearStoredSession(onlyIfRefreshToken?: string): Promise<void> {
  try {
    const read = (k: string) =>
      Capacitor.isNativePlatform() ? capacitorStorage.getItem(k) : Promise.resolve(localStorage.getItem(k));
    const remove = (k: string) =>
      Capacitor.isNativePlatform() ? capacitorStorage.removeItem(k) : Promise.resolve(localStorage.removeItem(k));
    // `onlyIfRefreshToken`: remove the session only if it is still that one.
    // A sign-in that landed since must not be taken with it.
    if (onlyIfRefreshToken !== undefined) {
      const raw = await read(STORAGE_KEY);
      let stored: string | undefined;
      try {
        stored = raw ? JSON.parse(raw)?.refresh_token : undefined;
      } catch {
        stored = undefined;
      }
      if (stored !== onlyIfRefreshToken) return;
    }
    await remove(STORAGE_KEY);
    // As auth-js's own sign-out does: the PKCE verifier of an OAuth flow
    // that never completed goes too.
    await remove(`${STORAGE_KEY}-code-verifier`);
  } catch {
    /* nothing stored, or storage unavailable */
  }
}

/** The stored session's refresh token, or undefined. Read without asking
 *  anyone, like readStoredSession. */
export async function storedRefreshToken(): Promise<string | undefined> {
  try {
    const raw = Capacitor.isNativePlatform() ? await capacitorStorage.getItem(STORAGE_KEY) : localStorage.getItem(STORAGE_KEY);
    const token = raw ? JSON.parse(raw)?.refresh_token : undefined;
    return typeof token === 'string' ? token : undefined;
  } catch {
    return undefined;
  }
}

// ── Mobile session durability (v1.10) ───────────────────────────────────
// Ported from NCC's supabase.ts, which got this in v1.7; this app never did.
// supabase-js drives its token auto-refresh loop off browser visibility /
// `online` events. In a Capacitor Android WebView those fire unreliably once
// the app is paused, so a backgrounded app can sail past the access-token
// expiry without refreshing. Driving the loop off the native app lifecycle
// instead is Supabase's documented mobile fix: stop on background, (re)start
// on foreground. startAutoRefresh() also runs an immediate tick, so a token
// that expired while backgrounded is refreshed the moment the app returns.
if (Capacitor.isNativePlatform()) {
  void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
    if (isActive) {
      void supabase.auth.startAutoRefresh();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  });
}

export const isNexusConfigured = Boolean(url && anonKey);
