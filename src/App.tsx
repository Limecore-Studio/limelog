import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — installed separately; see notifications.ts setup comment
import { LocalNotifications } from '@capacitor/local-notifications';
import { Layout } from '@/components/Layout';
import { TodayPage } from '@/pages/TodayPage';
import { FirstLaunchAuth } from '@/components/FirstLaunchAuth';
import { ReferralPrompt } from '@/components/ReferralPrompt';
import { PRCelebrationModal } from '@/components/PRCelebrationModal';
import { useProgramStore } from '@/store/programStore';
import { useNexusStore } from '@/store/nexusStore';
import { useLogStore } from '@/store/logStore';
import { isGuestMode } from '@/lib/guestMode';
import { isOnboarded, setOnboarded, hydrateOnboardedFromCloud, markOnboardedCloud } from '@/lib/onboarding';
import { pullWorkoutsFromCloud } from '@/lib/nexusRecovery';
import { phaseSessions, resolvePhase } from '@/lib/todaySessions';
import {
  setupNotificationChannel,
  labelNotifications,
  scheduleWorkoutReminders,
  WORKOUT_ACTION_START,
} from '@/utils/notifications';

// v1.17 (limecore#13): every page a launch does not open on is its own chunk,
// loaded the first time it is visited. Today (the index route) and the
// first-launch auth screen stay in the entry chunk.
const ProgramPage = lazy(() => import('@/pages/ProgramPage').then((m) => ({ default: m.ProgramPage })));
const ProgressPage = lazy(() => import('@/pages/ProgressPage').then((m) => ({ default: m.ProgressPage })));
const BodyMetricsPage = lazy(() => import('@/pages/BodyMetricsPage').then((m) => ({ default: m.BodyMetricsPage })));
const ProfilePage = lazy(() => import('@/pages/ProfilePage').then((m) => ({ default: m.ProfilePage })));
const LibraryPage = lazy(() => import('@/pages/LibraryPage').then((m) => ({ default: m.LibraryPage })));
const WorkoutPage = lazy(() => import('@/pages/WorkoutPage').then((m) => ({ default: m.WorkoutPage })));
const OnboardingFlow = lazy(() => import('@/components/OnboardingFlow').then((m) => ({ default: m.OnboardingFlow })));

/**
 * Subscribes to action-button taps on workout reminders and routes the user
 * to /today (where the "Start session" button is). Lives inside <BrowserRouter>
 * so useNavigate() works; a bare module-level listener would have no router
 * context when the app cold-starts from a notification tap. The handler is
 * a no-op if the listener fires before navigation is ready — Capacitor
 * replays the deferred event after `load()`, so the route lands either way.
 */
function NotificationActionBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let handle: { remove: () => void } | null = null;
    void (async () => {
      handle = await LocalNotifications.addListener(
        'localNotificationActionPerformed',
        (event: { actionId: string }) => {
          // actionId === 'tap' for the plain notification body tap, our
          // custom WORKOUT_ACTION_START for the explicit button. Both
          // surface the user on /today; the page's auto-route to
          // /workout/:logId handles the rest.
          if (
            event.actionId === WORKOUT_ACTION_START ||
            event.actionId === 'tap'
          ) {
            navigate('/today');
          }
        },
      );
    })();
    return () => {
      handle?.remove();
    };
  }, [navigate]);
  return null;
}

