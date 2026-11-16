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
// save({ filename, mimeType, data }) resolves:
//   { saved: true }                   — written
//   { saved: false, cancelled: true } — the user backed out of the picker
// and rejects when the document could not be written.
//
// Known gap (same as LimeLog#125 for the camera): if Android kills the process
// while the picker is open, the result has no call to return to and is lost;
// the user taps Export again.

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

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

    @PluginMethod
    public void save(PluginCall call) {
        String filename = call.getString("filename");
        String data = call.getString("data");
        if (filename == null || filename.isEmpty() || data == null) {
            call.reject("filename and data are required");
            return;
        }
        String mimeType = call.getString("mimeType", "application/json");
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
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            out.put("saved", false);
            out.put("cancelled", true);
            call.resolve(out);
            return;
        }
        String data = call.getString("data", "");
        // "wt": truncate, so picking an existing file replaces it rather than
        // leaving the tail of a longer old export behind.
        try (OutputStream os = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            if (os == null) throw new java.io.IOException("could not open the chosen file");
            os.write(data.getBytes(StandardCharsets.UTF_8));
            os.flush();
            out.put("saved", true);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Could not write the file: " + e.getMessage());
        }
    }
}
