import { useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { setErrorReportsEnabled, useErrorReportsEnabled } from '@/lib/errorReports';
import { setLanguage, SUPPORTED_LANGS, LANGUAGE_NAMES, type Lang } from '@/i18n';
import { useScrollSelectedIntoView } from '@/utils/useScrollSelectedIntoView';
import { useUserStore } from '@/store/userStore';
import { Button, Card, Badge, EmptyState, Tabs, TabPanel } from '@/components/ui';
import { InjuryForm } from '@/components/InjuryForm';
import { ExerciseLibrary } from '@/components/ExerciseLibrary';
import { NexusSyncCard } from '@/components/NexusSyncCard';
import { FeedbackCard } from '@/components/FeedbackCard';
import { ThemeCard } from '@/components/ThemeCard';
import { ShieldAlert } from 'lucide-react';
import { useConfirm } from '@/components/confirmContext';
import { downloadExport, deleteAccount, wipeAllLocalData } from '@/lib/dataRights';
import { supabase, isNexusConfigured } from '@/lib/supabase';
import { Capacitor } from '@capacitor/core';
import { setUpdateCheckEnabled, useFdroidUpdate } from '@/lib/fdroidUpdate';
import pkg from '../../package.json';
import { hasConsent, setConsent, subscribeConsent } from '@/lib/consent';
import { useNexusStore } from '@/store/nexusStore';
import '@/i18n/consentStrings'; // consent.* (loaded on demand)
import './ProfilePage.css';

type Tab = 'injuries' | 'exercises' | 'settings';

/** v1.21.1 (limecore#87) — the app-open record, opt-in: the same Off/On pair,
 *  off until this account says yes (here or in ConsentPrompt). Accounts only:
 *  a guest has nothing to record. */
function AppOpensField() {
  const { t } = useTranslation();
  const signedIn = useNexusStore((s) => !!s.userId);
  const on = useSyncExternalStore(subscribeConsent, () => hasConsent('appOpens'));
  if (!signedIn) return null;
  return (
    <>
      <div className="settings-field settings-field--mt">
        <span className="settings-field__sublabel">{t('consent.appOpens')}</span>
        <div className="settings-toggle">
          {([false, true] as const).map((v) => (
            <button
              key={String(v)}
              className={`settings-toggle__btn${on === v ? ' settings-toggle__btn--active' : ''}`}
              onClick={() => setConsent({ appOpens: v })}
              aria-pressed={on === v}
            >
              {v ? t('settings.aiOn') : t('settings.aiOff')}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-field__sublabel settings-ai-note">{t('consent.appOpensNote')}</div>
    </>
  );
}

/** v1.16 (limecore#16) — "Send error reports", the same Off/On pair as the
 *  AI switch. Off by default; the note under it is the consent text. */
function ErrorReportsField() {
  const { t } = useTranslation();
  const on = useErrorReportsEnabled();
  return (
    <>
      <div className="settings-field settings-field--mt">
        <span className="settings-field__sublabel">{t('settings.errorReports')}</span>
        <div className="settings-toggle">
          {([false, true] as const).map((v) => (
            <button
              key={String(v)}
              className={`settings-toggle__btn${on === v ? ' settings-toggle__btn--active' : ''}`}
              onClick={() => setErrorReportsEnabled(v)}
              aria-pressed={on === v}
            >
              {v ? t('settings.aiOn') : t('settings.aiOff')}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-field__sublabel settings-ai-note">{t('settings.errorReportsNote')}</div>
    </>
  );
}

export function ProfilePage() {
  const { profile, setName, setUnit, setAiEnabled, resolveRestriction, removeRestriction, updateDeloadThresholds } = useUserStore();
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const currentLang = (i18n.language || 'en').split('-')[0] as Lang;
  const langRef = useScrollSelectedIntoView<HTMLDivElement>();
  const [tab, setTab] = useState<Tab>('injuries');
  const [showInjuryForm, setShowInjuryForm] = useState(false);
  const [nameVal, setNameVal] = useState(profile.name);
  const [deleting, setDeleting] = useState(false);
  const [dataMsg, setDataMsg] = useState<string | null>(null);

  // ── GDPR Art. 20 — portability ──────────────────────────────────────────
  // Works as a guest too: a guest's training history never left the device,
  // but it is still their data.
  const onExport = async () => {
    setDataMsg(null);
    try {
      let account: { id: string; email?: string } | null = null;
      if (isNexusConfigured) {
        const { data } = await supabase.auth.getUser();
        if (data.user) account = { id: data.user.id, email: data.user.email };
      }
      const name = await downloadExport(account);
      setDataMsg(t('settings.exportDone', { name }));
    } catch (e) {
      setDataMsg(t('settings.exportFailed', { msg: (e as Error).message }));
    }
  };

  // ── GDPR Art. 17 — erasure ──────────────────────────────────────────────
  // Two confirmations, because this is irreversible, there is no recovery
  // window, and one account spans all three apps — which the second
  // confirmation says explicitly.
  const onDeleteAccount = async () => {
    if (!(await confirm({ message: t('settings.deleteAccountConfirm1') }))) return;
    if (!(await confirm({ message: t('settings.deleteAccountConfirm2') }))) return;
    setDataMsg(null);
    setDeleting(true);
    try {
      await deleteAccount({
        clearLocal: async () => {
          wipeAllLocalData();
        },
      });
      window.location.reload();
    } catch (e) {
      setDataMsg(t('settings.deleteAccountFailed', { msg: (e as Error).message }));
      setDeleting(false);
    }
  };

  const activeRestrictions = profile.activeRestrictions.filter((r) => r.active);
  const resolvedRestrictions = profile.activeRestrictions.filter((r) => !r.active);

  return (
    <div className="profile-page">
      <div className="profile-page__header">
        <h1 className="profile-page__title">{t('profile.title')}</h1>
      </div>

      <Tabs
        tabs={[
          { key: 'injuries', label: t('profile.tabInjuries') },
          { key: 'exercises', label: t('profile.tabExercises') },
          { key: 'settings', label: t('profile.tabSettings') },
        ]}
        activeKey={tab}
        onChange={(k) => setTab(k as Tab)}
      />

      <TabPanel tabKey="injuries" activeKey={tab}>
        <div className="profile-section">
          <div className="profile-section__header">
            <span className="profile-section__label">{t('profile.activeRestrictions')}</span>
            <Button size="sm" variant="primary" onClick={() => setShowInjuryForm(true)}>
              {t('common.add')}
            </Button>
          </div>

          {showInjuryForm && (
            <InjuryForm onClose={() => setShowInjuryForm(false)} />
          )}

          {activeRestrictions.length === 0 && !showInjuryForm && (
            <EmptyState
              icon={<ShieldAlert size={32} />}
              title={t('profile.noRestrictionsTitle')}
              description={t('profile.noRestrictionsBody')}
            />
          )}

          {activeRestrictions.map((r) => (
            <Card key={r.id} padding="sm">
              <div className="restriction-row">
                <div className="restriction-row__left">
                  <span className="restriction-row__label">{r.label}</span>
                  <Badge
                    label={t(`profile.severity.${r.severity}`, { defaultValue: r.severity })}
                    variant={r.severity === 'avoid' ? 'danger' : r.severity === 'modify' ? 'warning' : 'info'}
                  />
                </div>
                <div className="restriction-row__actions">
                  <Button size="sm" variant="ghost" onClick={() => resolveRestriction(r.id)}>{t('profile.resolve')}</Button>
                  <Button size="sm" variant="danger" onClick={() => removeRestriction(r.id)}>{t('profile.remove')}</Button>
                </div>
              </div>
              {r.restrictedPatterns.length > 0 && (
                <p className="restriction-row__patterns">
                  {t('profile.patterns', { list: r.restrictedPatterns.map((p) => t(`library.pattern.${p}`, { defaultValue: p })).join(', ') })}
                </p>
              )}
            </Card>
          ))}

          {resolvedRestrictions.length > 0 && (
            <>
              <p className="profile-section__sublabel">{t('profile.resolved')}</p>
              {resolvedRestrictions.map((r) => (
                <Card key={r.id} padding="sm" className="restriction-row--resolved">
                  <div className="restriction-row">
                    <span className="restriction-row__label">{r.label}</span>
                    <Button size="sm" variant="danger" onClick={() => removeRestriction(r.id)}>{t('profile.remove')}</Button>
                  </div>
                </Card>
              ))}
            </>
          )}
        </div>
      </TabPanel>

      <TabPanel tabKey="exercises" activeKey={tab}>
        <ExerciseLibrary />
      </TabPanel>

      <TabPanel tabKey="settings" activeKey={tab}>
        <div className="profile-section">
          <Card padding="md">
            <label className="settings-field">
              <span className="settings-field__label">{t('profile.name')}</span>
              <div className="settings-field__row">
                <input
                  value={nameVal}
                  onChange={(e) => setNameVal(e.target.value)}
                  onBlur={() => nameVal.trim() && setName(nameVal.trim())}
                />
              </div>
            </label>
          </Card>

          <Card padding="md">
            <span className="settings-field__label">{t('profile.weightUnit')}</span>
            <div className="settings-toggle">
              {(['kg', 'lb'] as const).map((u) => (
                <button
                  key={u}
                  className={`settings-toggle__btn${profile.unitPreference === u ? ' settings-toggle__btn--active' : ''}`}
                  onClick={() => setUnit(u)}
                >
                  {u}
                </button>
              ))}
            </div>
          </Card>

          <NexusSyncCard />

          <FeedbackCard />

          {/* Privacy & AI. Off by default — the debrief sends the note you type
              to Google Gemini, so it stays dark until asked for. */}
          <Card padding="md">
            <span className="settings-field__label">{t('settings.privacy')}</span>
            <div className="settings-field settings-field--mt">
              <span className="settings-field__sublabel">
                {profile.aiEnabled ? t('settings.aiFeaturesOnSub') : t('settings.aiFeaturesOffSub')}
              </span>
              <div className="settings-toggle">
                {([false, true] as const).map((on) => (
                  <button
                    key={String(on)}
                    className={`settings-toggle__btn${!!profile.aiEnabled === on ? ' settings-toggle__btn--active' : ''}`}
                    onClick={() => setAiEnabled(on)}
                    aria-pressed={!!profile.aiEnabled === on}
                  >
                    {on ? t('settings.aiOn') : t('settings.aiOff')}
                  </button>
                ))}
              </div>
            </div>
            {/* Free-tier disclosure — informed consent belongs at the switch. */}
            <div className="settings-field__sublabel settings-ai-note">
              {t('settings.aiTrainingNote')}
            </div>
            {/* v1.16 (limecore#16) — off by default, accounts only; the note is
                the consent text the privacy policy (NCC#50) relies on. */}
            <ErrorReportsField />
            <AppOpensField />
            <a
              className="settings-field__sublabel settings-privacy-link"
              href="https://limecore.dev/privacy"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('settings.privacyPolicy')} ›
            </a>
          </Card>

          {/* Your data — GDPR Art. 17 / 20. Buttons rather than a "write to us"
              address: a right the user has to request is a right most of them
              never exercise. */}
          <Card padding="md">
            <span className="settings-field__label">{t('settings.yourData')}</span>
            <div className="settings-field__sublabel settings-ai-note">
              {t('settings.yourDataNote')}
            </div>
            <button
              className="settings-data-btn"
              onClick={onExport}
            >
              {t('settings.exportData')}
            </button>
            <button
              className="settings-data-btn settings-data-btn--danger"
              onClick={onDeleteAccount}
              disabled={deleting}
            >
              {deleting ? t('settings.deletingAccount') : t('settings.deleteAccount')}
            </button>
            <div className="settings-field__sublabel settings-ai-note">
              {t('settings.deleteAccountNote')}
            </div>
            {dataMsg && <div className="settings-data-msg">{dataMsg}</div>}
          </Card>

          {/* Support — a link out, nothing more. It used to say "no
              entitlements, no supporter-only features"; v1.13 shipped the Cast
              Iron theme, so that is no longer true and the comment would have
              been the kind that quietly rots.
              What IS still true, and is the part worth stating: nothing here
              gates the app. The perk is one alternative palette. Every
              workout feature, every export, every sync path is identical for
              someone who never clicks this link — and because the app is
              open-source and on F-Droid, the theme's CSS ships to them too.
              The check exists so a supporter's perk switches on by itself,
              not as an enforcement boundary. */}
          <Card padding="md">
            <span className="settings-field__label">{t('settings.support')}</span>
            <div className="settings-field__sublabel settings-ai-note">
              {t('settings.supportDevSub')}
            </div>
            <a
              className="settings-field__sublabel settings-privacy-link"
              href="https://ko-fi.com/limecorestudio"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('settings.supportDev')} ›
            </a>
            {/* Shares the Ko-fi card rather than taking its own, because the
                two are about to be connected: Ko-fi's Discord bot maps a
                membership tier onto a Discord role. Same shape as the link
                above — an ordinary outbound link, no SDK, no embed, nothing
                fetched from discord.com unless the user taps it. */}
            <div className="settings-field__sublabel settings-ai-note">
              {t('settings.discordSub')}
            </div>
            <a
              className="settings-field__sublabel settings-privacy-link"
              href="https://discord.gg/g8VuB4yXHY"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('settings.discord')} ›
            </a>
          </Card>

          {/* Appearance sits next to Language: both answer "how does this app
              look and read to me", and a user hunting for one will scan past
              the other. */}
          <ThemeCard />

          <Card padding="md">
            <span className="settings-field__label">{t('settings.language')}</span>
            <div className="settings-lang-grid" ref={langRef}>
              {SUPPORTED_LANGS.map((code) => (
                <button
                  key={code}
                  className={`settings-toggle__btn${currentLang === code ? ' settings-toggle__btn--active' : ''}`}
                  onClick={() => setLanguage(code)}
                  aria-pressed={currentLang === code}
                >
                  {LANGUAGE_NAMES[code]}
                </button>
              ))}
            </div>
          </Card>

          <Card padding="md">
            <span className="settings-field__label">{t('profile.deloadThresholds')}</span>
            <label className="settings-field">
              <span className="settings-field__sublabel">{t('profile.stallTrigger')}</span>
              <input
                type="number"
                min="1"
                max="10"
                value={profile.deloadThresholds.stallCountTrigger}
                onChange={(e) => updateDeloadThresholds({ stallCountTrigger: Number(e.target.value) })}
              />
            </label>
            <label className="settings-field settings-field--mt">
              <span className="settings-field__sublabel">{t('profile.fatigueTrigger')}</span>
              <input
                type="number"
                min="1"
                max="10"
                step="0.5"
                value={profile.deloadThresholds.avgFatigueTrigger}
                onChange={(e) => updateDeloadThresholds({ avgFatigueTrigger: Number(e.target.value) })}
              />
            </label>
          </Card>

          {/* About. StudyDesk and NCC have both shown the version in Settings
              since v1.9; this app only ever put it in the feedback card's
              footer, so "which build is on my phone?" could not be answered
              without opening the feedback form and reading the small print
              under it. That is the one question a version string exists to
              answer, and it is asked precisely when something is wrong. */}
          <Card padding="md">
            <span className="settings-field__label">{t('settings.about')}</span>
            <div className="settings-version-row">
              <span className="settings-field__sublabel">LimeLog</span>
              <span className="settings-version">v{pkg.version}</span>
            </div>
            {Capacitor.getPlatform() === 'android' && <FdroidUpdateToggle />}
          </Card>
        </div>
      </TabPanel>
    </div>
  );
}

/** v1.16 (#26) — the switch the privacy policy promises (NCC#50): Off stops
 *  the once-a-day request to f-droid.org entirely, not merely the note.
 *  v1.21.1 (limecore#87): off until the person says yes (consent.ts). The
 *  same Off/On pair as the AI switch above. Android only, because it is the
 *  only build F-Droid ships. */
function FdroidUpdateToggle() {
  const { t } = useTranslation();
  const { enabled } = useFdroidUpdate();
  return (
    <>
      <div className="settings-field settings-field--mt">
        <span className="settings-field__sublabel">{t('settings.fdroidCheck')}</span>
        <div className="settings-toggle">
          {([false, true] as const).map((on) => (
            <button
              key={String(on)}
              className={`settings-toggle__btn${enabled === on ? ' settings-toggle__btn--active' : ''}`}
              onClick={() => setUpdateCheckEnabled(on)}
              aria-pressed={enabled === on}
            >
              {on ? t('settings.aiOn') : t('settings.aiOff')}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-field__sublabel settings-ai-note">{t('settings.fdroidCheckNote')}</div>
    </>
  );
}