export default function App() {
  const { t, i18n } = useTranslation();
  const { activeProgram } = useProgramStore();
  const userEmail = useNexusStore((s) => s.userEmail);
  const sessionUnverified = useNexusStore((s) => s.sessionUnverified);
  const isNexusConfigured = useNexusStore((s) => s.configured);

  // Auth-gate state: whether the first-launch screen should be shown.
  // `null` while the guest-mode flag and the nexusStore are both still
  // resolving — render a splash to avoid flashing the auth screen for
  // returning users.
  const [guestMode, setGuestModeState] = useState<boolean | null>(null);
  const [nexusInitialized, setNexusInitialized] = useState(false);

  // v1.7 — first-run onboarding. Shown after the auth gate when the user has
  // no logged sessions yet and hasn't already completed/skipped onboarding.
  // logStore hydrates synchronously from localStorage, so sessionLogs is
  // populated on first render. `onboarded` flips when the wizard finishes.
  const sessionCount = useLogStore((s) => s.sessionLogs.length);
  const [onboarded, setOnboardedState] = useState<boolean>(() => isOnboarded());
  const [onboardChecked, setOnboardChecked] = useState(false);

  // v1.10 - ask the ACCOUNT whether onboarding is already done, not just this
  // device. Keyed on userEmail rather than nexusInitialized because it must
  // re-run when the user actually changes, not only on first init. Gated
  // behind `onboardChecked` so a signed-in user never sees a frame of the
  // wizard before the answer lands; signed out it resolves immediately,
  // because there is no account to ask.
  useEffect(() => {
    if (!nexusInitialized) return;
    if (!userEmail) { setOnboardChecked(true); return; }
    let cancelled = false;
    setOnboardChecked(false);
    void hydrateOnboardedFromCloud().then((done) => {
      if (cancelled) return;
      if (done) setOnboardedState(true);
      setOnboardChecked(true);
    });
    return () => { cancelled = true; };
  }, [userEmail, nexusInitialized]);

  // One-time channel creation + nexusStore init. The init() call awaits
  // supabase.auth.getSession(), which is what sets userEmail to its restored
  // value; we set nexusInitialized after init resolves so the gate below
  // doesn't show the auth screen mid-restore. (It was getUser() until v1.13 —
  // a network round trip standing between a returning user and their own app.)
  useEffect(() => {
    setupNotificationChannel();
    void (async () => {
      const guest = await isGuestMode();
      setGuestModeState(guest);
      await useNexusStore.getState().init();
      setNexusInitialized(true);
    })();
  }, []);

  // Listen for guest-mode flag changes triggered by FirstLaunchAuth (set)
  // or sign-out (clear). The Preferences plugin doesn't emit changes
  // natively, so callers dispatch this CustomEvent to re-trigger the gate.
  useEffect(() => {
    const onGuestChange = () => {
      void (async () => {
        const guest = await isGuestMode();
        setGuestModeState(guest);
      })();
    };
    window.addEventListener('limelog:guest-mode-changed', onGuestChange);
    return () => window.removeEventListener('limelog:guest-mode-changed', onGuestChange);
  }, []);

  // Drain Nexus queue when the device comes back online
  useEffect(() => {
    function onOnline() {
      const nexus = useNexusStore.getState();
      if (nexus.configured && nexus.syncEnabled && nexus.userEmail) {
        void nexus.retryPending();
      }
    }
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  // v1.7 (BUG-6) — recovery hydrate. Once, after Nexus init resolves with a
  // signed-in user, pull cloud workouts and reinstate any whose id is missing
  // locally (skipping tombstoned discards). This is the ONLY read of workout
  // data LimeLog performs, and it only refills genuine gaps — a reinstall / new
  // device / lost-data situation gets its pushed history back instead of it
  // being stranded in the cloud. Fire-and-forget; never blocks the UI.
  const recoveryRan = useRef(false);
  useEffect(() => {
    if (recoveryRan.current) return;
    if (!nexusInitialized || !isNexusConfigured || !userEmail) return;
    recoveryRan.current = true;
    void (async () => {
      try {
        const exercises = useProgramStore.getState().exercises;
        const cloudSessions = await pullWorkoutsFromCloud(exercises);
        const restored = useLogStore.getState().recoverSessions(cloudSessions);
        if (restored > 0) {
          console.log(`[recovery] reinstated ${restored} workout(s) from cloud`);
        }
      } catch (e) {
        console.warn('[recovery] workout hydrate failed:', (e as Error).message);
      }
    })();
  }, [nexusInitialized, isNexusConfigured, userEmail]);

  // Re-schedule whenever the active program changes. Pass the exercise
  // library so the notification body can preview the first few exercises
  // by display name (the SessionExercise FK only carries exerciseId).
  // Library is read at effect-fire time so a new exercise added later
  // surfaces on the next program edit.
  //
  // v1.18.1 (LimeLog#73): the active phase's sessions only, the ones Today
  // offers. Every phase's were scheduled, so a day with no session in the
  // current phase still got a reminder, sometimes under another phase's
  // session name.
  //
  // Also re-run on a language change (LimeLog#75). A reminder is built in the
  // language of the moment it is scheduled, and the channel name and the
  // "Start session" button are registered with Android the same way, so those
  // are registered again first (at launch setupNotificationChannel does it).
  const exerciseLibrary = useProgramStore((s) => s.exercises);
  const labelledIn = useRef(i18n.language);
  useEffect(() => {
    const sessions = phaseSessions(activeProgram, resolvePhase(activeProgram).current?.id);
    void (async () => {
      if (labelledIn.current !== i18n.language) {
        labelledIn.current = i18n.language;
        await labelNotifications().catch(() => { /* best-effort, as at launch */ });
      }
      await scheduleWorkoutReminders(sessions, exerciseLibrary);
    })();
  }, [activeProgram, exerciseLibrary, i18n.language]);

  // Auth gate: show the first-launch screen on a fresh install (no email,
  // not in guest mode). Skipped when Supabase isn't configured (env vars
  // absent — local-only build) because there's no point asking for an
  // account that can never be created. Skipped during the initial state
  // resolution to avoid a one-frame flash for returning users.
  //
  // v1.13 — `sessionUnverified` is the third state this gate was missing. It
  // used to have only "signed in" and "not signed in", so a launch that could
  // not REACH the server to find out landed in the second one and showed the
  // sign-in screen to someone who had never signed out. The app is local-first;
  // everything except sync works without a confirmed session, so the right
  // behaviour while the answer is unknown is to open the app and let the
  // auto-refresh resolve it — onAuthStateChange clears the flag either way.
  const isResolving = guestMode === null || !nexusInitialized;
  const shouldShowAuth =
    !isResolving && !userEmail && !sessionUnverified && !guestMode && isNexusConfigured;

  if (isResolving) {
    return (
      <div className="fla-splash">
        <div className="fla-splash-text">{t('common.loading')}</div>
      </div>
    );
  }

  if (shouldShowAuth) {
    return (
      <FirstLaunchAuth
        onContinue={() => {
          // FirstLaunchAuth's actions (set guest flag or trigger sign-in)
          // dispatch the limelog:guest-mode-changed event OR fire the
          // nexusStore auth listener. Either path flips the gate on the
          // next render. The explicit onContinue is a belt-and-suspenders
          // re-read of the guest flag in case Capacitor's Preferences write
          // landed after the event but before our listener was wired.
          void (async () => {
            const guest = await isGuestMode();
            setGuestModeState(guest);
          })();
        }}
      />
    );
  }

  // Onboarding gate — only after auth is satisfied, for a genuinely fresh
  // user (no sessions logged). Skipping or finishing sets the persisted flag.
  if (!onboarded && sessionCount === 0 && onboardChecked) {
    return (
      <Suspense fallback={null}>
        <OnboardingFlow
          onDone={() => {
            setOnboarded(); // belt-and-suspenders; the flow already persists it
            void markOnboardedCloud();
            setOnboardedState(true);
          }}
        />
      </Suspense>
    );
  }

  return (
    <BrowserRouter>
      <NotificationActionBridge />
      {/* Pages are lazy chunks (limecore#13). This boundary covers the
          fullscreen workout view; Layout has its own around <Outlet /> so the
          bottom nav stays put while a page loads. */}
      <Suspense fallback={null}>
        <Routes>
          {/* Fullscreen workout view — outside Layout so the bottom nav is hidden */}
          <Route path="/workout/:logId" element={<WorkoutPage />} />

          <Route element={<Layout />}>
            <Route index element={<Navigate to="/today" replace />} />
            <Route path="/today" element={<TodayPage />} />
            <Route path="/program" element={<ProgramPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/progress" element={<ProgressPage />} />
            <Route path="/body" element={<BodyMetricsPage />} />
            <Route path="/profile" element={<ProfilePage />} />
          </Route>
        </Routes>
      </Suspense>
      {/* v1.6 — global PR celebration; mounted outside Routes so it survives
          the post-finish navigate('/today'). */}
      <PRCelebrationModal />
      {/* Item 8 — asks once per account, inside the account-age window only.
          Non-blocking by design; see the component. */}
      <ReferralPrompt />
    </BrowserRouter>
  );
}
