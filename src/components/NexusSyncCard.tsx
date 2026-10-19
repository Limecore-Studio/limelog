import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { useNexusStore } from '@/store/nexusStore';
import { inheritFromNexus } from '@/lib/suiteSso';
import { Button, Card, Badge } from '@/components/ui';
import { Cloud, CloudOff } from 'lucide-react';
import { ChangeEmail } from '@/components/ChangeEmail';
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
    setSyncEnabled,
    retryPending,
  } = useNexusStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [localError, setLocalError] = useState<string | null>(null);
  const [retryStatus, setRetryStatus] = useState<string | null>(null);
  const [nexusAvailable, setNexusAvailable] = useState(false);

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
        setLocalError(result.reason || 'Could not inherit Nexus session.');
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

  async function handleRetry() {
    setRetryStatus('Retrying…');
    const result = await retryPending();
    setRetryStatus(
      result.sent > 0
        ? `Sent ${result.sent}, ${result.remaining} still queued`
        : result.remaining > 0
          ? `${result.remaining} still queued`
          : 'Queue empty'
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
              {syncEnabled ? t('sync.on') : t('sync.off')}
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
              Last push: {new Date(outboxStatus.lastSuccessAt ?? lastPushAt!).toLocaleTimeString()}
            </p>
          )}

          {outboxStatus.stuck > 0 && (
            <p className="nexus-card__error">
              {outboxStatus.stuck} item{outboxStatus.stuck > 1 ? 's' : ''} stuck after retries — check connection or sign back in.
            </p>
          )}

          {lastError && <p className="nexus-card__error">{lastError}</p>}
          {!lastError && outboxStatus.lastError && (
            <p className="nexus-card__error">
              Last error: {outboxStatus.lastError}
            </p>
          )}

          <Button
            size="sm"
            variant="ghost"
            onClick={() => void signOut()}
            disabled={loading}
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
                disabled={loading}
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
            disabled={loading}
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
            <Button type="submit" variant="primary" size="sm" disabled={loading}>
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
