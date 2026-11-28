import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '@/components/confirmContext';
import { readHealthConsent, subscribeHealthConsent } from '@/lib/healthConsent';
import { grantHealthConsent, withdrawHealthConsent } from '@/lib/healthConsentActions';
import '@/i18n/healthStrings';

// v1.22 (limecore#91) — the health-data consent in Settings: given (with its
// date) or not, and the way to change it. Withdrawing is confirmed, as it
// erases the server's copy.
export function HealthConsentField() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const rec = useSyncExternalStore(subscribeHealthConsent, () => JSON.stringify(readHealthConsent()));
  const r = JSON.parse(rec) as { granted: boolean; at: string } | null;
  const on = !!r?.granted;
  const date = r ? new Date(r.at).toLocaleDateString(i18n.language) : '';

  const choose = async (yes: boolean) => {
    if (yes === on) return;
    if (yes) return grantHealthConsent();
    if (await confirm({ message: t('healthConsent.withdrawConfirm'), confirmLabel: t('healthConsent.withdraw') })) withdrawHealthConsent();
  };

  return (
    <div className="settings-field settings-field--mt">
      <span className="settings-field__sublabel">{t('healthConsent.setting')}</span>
      <div className="settings-toggle">
        {([false, true] as const).map((v) => (
          <button
            key={String(v)}
            className={`settings-toggle__btn${on === v ? ' settings-toggle__btn--active' : ''}`}
            aria-pressed={on === v}
            onClick={() => void choose(v)}
          >
            {v ? t('healthConsent.allow') : t('healthConsent.withdraw')}
          </button>
        ))}
      </div>
      <div className="settings-field__sublabel settings-ai-note">
        {/* v1.22 (device pass): "declined" and "not asked yet" used to read the
            same ("Off"), which hid whether the one-time question had been
            answered. */}
        {on
          ? t('healthConsent.settingOn', { date })
          : r
            ? t('healthConsent.settingDeclined', { date })
            : t('healthConsent.settingUnasked')}
      </div>
    </div>
  );
}
