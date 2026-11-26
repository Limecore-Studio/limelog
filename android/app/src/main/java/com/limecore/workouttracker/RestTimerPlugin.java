package com.limecore.workouttracker;

// v1.22 (limecore#127 item 4) — the rest timer as an ongoing notification,
// with Skip and +30 s, while a rest runs.
//
// The rest's state lives in the WebView (localStorage `wt_active_rest`), so
// only JS can apply a button. Each button's PendingIntent opens MainActivity
// with the action as an extra, as StudyDesk's focus chip does (#295): an
// activity is what reliably brings a killed process back with its WebView.
// MainActivity hands the action here: queued when it arrives with the launch
// (cold start), emitted as `restAction` when the app is already running.
// Each tap is handled once (the extra is removed from the intent).
//
// The countdown is Android's own chronometer (setUsesChronometer, counting
// down to `endsAt`), so it keeps time with the app in the background or
// killed, and setTimeoutAfter removes the notification when the rest ends.
//
// show({ endsAt, title, skipLabel, plusLabel }) posts or replaces it;
// hide() removes it; consumeActions() returns actions queued at launch.

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "RestTimer")
public class RestTimerPlugin extends Plugin {

    static final String EXTRA_ACTION = "limelog_rest_action";
    private static final String CHANNEL_ID = "limelog_rest";
    private static final int NOTIFICATION_ID = 7301;

    /** Actions that arrived with the launch intent, before JS was listening. */
    private static final List<String> queued = new ArrayList<>();
    private static RestTimerPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    /** From MainActivity, for an intent carrying a rest action. Returns true
     *  when it was one (and removes the extra, so it is handled once). */
    static boolean takeAction(Intent intent, boolean coldStart) {
        if (intent == null) return false;
        String action = intent.getStringExtra(EXTRA_ACTION);
        if (action == null) return false;
        intent.removeExtra(EXTRA_ACTION);
        if (coldStart || instance == null) {
            synchronized (queued) {
                queued.add(action);
            }
        } else {
            JSObject data = new JSObject();
            data.put("action", action);
            instance.notifyListeners("restAction", data, true);
        }
        return true;
    }

    @PluginMethod
    public void consumeActions(PluginCall call) {
        JSArray out = new JSArray();
        synchronized (queued) {
            for (String a : queued) out.put(a);
            queued.clear();
        }
        JSObject ret = new JSObject();
        ret.put("actions", out);
        call.resolve(ret);
    }

    @PluginMethod
    public void show(PluginCall call) {
        Long endsAt = call.getLong("endsAt");
        String title = call.getString("title", "");
        String skip = call.getString("skipLabel", "Skip");
        String plus = call.getString("plusLabel", "+30 s");
        if (endsAt == null) {
            call.reject("endsAt is required");
            return;
        }
        long left = endsAt - System.currentTimeMillis();
        Context ctx = getContext();
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        if (left <= 0) {
            nm.cancel(NOTIFICATION_ID);
            call.resolve();
            return;
        }
        ensureChannel(ctx);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(ctx.getApplicationInfo().icon)
            .setContentTitle(title)
            .setWhen(endsAt)
            .setShowWhen(true)
            .setUsesChronometer(true)
            .setChronometerCountDown(true)
            .setTimeoutAfter(left)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(activityIntent(ctx, null, 0))
            .addAction(0, skip, activityIntent(ctx, "skip", 1))
            .addAction(0, plus, activityIntent(ctx, "plus30", 2));
        try {
            nm.notify(NOTIFICATION_ID, b.build());
        } catch (SecurityException e) {
            // Notifications not allowed (Android 13+ permission refused): the
            // rest still runs in the app; nothing to show.
        }
        call.resolve();
    }

    @PluginMethod
    public void hide(PluginCall call) {
        NotificationManagerCompat.from(getContext()).cancel(NOTIFICATION_ID);
        call.resolve();
    }

    private static PendingIntent activityIntent(Context ctx, String action, int requestCode) {
        Intent i = new Intent(ctx, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (action != null) i.putExtra(EXTRA_ACTION, action);
        return PendingIntent.getActivity(
            ctx,
            7300 + requestCode,
            i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
            CHANNEL_ID,
            ctx.getString(R.string.rest_channel_name),
            NotificationManager.IMPORTANCE_LOW
        );
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }
}
