// First-launch sign-in screen for LimeLog. Replaces the buried-in-Settings
// auth flow with an upfront affordance: sign in to enable Nexus sync, or
// continue locally without an account.
//
// Order of options (suite-wide convention):
//   1. Continue with Nexus — only shown when NCC is installed on this device
//      and has a published session. Inverted-card lime styling marks it as
//      the suite-native path.
//   2. Continue with Google — secondary card.
//   3. Use email instead — collapsed by default.
//   4. Continue as guest  — clearly last, with a caption explaining the
//      local-only trade-off.

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Button, Card } from '@/components/ui';
import { useNexusStore } from '@/store/nexusStore';
import { supabase } from '@/lib/supabase';
import { withCaptcha } from '@/lib/captcha';
import { inheritFromNexus } from '@/lib/suiteSso';
import { setGuestMode } from '@/lib/guestMode';
import { translateAuthError } from '@/lib/authErrors';
import { useConfirm } from '@/components/confirmContext';
import { useLogStore } from '@/store/logStore';
import { listPhotos } from '@/lib/progressPhotos';
import './FirstLaunchAuth.css';

// AUTH-2 — confirmation-code bounds, ported from StudyDesk's AuthGate.
//
// Supabase's Mailer OTP Length is a project setting with a documented 6-10
// range, and this project emits 8. The whole range is accepted on purpose:
// StudyDesk's first version assumed 6, which left the field physically unable
// to hold a valid code (fixed in 1.6.2), and pinning it to 8 would only defer
// the same failure to the next settings change.
const OTP_MIN = 6;
const OTP_MAX = 10;

const RESEND_COOLDOWN_S = 60;

const SuiteSsoProbe = registerPlugin<{
  getNexusSession(): Promise<{ available: boolean; reason?: string }>;
}>('SuiteSso');

interface FirstLaunchAuthProps {
  /** Called after the user picks any option that resolves to "let me in" —
   *  either a successful sign-in OR tapping Continue as Guest. The parent
   *  (App.tsx) re-evaluates its gate after this fires. */
  onContinue: () => void;
}

