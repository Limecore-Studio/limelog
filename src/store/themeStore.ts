import { create } from 'zustand';
import { storage } from '@/utils/storage';
import { isEntitled, refreshEntitlement } from '@/lib/entitlement';
import type { ThemeId } from '@/types/theme';

// Re-exported so `ThemeId` stays importable from the store, which is where a
// theme-aware component would look for it first. The declaration moved to
// `@/types/theme` so `utils/storage.ts` can read it without importing a store;
// see that file for why the direction of that edge matters.
export type { ThemeId };

/** Free tier. Anything not listed here needs an entitlement. */
const FREE_THEMES: ThemeId[] = ['lime'];

export const THEME_IDS: ThemeId[] = ['lime', 'cast-iron'];

export function isPaidTheme(theme: ThemeId): boolean {
  return !FREE_THEMES.includes(theme);
}

/**
 * The free theme is the ABSENCE of an override, not an override of its own:
 * with `[data-theme]` unset the app must render byte-identically to `main`,
 * and that is the paid theme's regression gate. So `lime` removes the
 * attribute rather than setting a third value.
 */
function apply(theme: ThemeId): void {
  const el = document.documentElement;
  if (theme === 'lime') delete el.dataset.theme;
  else el.dataset.theme = theme;
  applyChrome();
}

/**
 * Repoint the `theme-color` meta at whatever `--bg-base` now resolves to.
 *
 * Android tints the system bars from this. It was a hardcoded `#0d0f11` in
 * index.html — the free theme's base — so without this Cast Iron would paint
 * the whole app warm and leave a cold near-black strip along the top of the
 * screen, which reads as a rendering bug rather than a theme.
 *
 * Read from the cascade rather than a table in this file: the value then
 * comes from whichever stylesheet actually won, and a theme that changes its
 * base colour needs no edit here.
 */
function applyChrome(): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim();
  if (bg) meta.setAttribute('content', bg);
}

interface ThemeState {
  theme: ThemeId;
  /** True when the user holds a current supporter entitlement. */
  entitled: boolean;
  setTheme: (theme: ThemeId) => void;
  setEntitled: (entitled: boolean) => void;
  /** Re-read entitlement from the server and re-resolve the theme. */
  syncEntitlement: (
    userId: string | null | undefined,
    opts?: { force?: boolean },
  ) => Promise<void>;
}

/**
 * Reads the stored theme and applies it to <html>. Call from `src/main.tsx`
 * BEFORE ReactDOM.render — doing it in an effect paints lime for a frame and
 * then flips, which is very visible on a cold Android start.
 *
 * Entitlement comes from the local cache here, deliberately: this pass has to
 * be synchronous, and the cache is what the previous session's server check
 * left behind. The store re-checks against the server once auth resolves.
 */
/**
 * The stored theme, gated on entitlement. Pure: reads storage and the cached
 * entitlement, touches no DOM.
 *
 * ── Why this is separate from `bootstrapTheme` (v1.13 review) ───────────
 *
 * The store used to initialise `theme` by reading
 * `document.documentElement.dataset.theme`. Zustand's `create()` runs at
 * IMPORT time, and `main.tsx` imports this module in order to call
 * `bootstrapTheme()` — so the read happened before the attribute was set,
 * every time. A Cast Iron supporter got a Cast Iron-painted app whose store
 * said `lime`: the plate bay, the theme's headline feature, never rendered,
 * and the picker showed Lime as the active row. It self-healed only if they
 * re-tapped the theme.
 *
 * Both the store and `bootstrapTheme` now derive from this one function, so
 * they agree no matter which runs first — the DOM is an output of the
 * resolution, never an input to it.
 */
function resolveStoredTheme(): ThemeId {
  let stored: ThemeId = 'lime';
  try {
    const raw = storage.getTheme();
    if (raw === 'cast-iron' || raw === 'lime') stored = raw;
  } catch {
    /* storage unavailable — the free theme is the right fallback */
  }
  return !isPaidTheme(stored) || isEntitled() ? stored : 'lime';
}

export function bootstrapTheme(): ThemeId {
  const theme = resolveStoredTheme();
  apply(theme);
  return theme;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: resolveStoredTheme(),
  entitled: isEntitled(),

  setTheme: (theme) => {
    // Checked here as well as by the picker's `disabled` attribute, because a
    // disabled attribute is a UI affordance and not a check.
    if (isPaidTheme(theme) && !get().entitled) return;
    apply(theme);
    try {
      storage.setTheme(theme);
    } catch {
      /* the choice just won't survive a relaunch */
    }
    set({ theme });
  },

  setEntitled: (entitled) => {
    set({ entitled });
    // Losing entitlement (a lapse, a refund, a reinstall on a fresh account)
    // must not leave the app sitting in a paid theme.
    //
    // v1.19 (LimeLog#67 review): shown, not saved. A cold start whose token
    // refresh was refused emits SIGNED_OUT, which lands here as `false`, and
    // the NCC inherit signs the user back in a moment later. Saving 'lime'
    // here lost a supporter's chosen theme for good on that path. The stored
    // choice stays; resolveStoredTheme() already refuses a paid theme without
    // entitlement, and the theme comes back when the entitlement does.
    if (!entitled && isPaidTheme(get().theme)) {
      apply('lime');
      set({ theme: 'lime' });
      return;
    }
    if (entitled) {
      const stored = resolveStoredTheme();
      if (stored !== get().theme && isPaidTheme(stored)) {
        apply(stored);
        set({ theme: stored });
      }
    }
  },

  // `force` skips the six-hour cache. The caller that needs it is sign-in: a
  // supporter who was signed out moments ago has a fresh "not entitled"
  // answer cached, and serving that would hide the perk they just paid for
  // until the cache aged out.
  syncEntitlement: async (userId, opts) => {
    const ok = await refreshEntitlement(userId, opts);
    get().setEntitled(ok);
  },
}));
