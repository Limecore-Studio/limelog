import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { useNexusStore } from '@/store/nexusStore';
import { inheritFromNexus } from '@/lib/suiteSso';
import { Button, Card, Badge } from '@/components/ui';
import { Cloud, CloudOff } from 'lucide-react';
import { ChangeEmail } from '@/components/ChangeEmail';
import { useConfirm } from '@/components/confirmContext';
import { useLogStore } from '@/store/logStore';
import { listPhotos } from '@/lib/progressPhotos';
import { formatTime } from '@/utils/helpers';
import './NexusSyncCard.css';

// Inline plugin handle for the "is NCC session available?" probe. We can't
// call inheritFromNexus to probe because that would actually set the
// session; we want to check availability silently first to decide whether
// to render the affordance.
const SuiteSsoProbe = registerPlugin<{
  getNexusSession(): Promise<{ available: boolean; reason?: string }>;
}>('SuiteSso');

export function NexusSyncCard() {
  const { t } = useTranslation();
  const {
    configured,
    syncEnabled,
    userEmail,
    loading,
    lastError,
    pendingCount,
    outboxStatus,
    lastPushAt,
    signIn,
    signUp,
    signInWithGoogle,
    signOut,
    signOutPending,
    setSyncEnabled,
    retryPending,
  } = useNexusStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [localError, setLocalError] = useState<string | null>(null);
  const [retryStatus, setRetryStatus] = useState<string | null>(null);
  const [nexusAvailable, setNexusAvailable] = useState(false);
  const confirm = useConfirm();

  // v1.18.1 (LimeLog#66): sign-out wipes this device's workouts, body
  // measurements and progress photos (shared-device privacy). Photos are never
  // uploaded, and with sync off nothing is, so one tap could delete what
  // exists nowhere else. Say what will be lost, and ask.
  async function handleSignOut() {
    const parts = [t('sync.signOutConfirm')];
    // Queued changes are counted whatever the sync setting: body metrics are
    // queued with sync off too. Workouts are not queued while it is off.
    if (pendingCount > 0) parts.push(t('sync.signOutUnsynced', { count: pendingCount }));
    if (!syncEnabled && useLogStore.getState().sessionLogs.length > 0) parts.push(t('sync.signOutSyncOff'));
    const photos = listPhotos().length;
    if (photos > 0) parts.push(t('sync.signOutPhotos', { count: photos }));
    if (!(await confirm({ message: parts.join(' '), confirmLabel: t('sync.signOut') }))) return;
    try {
      await signOut();
    } catch {
      // signOut does not throw for a server it cannot reach (it signs out
      // here instead); anything else is unexpected and must not escape the
      // click handler.
    }
  }

  // v1.4 — probe NCC's SessionContentProvider on mount. Silent on failure:
  // if NCC isn't installed or signing certs don't match, the affordance
  // simply doesn't render and the user sees the Google/email flow alone.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    if (userEmail) return; // already signed in; no probe needed
    let cancelled = false;
    void (async () => {
      try {
        const result = await SuiteSsoProbe.getNexusSession();
        if (!cancelled && result.available) setNexusAvailable(true);
      } catch {
        // Plugin missing or errored — fall through to Google/email path.
      }
    })();
    return () => { cancelled = true; };
  }, [userEmail]);

  async function handleNexus() {
    setLocalError(null);
    try {
      const result = await inheritFromNexus();
      if (!result.ok) {
        setLocalError(result.reason || t('auth.errNexus'));
      }
      // On success, nexusStore.init's auth listener takes over.
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    try {
      if (mode === 'signin') {
        await signIn(email.trim(), password);
      } else {
        await signUp(email.trim(), password);
      }
      setPassword('');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleGoogle() {
    setLocalError(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  }

  // v1.18.1 (LimeLog#77) — the retry status, the last-push and error lines
  // and the stuck warning below were still English. (On/Off is translated by
  // the training PR, #79.)
  //
  // v1.18.1 (LimeLog#82) — the two queue lines say "changes", not "workouts":
  // pendingCount is the whole outbox (body metrics, PRs, app opens and
  // deletions as well as workouts), and Retry sends all of it. The calls are
  // the training PR's (#79) word for word, so the two merge cleanly; only the
  // wording of sync.queued / sync.queuedSignedOut differs.
  async function handleRetry() {
    setRetryStatus(t('sync.retrying'));
    const result = await retryPending();
    setRetryStatus(
      result.sent > 0
        ? t('sync.retrySent', { sent: result.sent, count: result.remaining })
        : result.remaining > 0
          ? t('sync.retryRemaining', { count: result.remaining })
          : t('sync.queueEmpty')
    );
    setTimeout(() => setRetryStatus(null), 3000);
  }

  if (!configured) {
    return (
      <Card padding="md">
        <div className="nexus-card__header">
          <CloudOff size={18} />
          <span className="settings-field__label" style={{ margin: 0 }}>{t('sync.title')}</span>
        </div>
        {/* Developer diagnostic: only reachable in a build without Supabase env
            vars, which a released build never is. Left in English deliberately —
            every meaningful token in it is an identifier. */}
        <p className="nexus-card__hint">
          Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in <code>.env</code>,
          then rebuild to enable.
        </p>
      </Card>
    );
  }

  return (
    <Card padding="md">
      <div className="nexus-card__header">
        <Cloud size={18} />
        <span className="settings-field__label" style={{ margin: 0 }}>{t('sync.title')}</span>
        {userEmail && <Badge label={t('sync.connected')} variant="success" />}
      </div>

      {userEmail ? (
        <>
          <p className="nexus-card__signed-in">
            {t('sync.signedInAs')} <strong>{userEmail}</strong>
          </p>
          {/* v1.17 (limecore#10): email/password accounts only. */}
          <ChangeEmail userEmail={userEmail} />

          <div className="nexus-card__row">
            <span className="settings-field__sublabel">{t('sync.autoPush')}</span>
            <button
              className={`settings-toggle__btn${syncEnabled ? ' settings-toggle__btn--active' : ''}`}
              onClick={() => setSyncEnabled(!syncEnabled)}
              style={{ flex: 'none', padding: '6px 14px' }}
            >
              {syncEnabled ? 'On' : 'Off'}
            </button>
          </div>

          <div className="nexus-card__row">
            <span className="settings-field__sublabel">
              {pendingCount > 0 ? t('sync.queued', { count: pendingCount }) : t('sync.queueEmpty')}
            </span>
            {pendingCount > 0 && (
              <Button size="sm" variant="secondary" onClick={handleRetry}>
                {t('sync.retryNow')}
              </Button>
            )}
          </div>

          {retryStatus && <p className="nexus-card__status">{retryStatus}</p>}

          {/* v1.2 — richer outbox status. lastPushAt is "intent time" (when the
              user finalized the workout); outbox.lastSuccessAt is "ack time"
              (when Supabase confirmed). Show whichever is most recent for the
              "last push" line, and the stuck warning when items hit MAX_ATTEMPTS. */}
          {(lastPushAt || outboxStatus.lastSuccessAt) && (
            <p className="nexus-card__meta">
              {t('sync.lastPush', { time: formatTime(outboxStatus.lastSuccessAt ?? lastPushAt!) })}
            </p>
          )}

          {outboxStatus.stuck > 0 && (
            <p className="nexus-card__error">
              {t('sync.stuck', { count: outboxStatus.stuck })}
            </p>
          )}

          {lastError && <p className="nexus-card__error">{lastError}</p>}
          {!lastError && outboxStatus.lastError && (
            <p className="nexus-card__error">
              {t('sync.lastError', { error: outboxStatus.lastError })}
            </p>
          )}

          <Button
            size="sm"
            variant="ghost"
            onClick={() => void handleSignOut()}
            disabled={loading || signOutPending}
            className="nexus-card__signout"
          >
            {t('sync.signOut')}
          </Button>
        </>
      ) : (
        <form onSubmit={handleSubmit} className="nexus-card__form">
          {nexusAvailable && (
            <>
              <Button
                type="button"
                variant="primary"
                size="md"
                fullWidth
                onClick={handleNexus}
                disabled={loading || signOutPending}
                className="nexus-card__nexus"
              >
                <span className="nexus-card__nexus-glyph" aria-hidden="true">◈</span>
                {t('auth.nexus')}
              </Button>
              <p className="nexus-card__nexus-note">
                {t('auth.nexusNote')}
              </p>
            </>
          )}

          <Button
            type="button"
            variant="secondary"
            size="md"
            fullWidth
            onClick={handleGoogle}
            disabled={loading || signOutPending}
            className="nexus-card__google"
          >
            {t('auth.google')}
          </Button>

          <div className="nexus-card__divider">
            <span>{t('sync.orUseEmail')}</span>
          </div>

          <label className="settings-field">
            <span className="settings-field__sublabel">{t('auth.emailLabel')}</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label className="settings-field settings-field--mt">
            <span className="settings-field__sublabel">{t('auth.passwordLabel')}</span>
            <input
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
            />
          </label>

          {(localError ?? lastError) && (
            <p className="nexus-card__error">{localError ?? lastError}</p>
          )}

          <div className="nexus-card__actions">
            <Button type="submit" variant="primary" size="sm" disabled={loading || signOutPending}>
              {loading ? '…' : mode === 'signin' ? t('auth.signIn') : t('auth.createAccount')}
            </Button>
            <button
              type="button"
              className="nexus-card__toggle"
              onClick={() => {
                setMode(mode === 'signin' ? 'signup' : 'signin');
                setLocalError(null);
              }}
            >
              {mode === 'signin' ? t('auth.needAccount') : t('auth.haveAccount')}
            </button>
          </div>

          {pendingCount > 0 && (
            <p className="nexus-card__meta">
              {t('sync.queuedSignedOut', { count: pendingCount })}
            </p>
          )}
        </form>
      )}
    </Card>
  );
}
