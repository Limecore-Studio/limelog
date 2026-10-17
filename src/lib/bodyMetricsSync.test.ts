import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.18.1 (LimeLog#76) — two devices that log the same day hold that day's
// row under different local ids. The push upserted on (user_id, date) while
// sending `id`, so the second device rewrote the row's primary key and nulled
// every field it had not set, and the first device's delete by id then
// matched nothing. A stand-in for the table: unique (user_id, date), no
// default for `id`, and PostgREST's update / upsert / delete semantics.

type Row = Record<string, unknown>;
const USER = 'user-1';

const db = vi.hoisted(() => ({ rows: [] as Row[] }));

function table(name: string) {
  const filters: [string, unknown][] = [];
  const match = (r: Row) => filters.every(([c, v]) => r[c] === v);
  let op: { kind: 'update' | 'delete'; fields?: Row } | null = null;
  const run = () => {
    if (op?.kind === 'update') {
      // zz_skip_noop_update: a row the update would not change (updated_at
      // aside) is not written and not returned.
      const changes = (r: Row) => Object.entries(op!.fields!).some(([c, v]) => c !== 'updated_at' && r[c] !== v);
      const hit = db.rows.filter((r) => match(r) && changes(r));
      hit.forEach((r) => Object.assign(r, op!.fields));
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    }
    if (op?.kind === 'delete') {
      db.rows = db.rows.filter((r) => !match(r));
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };
  const builder = {
    eq(c: string, v: unknown) {
      filters.push([c, v]);
      return builder;
    },
    select() {
      return Promise.resolve(run());
    },
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      return Promise.resolve(run()).then(res, rej);
    },
  };
  return {
    update(fields: Row) {
      op = { kind: 'update', fields };
      return builder;
    },
    delete() {
      op = { kind: 'delete' };
      return builder;
    },
    async upsert(row: Row, opts: { onConflict: string; ignoreDuplicates?: boolean }) {
      if (name !== 'body_metrics') throw new Error('unexpected table');
      if (!row.id) return { error: { message: 'null value in column "id" violates not-null constraint' } };
      const existing = db.rows.find((r) => r.user_id === row.user_id && r.date === row.date);
      if (existing && opts.ignoreDuplicates) return { error: null };
      if (existing) Object.assign(existing, row);
      else db.rows.push({ ...row });
      return { error: null };
    },
  };
}

vi.mock('./supabase', () => ({
  isNexusConfigured: true,
  supabase: {
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    from: (name: string) => table(name),
  },
}));

const { pushBodyMetricToNexus, deleteBodyMetricFromNexus } = await import('./nexusSync');

beforeEach(() => {
  db.rows = [];
});

describe('body metrics from two devices on the same day (LimeLog#76)', () => {
  it('keeps the first id and each device\'s fields', async () => {
    await pushBodyMetricToNexus({ id: 'phone', date: '2026-10-13', weightKg: 80 }, USER);
    await pushBodyMetricToNexus({ id: 'tablet', date: '2026-10-13', waistCm: 90 }, USER);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ id: 'phone', weight_kg: 80, waist_cm: 90 });
  });

  it('a push that changes nothing (the no-op guard: 0 rows) leaves the row and its id alone', async () => {
    await pushBodyMetricToNexus({ id: 'phone', date: '2026-10-13', weightKg: 80 }, USER);
    await pushBodyMetricToNexus({ id: 'tablet', date: '2026-10-13', weightKg: 80 }, USER);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ id: 'phone', weight_kg: 80 });
  });

  it('a delete from the other device removes the day\'s row', async () => {
    await pushBodyMetricToNexus({ id: 'phone', date: '2026-10-13', weightKg: 80 }, USER);
    await deleteBodyMetricFromNexus('tablet', '2026-10-13', USER);
    expect(db.rows).toEqual([]);
  });

  it('a delete queued by an older build, with no date, still goes by id', async () => {
    await pushBodyMetricToNexus({ id: 'phone', date: '2026-10-13', weightKg: 80 }, USER);
    await deleteBodyMetricFromNexus('phone', undefined, USER);
    expect(db.rows).toEqual([]);
  });
});
