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
  const res = await generate({ prompt: buildPrompt(text), json: true, maxTokens: 256, temperature: 0.2 });
  if (!res.ok) return { error: res.error };
  const result = parseDebrief(res.text);
  return result ? { result } : { error: 'other' };
}

function parseDebrief(raw: string): DebriefResult | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    // Defensive: pull the first {...} block if the model wrapped it in fences.
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  const rpe =
    typeof o.rpe === 'number' && o.rpe >= 1 && o.rpe <= 10 ? Math.round(o.rpe) : null;
  const painFlags = Array.isArray(o.painFlags)
    ? o.painFlags.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 8)
    : [];
  const mood = MOODS.includes(o.mood as SessionMood) ? (o.mood as SessionMood) : null;
  const noteSummary = typeof o.noteSummary === 'string' ? o.noteSummary.slice(0, 200) : '';

  return { rpe, painFlags, mood, noteSummary };
}
