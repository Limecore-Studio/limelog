import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.22 (limecore#91) — health-data consent: asked once per owner, stored
// with its time; a yes queues what was kept back, a withdrawal queues the
// server erase and stops the rest.

const q = vi.hoisted(() => ({ items: [] as { kind: string; payload: unknown }[], sync: true, owner: 'u1' as string | null }));
vi.mock('./outbox', () => ({
  enqueue: (kind: string, payload: unknown) => q.items.push({ kind, payload }),
  cancel: (kind: string) => {
    const before = q.items.length;
    q.items = q.items.filter((i) => i.kind !== kind);
    return before - q.items.length;
  },
}));
const cloud = vi.hoisted(() => ({ writes: [] as [boolean, string][] }));
vi.mock('./healthConsentCloud', () => ({ writeHealthConsentToCloud: async (g: boolean, at: string) => void cloud.writes.push([g, at]) }));
vi.mock('./syncSetting', () => ({ syncAllowed: () => q.sync }));
vi.mock('./accountOwner', () => ({ readOwner: () => q.owner }));
vi.mock('@/store/bodyMetricsStore', () => ({
  useBodyMetricsStore: { getState: () => ({ metrics: [
    { id: 'm1', date: '2026-11-01', weightKg: 80, bodyFatPct: 18 },
    { id: 'm2', date: '2026-11-02', weightKg: 80 },
  ] }) },
}));
vi.mock('@/store/logStore', () => ({
  useLogStore: { getState: () => ({ sessionLogs: [
    { id: 's1', finalizedAt: 'x', aiDebriefRaw: 'knee sore', aiPainFlags: ['knee'], aiNoteSummary: 'Knee sore.' },
    { id: 's2', finalizedAt: 'x' },
  ] }) },
}));

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}
vi.stubGlobal('localStorage', storage());

const hc = await import('./healthConsent');
const actions = await import('./healthConsentActions');

beforeEach(() => {
  localStorage.clear();
  q.items = [];
  cloud.writes = [];
  q.sync = true;
  q.owner = 'u1';
});

describe('health consent', () => {
  it('starts unasked, and only a yes allows', () => {
    expect(hc.healthConsent()).toBe('unasked');
    expect(hc.healthAllowed()).toBe(false);
    hc.setHealthConsent(false, 'u1', new Date('2026-11-27T10:00:00Z'));
    expect(hc.healthConsent()).toBe('refused');
    expect(hc.readHealthConsent()).toEqual({ granted: false, at: '2026-11-27T10:00:00.000Z' });
  });

  it('belongs to the owner: another account is asked for itself', () => {
    hc.setHealthConsent(true, 'u1');
    expect(hc.healthConsent('u2')).toBe('unasked');
    expect(hc.healthConsent('guest')).toBe('unasked');
  });

  // S24 pass: a guest's "Keep on this device" must never stand in for the
  // account's answer, including while the guest-data question is still open
  // (signed in, but no owner recorded yet).
  it("a guest's answer is not the account's", () => {
    q.owner = null;
    hc.setHealthConsent(false); // as a guest
    expect(hc.healthConsent('guest')).toBe('refused');
    expect(hc.healthQuestionOpen(null)).toBe(false); // the guest answered
    expect(hc.healthQuestionOpen('u1')).toBe(false); // signed in, not taken up: wait
    q.owner = 'u1'; // taken up
    expect(hc.healthConsent()).toBe('unasked');
    expect(hc.healthQuestionOpen('u1')).toBe(true); // the account is asked
  });

  it('a yes queues the kept-back readings and debriefs', () => {
    actions.grantHealthConsent();
    expect(hc.healthAllowed()).toBe(true);
    expect(q.items.map((i) => i.kind)).toEqual(['upsert_body_metric', 'upsert_session_debrief']);
    expect(q.items[1].payload).toEqual({ sessionId: 's1', aiDebriefRaw: 'knee sore', aiPainFlags: ['knee'], aiNoteSummary: 'Knee sore.' });
  });

  it('a yes with sync off records it and queues nothing', () => {
    q.sync = false;
    actions.grantHealthConsent();
    expect(hc.healthAllowed()).toBe(true);
    expect(q.items).toEqual([]);
  });

  it('withdrawing stops queued debriefs and queues the server erase', () => {
    actions.grantHealthConsent();
    actions.withdrawHealthConsent();
    expect(hc.healthConsent()).toBe('refused');
    expect(q.items.map((i) => i.kind)).toEqual(['upsert_body_metric', 'clear_health_data']);
    // limecore#135: both recorded on the account, the yes and the withdrawal.
    expect(cloud.writes.map(([g]) => g)).toEqual([true, false]);
  });

  it('a guest withdrawing has nothing on the server to erase', () => {
    q.owner = null;
    actions.withdrawHealthConsent();
    expect(q.items).toEqual([]);
  });
});
