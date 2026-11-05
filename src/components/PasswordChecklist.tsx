import { useTranslation } from 'react-i18next';
import { checkPassword, PASSWORD_MIN_LENGTH } from '@/lib/passwordPolicy';
import '@/i18n/passwordStrings'; // the auth.pw* strings (loaded on demand)
import './PasswordChecklist.css';

// v1.20 (limecore#73) — the password rule, shown before the server refuses it.
// Each item ticks as you type. `flagMissing` is set once a submit has failed on
// the rule, so the items still open turn to the danger colour instead of
// waiting quietly in grey. The submit button itself stays enabled.
const LABELS: Record<string, string> = {
  length: 'auth.pwRuleLength',
  lower: 'auth.pwRuleLower',
  upper: 'auth.pwRuleUpper',
  digit: 'auth.pwRuleDigit',
  symbol: 'auth.pwRuleSymbol',
};

export function PasswordChecklist({ password, flagMissing = false, id }: { password: string; flagMissing?: boolean; id?: string }) {
  const { t } = useTranslation();
  return (
    <ul className="pw-rules" id={id} aria-label={t('auth.pwRulesLabel')}>
      {checkPassword(password).map(({ id: rule, ok }) => (
        <li key={rule} className={ok ? 'is-ok' : flagMissing ? 'is-missing' : undefined}>
          <span className="pw-rules__mark" aria-hidden="true">{ok ? '✓' : '·'}</span>
          {t(LABELS[rule], { n: PASSWORD_MIN_LENGTH })}
          {ok && <span className="pw-rules__vh">{` — ${t('auth.pwRuleMet')}`}</span>}
        </li>
      ))}
    </ul>
  );
}
