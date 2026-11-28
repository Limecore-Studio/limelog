// Post-workout AI debrief — v1.4.
//
// Takes a free-text note the user types after a session and extracts structured
// quality data (RPE, pain flags, mood, a clean summary) with Gemini.
// v1.22 (limecore#122): on the user's own key, straight from the device
// (aiProvider.ts). It used to go through the `ai-generate` function on
// Limecore's key, which also meant the pain notes passed through Limecore to a
// free tier (limecore#91). No account is needed any more, so guests have it
// too. A failure says why (no key, invalid key, quota, model, network); the
// FatigueRating dots remain the always-available fallback.

import { generate, type AiError } from './aiProvider';
import { useUserStore } from '@/store/userStore';
import type { SessionMood } from '@/types/logging';

export interface DebriefResult {
  rpe: number | null; // 1–10
  painFlags: string[]; // body parts with pain/discomfort
  mood: SessionMood | null;
  noteSummary: string; // clean 1-sentence rephrasing
}

const MOODS: SessionMood[] = ['great', 'good', 'neutral', 'bad', 'terrible'];

function buildPrompt(userText: string): string {
  return `Extract workout-quality data from this post-workout note. Return ONLY valid JSON matching this exact schema — no prose, no markdown fences:
{
  "rpe": <number 1-10, or null if not inferable>,
  "painFlags": <string[] of body parts mentioned with pain or discomfort; empty array if none>,
  "mood": <"great" | "good" | "neutral" | "bad" | "terrible" | null>,
  "noteSummary": <string: clean one-sentence rephrasing of the note, max 80 chars>
}

Note: "${userText.slice(0, 400).replace(/"/g, "'")}"`;
}

export type DebriefOutcome = { result: DebriefResult } | { error: AiError };

/** Analyse a free-text debrief note. Returns the structured fields, or why it
 *  failed; null when AI is off or the note is empty (nothing was sent). */
export async function analyseDebrief(userText: string): Promise<DebriefOutcome | null> {
  // The opt-in gate, checked here as well as at the call site: this is the one
  // place the note leaves the device, so a future caller cannot skip the
  // user's choice by forgetting to check the flag.
  if (!useUserStore.getState().profile.aiEnabled) return null;
  const text = userText.trim();
  if (!text) return null;
  // 1024, not 256 (limecore#122 device pass): on 3.x models even the
  // minimal thinking level counts against maxOutputTokens, so a small cap can
  // end the answer mid-JSON. The answer itself is well under 200 tokens.
  const res = await generate({ prompt: buildPrompt(text), json: true, maxTokens: 1024, temperature: 0.2 });
  if (!res.ok) return { error: res.error };
  const result = parseDebrief(res.text);
  return result ? { result } : { error: 'other' };
}

/** v1.22 (limecore#122 device pass) — tolerant of what the model really
 *  sends: ```json fences or prose around the object, an array holding it,
 *  snake_case or other spellings of the keys, a number as a string ("7" or
 *  "7/10"), a capitalised mood ("Good", "okay"), and pain as one string
 *  ("knee, lower back") or as objects ({ "bodyPart": "knee" }). Exported for
 *  the tests. */
export function parseDebrief(raw: string): DebriefResult | null {
  let obj: unknown = tryJson(raw.trim());
  if (obj === undefined) {
    // Fences or prose around it: the outermost {...}.
    const m = raw.match(/\{[\s\S]*\}/);
    obj = m ? tryJson(m[0]) : undefined;
  }
  if (Array.isArray(obj)) obj = obj[0];
  if (!obj || typeof obj !== 'object') return null;
  const o = normaliseKeys(obj as Record<string, unknown>);

  const rpeNum = typeof o.rpe === 'number' ? o.rpe : typeof o.rpe === 'string' ? parseFloat(o.rpe) : NaN;
  const rpe = Number.isFinite(rpeNum) && rpeNum >= 1 && rpeNum <= 10 ? Math.round(rpeNum) : null;

  const rawPain = o.painflags ?? o.pain ?? o.painpoints ?? o.painareas ?? o.bodyparts;
  const painList: unknown[] = Array.isArray(rawPain)
    ? rawPain
    : typeof rawPain === 'string'
      ? rawPain.split(/[,;]| and /i)
      : [];
  const painFlags = painList
    .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? Object.values(x as Record<string, unknown>).find((v) => typeof v === 'string') : undefined))
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && !/^(none|null|n\/a|no)$/i.test(x))
    .slice(0, 8);

  const moodRaw = typeof o.mood === 'string' ? o.mood.trim().toLowerCase() : '';
  const mood = (MOODS.includes(moodRaw as SessionMood) ? moodRaw : MOOD_SYNONYMS[moodRaw] ?? null) as SessionMood | null;

  const summaryRaw = o.notesummary ?? o.summary;
  const noteSummary = typeof summaryRaw === 'string' ? summaryRaw.slice(0, 200) : '';

  return { rpe, painFlags, mood, noteSummary };
}

const MOOD_SYNONYMS: Record<string, SessionMood> = {
  excellent: 'great', amazing: 'great', positive: 'good', fine: 'good',
  ok: 'neutral', okay: 'neutral', average: 'neutral', mixed: 'neutral',
  tired: 'bad', poor: 'bad', negative: 'bad', awful: 'terrible', horrible: 'terrible',
};

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Keys lower-cased with separators dropped: painFlags, pain_flags and
 *  "Pain Flags" all read as painflags. */
function normaliseKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase().replace(/[^a-z]/g, ''), v]));
}
