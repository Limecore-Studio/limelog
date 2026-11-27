package com.limecore.workouttracker;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // v1.4 — register the SuiteSso plugin so the JS layer can query
        // NCC's SessionContentProvider for shared sign-in. Must register
        // BEFORE super.onCreate so the Capacitor bridge picks it up
        // during initial setup.
        registerPlugin(SuiteSsoPlugin.class);
        // v1.21.1 (limecore#103) — "Export my data" writes a real file.
        registerPlugin(SaveFilePlugin.class);
        // v1.22 (limecore#127) — the rest notification's Skip / +30 s. A tap
        // that launched the app is queued before the bridge starts.
        registerPlugin(RestTimerPlugin.class);
        RestTimerPlugin.takeAction(getIntent(), true);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        // A tap while the app is running: handled now, and kept from
        // Capacitor's own deep-link handling.
        if (RestTimerPlugin.takeAction(intent, false)) {
            setIntent(intent);
            return;
        }
        super.onNewIntent(intent);
    }
}
