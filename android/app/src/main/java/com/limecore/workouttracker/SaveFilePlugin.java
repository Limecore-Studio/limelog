package com.limecore.workouttracker;

// v1.21.1 (limecore#103) — save a file where the user chooses.
//
// "Export my data" built a blob: URL and clicked an anchor. A WebView has no
// download handling unless the app registers a DownloadListener, and none was,
// so on Android nothing was written while the app said "Saved". This opens the
// system "create document" picker (Storage Access Framework) and writes the
// text to the document the user picks. No storage permission is needed, and no
// new dependency: the F-Droid recipe and the reproducible build are unchanged.
//
// v1.22 (limelog#126): encoding: "base64" writes `data` decoded, for a JPEG
// (a progress photo copy); text otherwise.
//
// save({ filename, mimeType, data, encoding? }) resolves:
//   { saved: true }                     — written
//   { saved: false, cancelled: true }   — the user backed out of the picker
//   { saved: false, interrupted: true } — v1.22 (limelog#136): Android killed
//       LimeLog while the picker was open, so the text was gone when the
//       result came back. The empty document the picker created is removed,
//       and the result reaches JS as App's `appRestoredResult` event
//       (lib/restoredResult.ts), which tells the user to tap Export again.
// and rejects when the document could not be written.
//
// v1.22 (limelog#136): the text is held in this plugin instance, not in the
// call. Capacitor writes a started Activity's call options into the saved
// instance state, and an export can be megabytes: a Bundle that size fails
// with TransactionTooLargeException when LimeLog goes to the background.

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    /** The text of the save in progress. Lost with the process, on purpose. */
    private String pendingData;
    private boolean pendingBase64;

    @PluginMethod
    public void save(PluginCall call) {
        String filename = call.getString("filename");
        String data = call.getString("data");
        if (filename == null || filename.isEmpty() || data == null) {
            call.reject("filename and data are required");
            return;
        }
        String mimeType = call.getString("mimeType", "application/json");
        pendingData = data;
        pendingBase64 = "base64".equals(call.getString("encoding"));
        call.getData().remove("data");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, filename);
        startActivityForResult(call, intent, "onDocumentPicked");
    }

    @ActivityCallback
    private void onDocumentPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject out = new JSObject();
        Intent picked = result.getData();
        Uri uri = picked != null ? picked.getData() : null;
        String data = pendingData;
        pendingData = null;
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            out.put("saved", false);
            out.put("cancelled", true);
            call.resolve(out);
            return;
        }
        if (data == null) {
            // Restored after process death: nothing to write. Do not leave the
            // empty file the picker created behind.
            try {
                DocumentsContract.deleteDocument(getContext().getContentResolver(), uri);
            } catch (Exception ignored) {
                // Best effort: some providers do not support delete.
            }
            out.put("saved", false);
            out.put("interrupted", true);
            call.resolve(out);
            return;
        }
        // "wt": truncate, so picking an existing file replaces it rather than
        // leaving the tail of a longer old export behind.
        //
        // v1.22 (as StudyDesk#320) — the picker has already created an EMPTY
        // file. The text is streamed in 64 KB chunks (no second full copy via
        // getBytes), off the main thread (an export can be several MB and a
        // cloud provider's stream may block), and ANY failure, OutOfMemoryError
        // included (an Error, which catch (Exception) let kill the write
        // silently), removes that empty file and rejects, so the app says the
        // export failed instead of leaving a blank file behind.
        final boolean base64 = pendingBase64;
        new Thread(() -> {
            boolean ok = false;
            try (OutputStream os = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (os == null) throw new java.io.IOException("could not open the chosen file");
                if (base64) {
                    os.write(Base64.decode(data, Base64.DEFAULT));
                } else {
                    java.io.Writer w = new java.io.BufferedWriter(new java.io.OutputStreamWriter(os, StandardCharsets.UTF_8), 64 * 1024);
                    int step = 64 * 1024;
                    for (int i = 0; i < data.length(); i += step) {
                        w.write(data, i, Math.min(step, data.length() - i));
                    }
                    w.flush();
                }
                os.flush();
                ok = true;
            } catch (Throwable e) {
                ok = false;
            }
            if (ok) {
                out.put("saved", true);
                call.resolve(out);
            } else {
                try {
                    DocumentsContract.deleteDocument(getContext().getContentResolver(), uri);
                } catch (Throwable ignored) {
                    // Best effort: some providers do not support delete.
                }
                call.reject("Could not write the file.");
            }
        }).start();
    }
}
