import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.22 (limecore#122) — the debrief on the user's own key: no Supabase, no
// account; off means nothing is sent; a failure says why.

const gen = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('./aiProvider', () => ({ generate: gen.fn }));
const profile = vi.hoisted(() => ({ aiEnabled: true }));
vi.mock('@/store/userStore', () => ({ useUserStore: { getState: () => ({ profile }) } }));

const { analyseDebrief } = await import('./aiDebrief');

beforeEach(() => {
  gen.fn.mockReset();
  profile.aiEnabled = true;
});

describe('analyseDebrief', () => {
  it('off: nothing is sent', async () => {
    profile.aiEnabled = false;
    expect(await analyseDebrief('knee hurt')).toBeNull();
    expect(gen.fn).not.toHaveBeenCalled();
  });

  it('asks for JSON and parses the answer', async () => {
    gen.fn.mockResolvedValue({ ok: true, text: '{"rpe":8,"painFlags":["knee"],"mood":"good","noteSummary":"Hard, knee sore."}' });
    expect(await analyseDebrief('hard session, knee sore')).toEqual({
      result: { rpe: 8, painFlags: ['knee'], mood: 'good', noteSummary: 'Hard, knee sore.' },
    });
    expect(gen.fn.mock.calls[0][0]).toMatchObject({ json: true, maxTokens: 256 });
  });

  it('passes the reason on', async () => {
    gen.fn.mockResolvedValue({ ok: false, error: 'no-key' });
    expect(await analyseDebrief('x')).toEqual({ error: 'no-key' });
    gen.fn.mockResolvedValue({ ok: true, text: 'not json' });
    expect(await analyseDebrief('x')).toEqual({ error: 'other' });
  });
});
