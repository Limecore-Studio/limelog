import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.limecore.workouttracker',
  appName: 'LimeLog',
  webDir: 'dist',
  // v1.22 (limelog#156): LimeLog is dark-only. DEFAULT follows the system, so
  // in light mode the status-bar icons were dark on near-black. DARK is the
  // style for dark backgrounds (light icons): SystemBars.java sets
  // setAppearanceLightStatusBars(!DARK).
  plugins: { SystemBars: { style: 'DARK' } },
};

export default config;
