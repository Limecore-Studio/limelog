import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import type { Plugin } from 'vite'

// v1.22 (limecore#99) — a Content-Security-Policy, as NCC ships one: a
// backstop that stops an injected script from loading code or sending the
// session anywhere LimeLog does not talk to. Added at build time only: the
// Vite dev server needs an inline preamble and a websocket that it forbids.
// Exactly what the app contacts:
//   - Supabase (REST, auth, realtime): https and wss on *.supabase.co;
//   - Google's Gemini API, on the user's own key (limecore#122);
//   - hCaptcha, loaded on demand for the sign-up check (lib/captcha.ts): its
//     script, frame, requests and styles, per hCaptcha's CSP guidance.
// Fonts are self-hosted; progress photos are data: and blob: images, and
// account avatars may be any https image. The F-Droid check goes through
// native HTTP (CapacitorHttp), outside the WebView's CSP. Inline styles stay
// allowed (React style props and hCaptcha's widget); inline and eval'd
// scripts do not.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://js.hcaptcha.com https://*.hcaptcha.com",
  "style-src 'self' 'unsafe-inline' https://*.hcaptcha.com",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://generativelanguage.googleapis.com https://*.hcaptcha.com",
  "frame-src https://*.hcaptcha.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'limelog-csp',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
    ],
  }
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // v1.17 (limecore#12): console.log/info/debug land in Android logcat, which
  // other tools on the device can read. Production builds drop them; warn and
  // error stay for diagnosis. Vite sets NODE_ENV to production for a build.
  esbuild: process.env.NODE_ENV === 'production'
    ? { pure: ['console.log', 'console.info', 'console.debug'], drop: ['debugger'] }
    : undefined,
})
