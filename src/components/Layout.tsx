import { lazy, Suspense } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { PolicyUpdatedNote } from '@/components/PolicyUpdatedNote';
import { useTranslation } from 'react-i18next';
import { Calendar, BarChart2, Layers, BookOpen, Scale } from 'lucide-react';
import { useUserStore } from '@/store/userStore';
import { useNexusStore } from '@/store/nexusStore';
import './Layout.css';
import { OptionalChunk } from '@/components/OptionalChunk';

// v1.18.1 (LimeLog#70) — out of the startup chunk. It renders nothing until a
// check that runs 4 s after mount finds a newer build, so it never needed to
// be in the first paint.
const FdroidUpdateNote = lazy(() => import('@/components/FdroidUpdateNote').then((m) => ({ default: m.FdroidUpdateNote })));

// v1.7 — labels resolved via i18n at render time (labelKey → t()).
const NAV_ITEMS = [
  { to: '/today',    icon: Calendar,  labelKey: 'nav.today'    },
  { to: '/program',  icon: Layers,    labelKey: 'nav.program'  },
  { to: '/library',  icon: BookOpen,  labelKey: 'nav.library'  },
  { to: '/progress', icon: BarChart2, labelKey: 'nav.progress' },
  // v1.3 BUG-19 — body metrics promoted from a ProgressPage tab to its own
  // first-class destination (LimeLog is the sole owner after NCC's cut).
  { to: '/body',     icon: Scale,     labelKey: 'nav.body'     },
  // v1.4.1 — Profile/Settings moved off the bottom bar to the top-right avatar
  // (matches NCC + StudyDesk). The /profile route still exists.
] as const;

// Initials for the top-right avatar.
//
// Used to read the local profile name only, which defaults to "Athlete" — so a
// signed-in user saw "AT", a placeholder, while NCC showed their real initials
// and StudyDesk showed theirs. Now: a name the user actually chose wins, then
// the identity provider's name, then the address. Keep in step with NCC
// `userInitials` (store/useSessionStore.ts) and StudyDesk `avatarInitials`
// (lib/avatarInitials.js).
const DEFAULT_PROFILE_NAME = 'Athlete';

function initialsFromWords(parts: string[]): string | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** null when there is nothing to show — the caller renders the silhouette.
 *  Deliberately not exported: this file exports a component, and the repo lints
 *  at --max-warnings 0, where react-refresh/only-export-components rejects a
 *  module exporting both. StudyDesk hit the same rule and split its copy into
 *  lib/avatarInitials.js; here there is one caller, so keeping it local is the
 *  smaller change. Split it out if a second caller ever appears. */
function avatarInitials(
  profileName: string,
  userName: string | null,
  userEmail: string | null,
): string | null {
  // Only a *deliberate* local name outranks the account; the stock one does not.
  const chosen = (profileName || '').trim();
  if (chosen && chosen !== DEFAULT_PROFILE_NAME) {
    return initialsFromWords(chosen.split(/\s+/).filter(Boolean));
  }
  const provided = (userName || '').trim();
  if (provided) return initialsFromWords(provided.split(/\s+/).filter(Boolean));

  const local = (userEmail || '').split('@')[0] || '';
  if (!local) return null;
  const parts = local.split(/[.\-_]+/).filter(Boolean);
  return initialsFromWords(parts) || local.slice(0, 2).toUpperCase() || null;
}

/** Anonymous-profile silhouette, matching StudyDesk's. Replaces the "·" this
 *  showed for a nameless guest — the same interpunct StudyDesk removed in
 *  SD-F3 once it was clear half the userbase never signs in and saw it on
 *  every screen. Sized in `em` so it inherits the avatar's type size. */
function GuestAvatar() {
  return (
    <svg
      viewBox="0 0 32 32"
      width="1.15em"
      height="1.15em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="16" cy="11.5" r="5.5" />
      <path d="M6.5 26.5v-1.8c0-3.1 2.5-5.6 5.6-5.6h7.8c3.1 0 5.6 2.5 5.6 5.6v1.8" />
    </svg>
  );
}

export function Layout() {
  const { t } = useTranslation();
  const name = useUserStore((s) => s.profile.name);
  const userName = useNexusStore((s) => s.userName);
  const userEmail = useNexusStore((s) => s.userEmail);
  const initials = avatarInitials(name, userName, userEmail);
  return (
    <div className="app-shell">
      {/* v1.16 (limecore#16) — once, for people who used LimeLog under the old
          policy. In Layout, so it never appears on the fullscreen workout. */}
      <PolicyUpdatedNote />
      <header className="app-topbar">
        <NavLink
          to="/profile"
          className={({ isActive }) => `app-avatar${isActive ? ' app-avatar--active' : ''}`}
          aria-label={t('nav.profileSettings')}
          title={t('nav.profileSettings')}
        >
          {initials ?? <GuestAvatar />}
        </NavLink>
      </header>
      <main className="app-main">
        {/* v1.16 (#26) — Android only, once a day, off in Settings. Renders
            nothing unless F-Droid has a newer build than this one. */}
        <OptionalChunk>
          <FdroidUpdateNote />
        </OptionalChunk>
        {/* v1.17 (limecore#13) — pages are lazy chunks; the boundary sits
            inside the layout so the bottom nav stays put while one loads. */}
        <Suspense fallback={null}>
          <Outlet />
        </Suspense>
      </main>
      <nav className="app-nav">
        {NAV_ITEMS.map(({ to, icon: Icon, labelKey }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `nav-item${isActive ? ' nav-item--active' : ''}`}>
            <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
            <span className="nav-item__label">{t(labelKey)}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
