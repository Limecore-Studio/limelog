import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// v1.21.1 (limecore#103, limecore#114) — the export file never carries a
// credential. LimeLog's export is a hand list of training data, so it is clean
// today; this test keeps it that way. It fills every store a credential could
// sit in (the auth session, an SSO bundle, a PIN, the outbox) with values that
// are easy to recognise, builds the export as a signed-in user, and fails if
// any of them, or anything shaped like a token, session or PIN, comes out.

const SECRETS = {
  access: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl',
  refresh: 'rt-SECRET-refresh-7f3a9c',
  pin: '493817',
  apikey: 'sk-live-SECRET-key-01',
};

vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false }, registerPlugin: () => ({}) }));
vi.mock('./selectAll', () => ({
  // Server-only rows as the user may read them.
  selectAll: async (_c: unknown, table: string) => ({
    data: table === 'feedback' ? [{ id: 'f1', app: 'limelog', message: 'nice app' }] : [{ id: 'e1', message: 'TypeError' }],
    error: null,
  }),
}));
vi.mock('./supabase', () => ({ isNexusConfigured: true, supabase: {} }));

import { buildExport } from './dataRights';

function storage(items: Record<string, string>) {
  const m = new Map(Object.entries(items));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const session = JSON.stringify({ access_token: SECRETS.access, refresh_token: SECRETS.refresh, user: { id: 'user-1' } });

beforeEach(() => {
  vi.stubGlobal('localStorage', storage({
    // Training data, so the export is not trivially empty.
    wt_session_logs: JSON.stringify([{ id: 's1', date: '2026-11-01', sets: [{ weight: 100, reps: 5 }] }]),
    wt_profile: JSON.stringify({ name: 'Lee', activeRestrictions: [] }),
    // Everything a credential could be in.
    wt_nexus_auth: session,
    'wt_nexus_auth-code-verifier': 'pkce-verifier-SECRET',
    'sb-hkktorzhaqnfqsnlstda-auth-token': session,
    nexus_sso_bundle: session,
    'auth.pin': SECRETS.pin,
    'limelog-outbox': JSON.stringify([{ op: 'push', token: SECRETS.access }]),
    apikey_gemini: SECRETS.apikey,
  }));
});
afterEach(() => vi.unstubAllGlobals());

/** Every key and every string value in the export, depth first. */
function walk(v: unknown, path: string, out: Array<[string, string]>) {
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push([`${path}.${k}`, k]);
      walk(x, `${path}.${k}`, out);
    }
  } else if (typeof v === 'string') out.push([path, v]);
}

// Key names that would hold a credential. Not "session" on its own: the
// training data is made of sessions (sessionLogs), which is the point of it.
const BAD_KEY = /(^|[_\-.])(access|refresh|id|auth)[_-]?token|^token$|auth[_-]?session|^session$|code[_-]?verifier|(^|[_\-.])pin($|[_\-.])|pin[_-]?hash|password|secret|api[_-]?key|^apikey/i;
// Values shaped like one: a JWT, or a stored Supabase session.
const BAD_VALUE = /eyJ[\w-]{8,}\.[\w-]{8,}\.|"refresh_token"|"access_token"|sb-[a-z0-9]+-auth-token/;

describe('export contents (limecore#103/#114)', () => {
  it('carries no token, session or PIN, signed in', async () => {
    const payload = await buildExport({ id: 'user-1', email: 'lee@example.com' });
    const json = JSON.stringify(payload);
    // The training data did make it in.
    expect(json).toContain('2026-11-01');
    for (const s of [...Object.values(SECRETS), 'pkce-verifier-SECRET']) expect(json).not.toContain(s);
    const entries: Array<[string, string]> = [];
    walk(payload, '$', entries);
    const bad = entries.filter(([, x]) => BAD_KEY.test(x) || BAD_VALUE.test(x)).map(([p]) => p);
    expect(bad).toEqual([]);
  });

  it('carries none as a guest either', async () => {
    const json = JSON.stringify(await buildExport(null));
    for (const s of Object.values(SECRETS)) expect(json).not.toContain(s);
    expect(BAD_VALUE.test(json)).toBe(false);
  });
});
