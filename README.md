# Limelog

A personal workout tracker for periodized strength programs — phases, sessions, per-set RPE, vertical jump tracking, injury-restriction gating. Built because Strong / Hevy / JEFIT can't combine phase awareness, sport-specific metrics, and injury flags in one place.

**Studio:** [Limecore](https://github.com/Limekana) · **Stack:** React 18 · TypeScript · Vite · Capacitor (Android) · Zustand · Supabase

---

## Features

- **Today** — what's scheduled, single-tap Start → fullscreen "Lock In" workout view
- **Lock In view** — sticky always-present rest-timer bar with auto-fire on set completion, ±15s adjusters, urgent pulse at ≤5s; tap-to-complete set numbers; tabular numerics; industrial-brutalist aesthetic
- **Program editor** — programs → phases (accumulation / intensification / peaking / deload) → sessions → exercises with targets (sets, reps, RPE, weight, rest)
- **Auto-progression** — hit the top of the rep range across all sets within RPE budget → app offers a +2.5/+5kg bump on finish
- **Stall detection** — flags 3-session plateaus per exercise; suggests deload
- **Injury restrictions** — pattern-level or exercise-level gating with override; surfaces contextual warnings in the workout view
- **Vertical jump log** — sport-specific metric for offseason tracking
- **140+ built-in exercises** seeded on first launch, filterable by movement pattern / equipment / muscle
- **Nexus Command Center sync** — pushes finished sessions to a shared Supabase project via fire-and-forget; offline retry queue drains on next connection
- **Email/password or Google OAuth** auth (PKCE flow, works on both web and Android via deep-link callback)
- **Local notifications** — weekly day-of reminders at 09:00 for sessions on the active program

---

## Download

[<img src="https://f-droid.org/badge/get-it-on.png"
     alt="Get it on F-Droid"
     height="80">](https://f-droid.org/packages/com.limecore.workouttracker/)

Or download the latest APK from the [Releases Section](https://github.com/Limecore-Studio/limelog/releases/latest).

---

## Setup

```bash
npm install
cp .env.example .env  # then fill in your Supabase URL + anon key
npm run dev
```

App runs at `http://localhost:5173`.

### Environment

`.env`:

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-key>
```

Sync is optional — without these, the app still works fully offline against `localStorage`.

---

## Build

```bash
npm run build       # tsc + vite build → dist/
npm run preview
```

---

## Android (Capacitor)

```bash
npm run build
npx cap sync android
npx cap open android   # opens the project in Android Studio
```

For Google OAuth on Android, the deep-link `com.limecore.workouttracker://auth/callback` is already wired in `AndroidManifest.xml`. Add it to your Supabase project's redirect-URL allowlist (Authentication → URL Configuration).

To regenerate launcher icons + splash screens from `assets/icon.png`:

```bash
npx capacitor-assets generate --android
```

---

## Architecture

```
src/
├── App.tsx              # Routes (TodayPage, WorkoutPage, etc.), Nexus init, online-event drain
├── pages/               # Today, Program, Library, Progress, Profile, Workout (fullscreen)
├── components/          # ExerciseBlock, SessionEditor, WeightUpModal, NexusSyncCard, …
├── store/               # Zustand stores
│   ├── programStore.ts  # Programs, phases, sessions, exercises (CRUD)
│   ├── logStore.ts      # Session logs + sets; pushes to Nexus on finalize
│   ├── userStore.ts     # Profile, injury restrictions, deload thresholds
│   └── nexusStore.ts    # Supabase auth, sync state, pending queue count
├── lib/
│   ├── supabase.ts      # Supabase client (PKCE, persistSession)
│   ├── nexusSync.ts     # push function, mapper, retry queue
│   └── oauth.ts         # Google sign-in (web redirect + Capacitor deep-link)
├── data/
│   └── builtinExercises.ts   # 140+ pre-seeded exercises
├── utils/               # localStorage helpers, notification scheduling, audio
└── types/               # Program, logging, user TS types
```

---

## Nexus Command Center sync

When you finish a workout, the session + sets are pushed to the shared Supabase project's `workout_sessions` and `workout_sets` tables, with `user_id` set to your authenticated user (RLS enforced). The push is fire-and-forget — it never blocks the local save. Failures queue in `localStorage` (`wt_nexus_pending`) and drain on next app start, on `online` event, or via "Retry now" in Profile → Settings → Nexus sync.

Schema is fixed by the Nexus side; the integration brief lives outside this repo (Nexus consumes the same data via Realtime).

---

## Support

Limelog is free, open source and ad-free. If it's useful to you, you can support development on Ko-fi — it goes straight back into building the suite.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/J6K8240SNW)

## License

Personal project — no license declared.
