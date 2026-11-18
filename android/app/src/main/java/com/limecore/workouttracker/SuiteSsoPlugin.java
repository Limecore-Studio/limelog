package com.limecore.workouttracker;

// v1.4 cross-app SSO consumer (sister-app side).
//
// Queries NCC's SessionContentProvider via ContentResolver to inherit NCC's
// Supabase session without a separate sign-in. The provider is at:
//   content://com.limecore.nexus.session/current
//
// ACCESS MODEL (corrected in the v1.7 audit — see the SECURITY MODEL header
// in NCC's SessionContentProvider.java for the authoritative version):
// The provider is guarded by an APPLICATION-LAYER package allowlist, NOT an
// OS permission. NCC's v1.1 BUG-1 fix REMOVED the original signature-level
// permission (com.limecore.nexus.permission.READ_SESSION) because debug
// builds across the three separate Studio projects didn't reliably share a
// signing cert, so the OS permission check failed and SSO silently broke.
// NCC now checks getCallingPackage() against a hardcoded suite allowlist and
// returns an EMPTY cursor to any caller not on it. Accordingly this app
// declares ONLY a <queries><provider authorities="com.limecore.nexus.session"/>
// entry (for Android 11+ package visibility) in its manifest — there is NO
// <uses-permission> and none is required. (It said here that package-name
// uniqueness was the trust anchor. It is not — names are unique per device
// only. Since v1.16, limecore#35, both sides also check the suite signing
// key: NCC checks this app, and isGenuineNexus() below checks NCC.)
//
// Returned data is the JSON bundle NCC published — see ssoPublisher.ts on
// the NCC side for the shape:
//   { access_token, refresh_token, expires_at, user_id, email }
//
// This plugin is purely a one-shot read. The JS side decides what to do
// with the bundle (typically: supabase.auth.setSession to inherit the
// session). When NCC isn't installed, or the caller isn't allowlisted,
// query() returns null/empty and the JS side falls back to normal sign-in.

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "SuiteSso")
public class SuiteSsoPlugin extends Plugin {

    private static final Uri SESSION_URI =
        Uri.parse("content://com.limecore.nexus.session/current");

    private static final String COL_BUNDLE = "session_bundle_json";
    private static final String COL_PUBLISHED_AT = "published_at";

    private static final String NEXUS_PACKAGE = "com.limecore.nexus";

    /**
     * v1.16 (limecore#35, SSO-1) — take a session only from the real NCC.
     * An authority is unique per device, not globally: on a phone without
     * NCC, any app can declare `com.limecore.nexus.session` and hand this app
     * an attacker's session, after which everything the user records goes to
     * the attacker's account. The provider must be served by NCC's package
     * and signed with this app's own key (all three suite apps share the one
     * release key). Skipped in a debuggable build, whose key differs from the
     * other projects' — the same exception NCC's provider makes.
     */
    private boolean isGenuineNexus() {
        Context ctx = getContext();
        PackageManager pm = ctx.getPackageManager();
        ProviderInfo info = pm.resolveContentProvider(SESSION_URI.getAuthority(), 0);
        if (info == null || !NEXUS_PACKAGE.equals(info.packageName)) return false;
        if ((ctx.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) return true;
        return pm.checkSignatures(ctx.getPackageName(), info.packageName) == PackageManager.SIGNATURE_MATCH;
    }

    /**
     * v1.21.1 (limecore#101) — open NCC, so it publishes a fresh session.
     *
     * NCC republishes its session only while it runs, and the JS side no
     * longer sends a published session that has expired. "Open Nexus once,
     * then come back" is the way back to a one-tap sign-in. Only the genuine
     * NCC is opened (same check as the session read). Resolves
     * { opened: boolean }; never rejects.
     */
    @PluginMethod
    public void openNexus(PluginCall call) {
        JSObject result = new JSObject();
        boolean opened = false;
        try {
            if (isGenuineNexus()) {
                Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(NEXUS_PACKAGE);
                if (launch != null) {
                    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(launch);
                    opened = true;
                }
            }
        } catch (Exception ignored) {
            opened = false;
        }
        result.put("opened", opened);
        call.resolve(result);
    }

    /**
     * Query NCC's SessionContentProvider.
     *
     * Resolves with:
     *   { available: true,  bundle: {access_token, refresh_token, ...},
     *     publishedAt: number }
     *   when NCC is installed, signature matches, and a session is published.
     *
     *   { available: false, reason: "..." }
     *   when NCC isn't installed, the permission was denied, or no session
     *   has been published yet. `reason` lets the JS-side UI flash a helpful
     *   message ("Install Nexus Command Center" / "Sign in to Nexus first").
     *
     * Never rejects the PluginCall — every failure mode flows through the
     * `available: false` branch so JS doesn't need a try/catch.
     */
    @PluginMethod
    public void getNexusSession(PluginCall call) {
        JSObject result = new JSObject();
        ContentResolver resolver = getContext().getContentResolver();
        Cursor cursor = null;
        try {
            if (!isGenuineNexus()) {
                result.put("available", false);
                result.put("reason", "Nexus Command Center not reachable (not installed, or not a genuine suite build).");
                call.resolve(result);
                return;
            }
            cursor = resolver.query(SESSION_URI, null, null, null, null);
            if (cursor == null) {
                // Null cursor means the provider wasn't reachable — NCC not
                // installed, or the provider crashed/was unavailable. (A caller
                // that isn't on NCC's package allowlist gets an EMPTY cursor,
                // handled by the moveToFirst() branch below — not null.)
                result.put("available", false);
                result.put("reason", "Nexus Command Center not reachable (not installed).");
                call.resolve(result);
                return;
            }
            if (!cursor.moveToFirst()) {
                // Provider responded but published no row — NCC is installed
                // but the user hasn't signed in yet (or signed out).
                result.put("available", false);
                result.put("reason", "Sign in to Nexus Command Center first.");
                call.resolve(result);
                return;
            }
            int bundleIdx = cursor.getColumnIndex(COL_BUNDLE);
            int publishedAtIdx = cursor.getColumnIndex(COL_PUBLISHED_AT);
            String bundleJson = bundleIdx >= 0 ? cursor.getString(bundleIdx) : null;
            long publishedAt = publishedAtIdx >= 0 ? cursor.getLong(publishedAtIdx) : 0L;
            if (bundleJson == null || bundleJson.isEmpty()) {
                result.put("available", false);
                result.put("reason", "Nexus has no active session.");
                call.resolve(result);
                return;
            }
            result.put("available", true);
            result.put("bundleJson", bundleJson);
            result.put("publishedAt", publishedAt);
            call.resolve(result);
        } catch (SecurityException se) {
            // Should never reach here — the OS would block the query before
            // returning a cursor — but defensively handle it.
            result.put("available", false);
            result.put("reason", "Permission denied: signing cert mismatch.");
            call.resolve(result);
        } catch (Exception e) {
            result.put("available", false);
            result.put("reason", "Query failed: " + e.getMessage());
            call.resolve(result);
        } finally {
            if (cursor != null) {
                try { cursor.close(); } catch (Exception ignored) { /* */ }
            }
        }
    }
}
