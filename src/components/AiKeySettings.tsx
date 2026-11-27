// v1.22 (limecore#122, Design H) — AI on the user's own Gemini key.
//
// The key (masked once saved, with clear), the model name, a Test that makes
// one tiny request, and what happens to the data. The on/off switch sits
// below and stays locked off until a key is saved: no key, no AI request.
// Same parts and wording as NCC's AI section.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '@/store/userStore';
import {
  clearAiKey,
  DEFAULT_AI_MODEL,
  generate,
  getAiKey,
  getAiModel,
  setAiKey,
  setAiModel,
  type AiError,
} from '@/lib/aiProvider';
import '@/i18n/aiStrings'; // ai.* (loaded on demand)

/** The last four characters only. */
function maskKey(key: string): string {
  return key.length <= 4 ? '••••' : `••••${key.slice(-4)}`;
}

export function AiKeySettings() {
  const { t } = useTranslation();
  const aiEnabled = !!useUserStore((s) => s.profile.aiEnabled);
  const setAiEnabled = useUserStore((s) => s.setAiEnabled);
  // undefined while the stored key is being read.
  const [key, setKey] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState(DEFAULT_AI_MODEL);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<'ok' | AiError | null>(null);

  useEffect(() => {
    void getAiKey().then((k) => setKey(k ?? ''));
    void getAiModel().then(setModel);
  }, []);

  // No key means AI is off, whatever was switched on before (a profile from
  // before v1.22, or one set aside for an account whose key was cleared).
  useEffect(() => {
    if (key === '' && aiEnabled) setAiEnabled(false);
  }, [key, aiEnabled, setAiEnabled]);

  const save = async () => {
    const v = draft.trim();
    if (!v) return;
    await setAiKey(v);
    setKey(v);
    setDraft('');
    setResult(null);
  };

  const clear = async () => {
    await clearAiKey();
    setKey('');
    setResult(null);
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    const res = await generate({ prompt: 'Reply with the single word: ok', maxTokens: 5, temperature: 0, model });
    setResult(res.ok ? 'ok' : res.error);
    setTesting(false);
  };

  const locked = !key;
  return (
    <>
      <div className="settings-field settings-field--mt">
        <span className="settings-field__sublabel">{t('ai.keyLabel')}</span>
        {key ? (
          <div className="settings-field__row settings-ai-key">
            <span className="settings-ai-key__masked">{maskKey(key)}</span>
            <button className="settings-toggle__btn" onClick={() => void clear()}>
              {t('common.clear')}
            </button>
          </div>
        ) : (
          <div className="settings-field__row settings-ai-key">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={t('ai.keyLabel')}
              disabled={key === undefined}
            />
            <button className="settings-toggle__btn" disabled={!draft.trim()} onClick={() => void save()}>
              {t('common.save')}
            </button>
          </div>
        )}
        <div className="settings-field__sublabel settings-ai-note">{t('ai.keyHelp')}</div>
      </div>

      <label className="settings-field settings-field--mt">
        <span className="settings-field__sublabel">{t('ai.model')}</span>
        <div className="settings-field__row">
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => void setAiModel(model)}
            spellCheck={false}
            autoCapitalize="off"
          />
        </div>
        <span className="settings-field__sublabel settings-ai-note">{t('ai.modelHint', { model: DEFAULT_AI_MODEL })}</span>
      </label>

      <div className="settings-field__row settings-ai-test">
        <button className="settings-toggle__btn" disabled={!key || testing} onClick={() => void test()}>
          {testing ? t('ai.testing') : t('ai.test')}
        </button>
        {result && (
          <span role="status" className={`settings-field__sublabel${result === 'ok' ? '' : ' settings-ai-warn'}`}>
            {result === 'ok' ? t('ai.testOk') : t(`ai.err.${result}`)}
          </span>
        )}
      </div>

      <div className="settings-field settings-field--mt">
        <span className="settings-field__sublabel">
          {aiEnabled ? t('settings.aiFeaturesOnSub') : t('settings.aiFeaturesOffSub')}
        </span>
        <div className="settings-toggle">
          {([false, true] as const).map((on) => (
            <button
              key={String(on)}
              className={`settings-toggle__btn${aiEnabled === on ? ' settings-toggle__btn--active' : ''}`}
              onClick={() => setAiEnabled(on)}
              aria-pressed={aiEnabled === on}
              disabled={on && locked}
            >
              {on ? t('settings.aiOn') : t('settings.aiOff')}
            </button>
          ))}
        </div>
        {locked && <div className="settings-field__sublabel settings-ai-note">{t('ai.needKey')}</div>}
      </div>
      {/* Consent has to be informed where it is given, so this sits on the
          switch and not only in the policy. */}
      <div className="settings-field__sublabel settings-ai-note">{t('ai.terms')}</div>
    </>
  );
}
