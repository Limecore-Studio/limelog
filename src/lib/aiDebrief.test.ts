import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.22 (limecore#122) — the debrief on the user's own key: no Supabase, no
// account; off means nothing is sent; a failure says why.

const gen = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('./aiProvider', () => ({ generate: gen.fn }));
const profile = vi.hoisted(() => ({ aiEnabled: true }));
vi.mock('@/store/userStore', () => ({ useUserStore: { getState: () => ({ profile }) } }));

const { analyseDebrief, parseDebrief } = await import('./aiDebrief');

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
    expect(gen.fn.mock.calls[0][0]).toMatchObject({ json: true, maxTokens: 1024 });
  });

  it('passes the reason on', async () => {
    gen.fn.mockResolvedValue({ ok: false, error: 'no-key' });
    expect(await analyseDebrief('x')).toEqual({ error: 'no-key' });
    gen.fn.mockResolvedValue({ ok: true, text: 'not json' });
    expect(await analyseDebrief('x')).toEqual({ error: 'other' });
  });
});

// limecore#122 device pass: with a real key the owner's debrief showed no
// pain or mood chips. These are the shapes Gemini 3.x actually returns.
describe('parseDebrief with realistic model output', () => {
  const want = { rpe: 8, painFlags: ['left knee'], mood: 'good', noteSummary: 'Hard squats, knee sore.' };

  it('plain JSON', () => {
    expect(parseDebrief('{"rpe":8,"painFlags":["left knee"],"mood":"good","noteSummary":"Hard squats, knee sore."}')).toEqual(want);
  });

  it('```json fences and a sentence around them', () => {
    expect(parseDebrief('Here is the data:\n```json\n{\n  "rpe": 8,\n  "painFlags": ["left knee"],\n  "mood": "good",\n  "noteSummary": "Hard squats, knee sore."\n}\n```')).toEqual(want);
  });

  it('snake_case keys, a capitalised mood and RPE as a string', () => {
    expect(parseDebrief('{"rpe":"8/10","pain_flags":["left knee"],"Mood":"Good","note_summary":"Hard squats, knee sore."}')).toEqual(want);
  });

  it('pain as one string, mood as a synonym', () => {
    expect(parseDebrief('{"rpe":7,"pain":"left knee, lower back","mood":"okay","summary":"x"}')).toEqual({
      rpe: 7, painFlags: ['left knee', 'lower back'], mood: 'neutral', noteSummary: 'x',
    });
  });

  it('pain as objects, the object inside an array, and "none" dropped', () => {
    expect(parseDebrief('[{"rpe":6,"painFlags":[{"bodyPart":"shoulder"},"none"],"mood":"tired"}]')).toEqual({
      rpe: 6, painFlags: ['shoulder'], mood: 'bad', noteSummary: '',
    });
  });

  it('the fields wrapped in an object of the model own (the S24 "Saved" chip)', () => {
    expect(parseDebrief('{"workoutQuality":{"rpe":8,"painFlags":["knee"],"mood":"good","noteSummary":"Heavy legs, knee twinge on squats."}}')).toEqual({
      rpe: 8, painFlags: ['knee'], mood: 'good', noteSummary: 'Heavy legs, knee twinge on squats.',
    });
  });

  it('a cut-off answer is a failure, not empty chips', () => {
    expect(parseDebrief('{"rpe":8,"painFlags":["left kn')).toBeNull();
  });
});

// The owner's example note, end to end through analyseDebrief: chips come back.
describe('analyseDebrief with the S24 example note', () => {
  it('"legs felt heavy, knee twinged on squats, RPE 8, good mood" yields RPE, pain and mood', async () => {
    gen.fn.mockResolvedValue({ ok: true, text: '{"rpe":8,"painFlags":["knee"],"mood":"good","noteSummary":"Heavy legs; knee twinged on squats."}' });
    const out = await analyseDebrief('legs felt heavy, knee twinged on squats, RPE 8, good mood');
    expect(out).toEqual({ result: { rpe: 8, painFlags: ['knee'], mood: 'good', noteSummary: 'Heavy legs; knee twinged on squats.' } });
    // The request carries the schema, so the model answers in this shape.
    const req = gen.fn.mock.calls[0][0];
    expect(req.schema.required).toEqual(['rpe', 'painFlags', 'mood', 'noteSummary']);
  });
});
