import { useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import './DebriefSection.css';
import { useLogStore } from '@/store/logStore';
import { analyseDebrief, type DebriefResult } from '@/lib/aiDebrief';
import type { AiError } from '@/lib/aiProvider';
import '@/i18n/aiStrings'; // ai.* (loaded on demand)
import type { SessionMood } from '@/types/logging';
import { healthConsent, requestHealthAsk, subscribeHealthConsent } from '@/lib/healthConsent';
import '@/i18n/healthStrings'; // healthConsent.* (loaded on demand)

// v1.4 — optional post-workout AI debrief. Sits in the finish block beside the
// FatigueRating dots (which stay as the always-available fallback). The user
// types a free-text note; "Analyse" sends it to Gemini, which returns
// structured RPE / pain flags / mood. Stored on the session and pushed to Nexus.
// v1.22 (limecore#122): on the user's own key, from the device, so it no
// longer needs sync; a failure says why, when the user can fix it.

const MOOD_EMOJI: Record<SessionMood, string> = {
  great: '😄',
  good: '🙂',
  neutral: '😐',
  bad: '😕',
  terrible: '😣',
};

export function DebriefSection({ logId }: { logId: string }) {
  const { t } = useTranslation();
  const setSessionDebrief = useLogStore((s) => s.setSessionDebrief);

  const [text, setText] = useState('');
  const [analysing, setAnalysing] = useState(false);
  const [result, setResult] = useState<DebriefResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [aiError, setAiError] = useState<AiError | null>(null);

  // v1.22 (limecore#91) — the note can carry pain, which is health data: it
  // goes to AI only with the health-data consent. Unasked, Analyse asks.
  const consent = useSyncExternalStore(subscribeHealthConsent, () => healthConsent());

  async function analyse() {
    const trimmed = text.trim();
    if (!trimmed || analysing) return;
    if (consent !== 'granted') {
      if (consent === 'unasked') requestHealthAsk();
      return;
    }
    setAnalysing(true);
    setFailed(false);
    setAiError(null);
    const out = await analyseDebrief(trimmed);
    const res = out && 'result' in out ? out.result : null;
    if (out && 'error' in out) setAiError(out.error);
    if (res) {
      setResult(res);
      setSessionDebrief(logId, {
        raw: trimmed,
        rpe: res.rpe,
        painFlags: res.painFlags,
        mood: res.mood,
        noteSummary: res.noteSummary,
      });
    } else {
      // Save the raw note even when extraction fails — nothing is lost.
      setFailed(true);
      setSessionDebrief(logId, {
        raw: trimmed,
        rpe: null,
        painFlags: [],
        mood: null,
        noteSummary: '',
      });
    }
    setAnalysing(false);
  }

  return (
    <div className="debrief">
      <span className="debrief__label">
        {t('debrief.title')} <span className="debrief__ai">AI</span>
      </span>
      <textarea
        className="debrief__input"
        placeholder={t('debrief.placeholder')}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (result || failed) {
            // Editing after an analysis invalidates the previous result.
            setResult(null);
            setFailed(false);
            setAiError(null);
          }
        }}
        rows={2}
        maxLength={1000}
      />

      {!result && (
        <button
          className="debrief__analyse"
          onClick={analyse}
          disabled={!text.trim() || analysing}
        >
          {analysing ? 'Analysing…' : '✦ Analyse'}
        </button>
      )}

      {result && (
        <div className="debrief__result">
          {result.rpe != null && <span className="debrief__chip debrief__chip--rpe">RPE {result.rpe}</span>}
          {result.mood && (
            <span className="debrief__chip debrief__chip--mood">
              {MOOD_EMOJI[result.mood]} {result.mood}
            </span>
          )}
          {result.painFlags.map((p) => (
            <span key={p} className="debrief__chip debrief__chip--pain">⚠ {p}</span>
          ))}
          {result.rpe == null && !result.mood && result.painFlags.length === 0 && (
            <span className="debrief__chip">{t('debrief.saved')}</span>
          )}
        </div>
      )}

      {result?.noteSummary && <div className="debrief__summary">{result.noteSummary}</div>}

      {consent !== 'granted' && !result && (
        <div className="debrief__failed" role="status">
          {consent === 'unasked' ? t('healthConsent.debriefNeeds') : t('healthConsent.debriefRefused')}
        </div>
      )}

      {failed && (
        <div className="debrief__failed" role="status">
          {aiError && aiError !== 'other' ? `${t(`ai.err.${aiError}`)} ` : ''}
          {t('debrief.failed')}
        </div>
      )}
    </div>
  );
}