export function FirstLaunchAuth({ onContinue }: FirstLaunchAuthProps) {
  const { t } = useTranslation();
  const { signIn, signUp, signInWithGoogle, continueAsGuest, syncEnabled, configured, loading: storeLoading } =
    useNexusStore();
  const confirm = useConfirm();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [showEmail, setShowEmail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nexusAvailable, setNexusAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  // AUTH-2 — code-entry step, ported from StudyDesk's AuthGate.
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [info, setInfo] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);

  // Probe NCC's SessionContentProvider on mount. Silent on failure: when NCC
  // isn't installed or there's no published session, the affordance just
  // doesn't render. See NexusSyncCard for the symmetric probe in Settings.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await SuiteSsoProbe.getNexusSession();
        if (!cancelled && result.available) setNexusAvailable(true);
      } catch {
        /* fall through to Google/email path */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // AUTH-2 — resend cooldown. An interval rather than a timeout chain, so a
  // re-render can't orphan a pending tick; it clears itself when it hits 0.
  useEffect(() => {
    if (resendIn <= 0) return;
    const id = setInterval(() => setResendIn((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(id);
  }, [resendIn]);

  async function handleNexus() {
    setError(null);
    setBusy(true);
    try {
      const result = await inheritFromNexus();
      if (!result.ok) {
        setError(result.reason ?? t('auth.errNexus'));
        setBusy(false);
        return;
      }
      // nexusStore's auth-state listener fires; App.tsx re-evaluates and
      // routes away from this screen on its own. Clear guest flag too in
      // case the user was in guest mode and is now upgrading.
      await setGuestMode(false);
      onContinue();
    } catch (err) {
      setError(translateAuthError(err as Error, t));
      setBusy(false);
    }
  }

  async function handleGoogle() {
    setError(null);
    setBusy(true);
    try {
      // v1.1 — UI/UX review #12: do NOT clear guestMode here. signInWithGoogle
      // kicks off an OAuth round-trip that the user can abort by closing the
      // Chrome Custom Tab. If we cleared the flag pre-emptively and they
      // aborted, they'd lose their guest-mode state with no completed sign-in
      // to replace it. Instead, let the success path handle it — nexusStore's
      // onAuthStateChange fires SIGNED_IN when the OAuth completes, and the
      // session-driven re-render takes care of leaving FirstLaunchAuth. The
      // guest flag only really matters when there's no session; once we have
      // one, the gate ignores it.
      await signInWithGoogle();
    } catch (err) {
      setError(translateAuthError(err as Error, t));
    } finally {
      setBusy(false);
    }
  }

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signin') {
        await signIn(email.trim(), password);
      } else {
        const { needsConfirmation } = await signUp(email.trim(), password);
        if (needsConfirmation) {
          // AUTH-2 — no session yet, so no auth-state change is coming. Show
          // the code step instead of leaving the user on a form that looks
          // like it did nothing.
          setPassword('');
          setAwaitingCode(true);
          return;
        }
      }
      await setGuestMode(false);
      setPassword('');
      // onAuthStateChange in nexusStore drives the parent re-render.
    } catch (err) {
      setError(translateAuthError(err as Error, t));
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    const token = otpCode.replace(/\D/g, '');
    // Lower bound, not an exact length — see OTP_MIN.
    if (token.length < OTP_MIN) {
      setError(t('auth.errOtpLength'));
      return;
    }
    setBusy(true);
    try {
      const { error: err } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token,
        type: 'signup',
      });
      if (err) throw err;
      await setGuestMode(false);
      // Success fires onAuthStateChange, which drives the parent re-render.
    } catch (err) {
      setError(translateAuthError(err as Error, t) ?? t('auth.errOtp'));
    } finally {
      setBusy(false);
    }
  }

  async function handleResend() {
    if (resendIn > 0 || busy) return;
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const { error: err } = await withCaptcha((captchaToken) =>
        supabase.auth.resend({ type: 'signup', email: email.trim(), options: { captchaToken } }));
      if (err) throw err;
      setInfo(t('auth.otpSent'));
    } catch (err) {
      setError(translateAuthError(err as Error, t) ?? t('auth.errOtpResend'));
    } finally {
      // Cooldown starts either way: the usual cause of a failure here is
      // having hit the server-side send interval, and re-enabling the button
      // immediately just invites the same error again.
      setResendIn(RESEND_COOLDOWN_S);
      setBusy(false);
    }
  }

  // v1.18.1 (LimeLog#91) — after a session that ended without a sign-out the
  // local data is still that account's, so a guest would see it and add to
  // it. The store asks through this first; Continue clears it as a sign-out
  // does, Cancel stays here. The sentences are the sign-out confirm's
  // (NexusSyncCard), so the two say the same about what is lost.
  async function handleGuest() {
    const entered = await continueAsGuest(async (held) => {
      const parts = [
        held.email ? t('auth.guestHeldEmail', { email: held.email }) : t('auth.guestHeldAccount'),
        t('auth.guestHeldRemove'),
      ];
      if (held.unsynced > 0) parts.push(t('sync.signOutUnsynced', { count: held.unsynced }));
      if (!syncEnabled && useLogStore.getState().sessionLogs.length > 0) parts.push(t('sync.signOutSyncOff'));
      const photos = listPhotos().length;
      if (photos > 0) parts.push(t('sync.signOutPhotos', { count: photos }));
      return confirm({ title: t('auth.guestHeldTitle'), message: parts.join(' '), confirmLabel: t('auth.guest') });
    });
    if (entered) onContinue();
  }

  const disabled = busy || storeLoading;

  // AUTH-2 — the emailed link is not replaced. The installed Supabase template
  // carries a link and a code off the same token, so this is a second way
  // through and mail already sitting in an inbox keeps working.
  if (awaitingCode) {
    return (
      <div className="fla-wrap">
        <div className="fla-stack">
          <div className="fla-header">
            {/* "LimeLog" is the product name — deliberately not a key. */}
            <div className="fla-wordmark">LimeLog</div>
            <div className="fla-tagline">{t('auth.tagline')}</div>
          </div>

          <Card padding="md" className="fla-card">
            <div className="fla-title">{t('auth.otpTitle')}</div>
            <div className="fla-sub">
              {t('auth.otpSub')} {email.trim()}
            </div>

            <form onSubmit={handleVerify} className="fla-form">
              <label className="fla-field">
                <span className="fla-field-label">{t('auth.otpLabel')}</span>
                <input
                  className="fla-otp-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  /* Placeholder length follows OTP_MAX rather than a literal,
                     so the field never advertises a stale digit count. */
                  placeholder={'-'.repeat(OTP_MAX)}
                  maxLength={OTP_MAX}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, OTP_MAX))}
                />
              </label>

              {error && <div className="fla-error">{error}</div>}
              {info && <div className="fla-info">{info}</div>}

              <Button type="submit" variant="primary" fullWidth disabled={disabled}>
                {t('auth.otpSubmit')}
              </Button>
            </form>

            <div className="fla-sub fla-otp-hint">{t('auth.otpHint')}</div>

            <Button
              type="button"
              variant="ghost"
              fullWidth
              disabled={resendIn > 0 || disabled}
              onClick={handleResend}
            >
              {resendIn > 0 ? `${t('auth.otpResendIn')} ${resendIn}s` : t('auth.otpResend')}
            </Button>

            <Button
              type="button"
              variant="ghost"
              fullWidth
              onClick={() => {
                setAwaitingCode(false);
                setOtpCode('');
                setError(null);
                setInfo(null);
              }}
            >
              {t('auth.otpBack')}
            </Button>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="fla-wrap">
      <div className="fla-stack">
        <div className="fla-header">
          {/* "LimeLog" is the product name — deliberately not a key. */}
          <div className="fla-wordmark">LimeLog</div>
          <div className="fla-tagline">{t('auth.tagline')}</div>
        </div>

        <Card padding="md" className="fla-card">
          <div className="fla-title">
            {showEmail
              ? mode === 'signin'
                ? t('auth.titleSignInEmail')
                : t('auth.titleCreateAccount')
              : t('auth.titleGetStarted')}
          </div>
          <div className="fla-sub">
            {showEmail ? t('auth.subEmail') : t('auth.subGetStarted')}
          </div>

          {!showEmail && (
            <div className="fla-actions">
              {/* Suite-native path — inverted lime card. Only visible when
                  NCC is installed and signed in on this device. */}
              {nexusAvailable && (
                <>
                  <Button
                    type="button"
                    variant="primary"
                    size="md"
                    fullWidth
                    onClick={handleNexus}
                    disabled={disabled}
                    className="fla-nexus"
                  >
                    <span className="fla-nexus-glyph" aria-hidden="true">◈</span>
                    {t('auth.nexus')}
                  </Button>
                  <p className="fla-nexus-note">{t('auth.nexusNote')}</p>
                </>
              )}

              <Button
                type="button"
                variant={nexusAvailable ? 'secondary' : 'primary'}
                size="md"
                fullWidth
                onClick={handleGoogle}
                disabled={disabled}
              >
                {t('auth.google')}
              </Button>

              <button
                type="button"
                className="fla-toggle"
                onClick={() => setShowEmail(true)}
                disabled={disabled}
              >
                {t('auth.useEmail')}
              </button>
            </div>
          )}

          {showEmail && (
            <form onSubmit={handleEmail} className="fla-form">
              <label className="fla-field">
                <span className="fla-field-label">{t('auth.emailLabel')}</span>
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
              <label className="fla-field">
                <span className="fla-field-label">{t('auth.passwordLabel')}</span>
                <input
                  type="password"
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={6}
                  required
                />
              </label>

              <Button
                type="submit"
                variant="primary"
                size="md"
                fullWidth
                disabled={disabled}
              >
                {disabled ? '…' : mode === 'signin' ? t('auth.signIn') : t('auth.createAccount')}
              </Button>

              <div className="fla-form-footer">
                <button
                  type="button"
                  className="fla-toggle"
                  onClick={() => {
                    setMode(mode === 'signin' ? 'signup' : 'signin');
                    setError(null);
                  }}
                >
                  {mode === 'signin' ? t('auth.needAccount') : t('auth.haveAccount')}
                </button>
                <button
                  type="button"
                  className="fla-toggle"
                  onClick={() => setShowEmail(false)}
                >
                  {t('auth.back')}
                </button>
              </div>
            </form>
          )}

          {error && <p className="fla-error">{error}</p>}
          {!configured && <p className="fla-warn">{t('auth.notConfigured')}</p>}
        </Card>

        {/* Guest path — visually below the card, distinct from the sign-in
            affordances. Keeps the "continue" verb to make the implication
            ("you'll use it without an account") obvious. */}
        <div className="fla-guest">
          <button
            type="button"
            className="fla-guest-btn"
            onClick={handleGuest}
            disabled={disabled}
          >
            {t('auth.guest')}
          </button>
          <p className="fla-guest-note">{t('auth.guestNote')}</p>
          {/* GDPR Art. 8 — consent for an information society service is only
              valid from 16 (13 in some member states). We cannot verify ages
              and are not expected to, but the policy states the limit so the
              signup surface should too, and it points at the guest option
              directly above, which needs no account at all. */}
          <p className="fla-legal-note">
            {t('auth.ageNote')}{' '}
            <a
              href="https://limecore.dev/privacy"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('auth.privacyLink')}
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
