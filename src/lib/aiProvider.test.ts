import { describe, it, expect, beforeEach, vi } from 'vitest';

const prefs = vi.hoisted(() => new Map<string, string>());
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: prefs.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void prefs.set(key, value),
    remove: async ({ key }: { key: string }) => void prefs.delete(key),
  },
}));

const { classifyAiError, generate, generationConfig, setAiKey, clearAiKey, AI_HOST, DEFAULT_AI_MODEL } = await import('./aiProvider');

// v1.22 (limecore#122) — AI on the user's own key, straight to Google.

type Call = { url: string; init: RequestInit };
function fakeFetch(status: number, body: unknown, calls: Call[] = []) {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  await clearAiKey();
});

describe('generate', () => {
  it('no key, no request', async () => {
    const calls: Call[] = [];
    expect(await generate({ prompt: 'x', maxTokens: 5, temperature: 0, fetchImpl: fakeFetch(200, {}, calls) })).toEqual({ ok: false, error: 'no-key' });
    expect(calls).toEqual([]);
  });

  it('calls Gemini directly with the key in the header, never in the URL', async () => {
    await setAiKey('test-key-123');
    const calls: Call[] = [];
    const res = await generate({
      prompt: 'hello', maxTokens: 50, temperature: 0.5, model: 'gemini-2.5-flash',
      fetchImpl: fakeFetch(200, { candidates: [{ content: { parts: [{ text: ' Hi ' }] } }] }, calls),
    });
    expect(res).toEqual({ ok: true, text: 'Hi' });
    expect(calls[0].url).toBe(`${AI_HOST}/v1beta/models/gemini-2.5-flash:generateContent`);
    expect(calls[0].url).not.toContain('test-key-123');
    expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key-123');
  });

  it('says why it failed', async () => {
    await setAiKey('k');
    const fail = (status: number, message: string) =>
      generate({ prompt: 'x', maxTokens: 5, temperature: 0, fetchImpl: fakeFetch(status, { error: { message } }) });
    expect(await fail(400, 'API key not valid. Please pass a valid API key.')).toEqual({ ok: false, error: 'invalid-key' });
    expect(await fail(429, 'Resource has been exhausted (e.g. check quota).')).toEqual({ ok: false, error: 'quota' });
    expect(await fail(404, 'models/old is not found')).toEqual({ ok: false, error: 'model' });
    const offline = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    expect(await generate({ prompt: 'x', maxTokens: 5, temperature: 0, fetchImpl: offline })).toEqual({ ok: false, error: 'network' });
  });
});

describe('generationConfig', () => {
  // limecore#60: the settings ai-generate used, now sent from the device.
  it('3.x: minimal thinking, no temperature; 2.x: the old settings', () => {
    expect(generationConfig('gemini-3.5-flash-lite', 256, 0.2, true)).toEqual({
      maxOutputTokens: 256, thinkingConfig: { thinkingLevel: 'MINIMAL' }, responseMimeType: 'application/json',
    });
    expect(generationConfig('gemini-2.5-flash', 200, 0.6, false)).toEqual({
      temperature: 0.6, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 },
    });
  });

  it('a schema is sent with JSON only', () => {
    const schema = { type: 'OBJECT' };
    expect(generationConfig('gemini-3.5-flash-lite', 1024, 0.2, true, schema).responseSchema).toBe(schema);
    expect(generationConfig('gemini-3.5-flash-lite', 1024, 0.2, false, schema).responseSchema).toBeUndefined();
  });

  it('the default is a model new keys can use (not 2.5)', () => {
    expect(DEFAULT_AI_MODEL).not.toMatch(/^gemini-2\./);
  });

  it('JSON is asked for in the request, and thought parts are left out', async () => {
    await setAiKey('k');
    const calls: Call[] = [];
    const res = await generate({
      prompt: 'x', maxTokens: 50, temperature: 0, json: true, model: 'gemini-3.5-flash-lite',
      fetchImpl: fakeFetch(200, { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: '{}' }] } }] }, calls),
    });
    expect(res).toEqual({ ok: true, text: '{}' });
    expect(JSON.parse(calls[0].init.body as string).generationConfig.responseMimeType).toBe('application/json');
  });
});

describe('classifyAiError', () => {
  it('maps statuses and messages', () => {
    expect(classifyAiError(403, '')).toBe('invalid-key');
    expect(classifyAiError(500, 'internal')).toBe('other');
  });
});
