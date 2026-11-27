import { describe, it, expect, vi } from 'vitest';

// v1.22 (limecore#88) — "Export my data" covers what the account holds across
// the suite, plus a listing of uploaded files; the same list NCC uses.
const h = vi.hoisted(() => ({ reads: [] as { table: string; filters: unknown[]; ranged: boolean }[], fail: new Set<string>() }));

vi.mock('./supabase', () => {
  function from(table: string) {
    const req = { table, filters: [] as unknown[], ranged: false };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => (req.filters.push([c, v]), b),
      order: () => b,
      gt: () => b,
      limit: () => b,
      range: () => ((req.ranged = true), b),
      then: (r: (v: unknown) => unknown) => {
        h.reads.push(req);
        const out = h.fail.has(table) ? { data: null, error: { message: 'permission denied' } } : { data: [{ table }], error: null };
        return Promise.resolve(out).then(r);
      },
    };
    return b;
  }
  return {
    isNexusConfigured: true,
    supabase: {
      from,
      storage: {
        from: () => ({
          list: async (prefix: string) =>
            prefix === 'u1'
              ? { data: [{ name: 'a.png', id: 'x', created_at: '2026-01-01', metadata: { size: 10, mimetype: 'image/png' } }, { name: 'sub', id: null }], error: null }
              : { data: [{ name: 'b.pdf', id: 'y', created_at: null, metadata: { size: 5 } }], error: null },
        }),
      },
    },
  };
});
vi.mock('./selectAll', () => ({
  PAGE_SIZE: 1000,
  selectAll: async (client: { from: (t: string) => { then: unknown } }, table: string, o: { filter?: (q: unknown) => unknown }) => {
    const q = client.from(table) as unknown as { eq: (c: string, v: unknown) => unknown };
    const built = (o.filter ? o.filter(q) : q) as PromiseLike<{ data: unknown; error: unknown }>;
    return await built;
  },
}));

const { serverOnlyData, serverFiles, SERVER_TABLES } = await import('./dataRights');

describe('serverOnlyData', () => {
  it('covers every app and the account tables, each read for this user only', async () => {
    h.reads = [];
    const out = await serverOnlyData('u1');
    for (const t of ['body_metrics', 'workout_sets', 'exercise_prs', 'notebook_entries', 'transactions', 'profiles', 'app_opens', 'user_preferences']) {
      expect(out[t], t).toEqual([{ table: t }]);
    }
    expect(Object.keys(out)).toHaveLength(SERVER_TABLES.length);
    const filterOf = (t: string) => h.reads.find((r) => r.table === t)!.filters;
    expect(filterOf('body_metrics')).toEqual([['user_id', 'u1']]);
    expect(filterOf('profiles')).toEqual([['id', 'u1']]);
    expect(filterOf('audit_log')).toEqual([]); // RLS alone
    expect(h.reads.find((r) => r.table === 'app_opens')!.ranged).toBe(true);
  });

  it('a table that cannot be read is recorded, not dropped', async () => {
    h.fail = new Set(['kofi_alt_emails']);
    const out = await serverOnlyData('u1');
    expect(out.kofi_alt_emails).toEqual({ error: 'permission denied' });
    h.fail = new Set();
  });
});

describe('serverFiles', () => {
  it('lists uploads under the user folder, recursively', async () => {
    const out = await serverFiles('u1');
    expect(out.avatars).toEqual([
      { path: 'u1/a.png', size: 10, createdAt: '2026-01-01', contentType: 'image/png' },
      { path: 'u1/sub/b.pdf', size: 5, createdAt: null, contentType: null },
    ]);
  });
});
