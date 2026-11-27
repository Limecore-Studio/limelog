import { defineConfig } from 'vitest/config';
import path from 'path';

// Separate from `vite.config.ts` so a Node-side unit run does not pull in the
// Capacitor build shape. Tests here are pure logic only (v1.16, limecore#11) —
// no jsdom, no component rendering.
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.mjs'],
  },
});
