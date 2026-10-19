package com.emil.stupidbuddy;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowInsets;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/** The Stupid Buddy for Android: the Mac app's screens (ui/) in a web view, served from inside the app.
 *  Bridge.java does the phone things (online AI with your key, folders you allow, the web). */
public final class MainActivity extends Activity {
    static final String ORIGIN = "https://appassets.androidplatform.net";
    WebView web;
    Bridge bridge;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        web = new WebView(this);
        boolean night = (getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        web.setBackgroundColor(night ? 0xFF1F1E1D : 0xFFFAF9F5);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);
        bridge = new Bridge(this);
        web.addJavascriptInterface(bridge, "StupidBuddyNative");
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) { return serve(r.getUrl()); }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (ORIGIN.equals(u.getScheme() + "://" + u.getHost())) return false;
                if ("https".equals(u.getScheme())) bridge.openLink(u.toString());   // links in Buddy's answers open in the browser
                return true;
            }
            @Override public void onPageFinished(WebView v, String url) { shared(getIntent()); }
        });
        web.setOnApplyWindowInsetsListener((v, insets) -> {   // edge to edge: keep clear of the bars and the keyboard
            Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsets.CONSUMED;
        });
        setContentView(web);
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        web.loadUrl(ORIGIN + "/ui/index.html");
    }

    boolean isOwnPage() { String u = web.getUrl(); return u != null && u.startsWith(ORIGIN + "/"); }
    void js(String code) { if (web != null) web.evaluateJavascript(code, null); }

    /** The app's own files (assets/ui), with the phone bridge loaded before the page's scripts. */
    private WebResourceResponse serve(Uri u) {
        Map<String, String> h = new HashMap<>(); h.put("Cache-Control", "no-cache");
        if (!ORIGIN.equals(u.getScheme() + "://" + u.getHost())) return null;
        String path = u.getPath() == null ? "" : u.getPath().replaceFirst("^/", "");
        if (path.contains("..") || !path.startsWith("ui/")) return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", h, new ByteArrayInputStream(new byte[0]));
        try {
            InputStream in = getAssets().open(path);
            String type = path.endsWith(".html") ? "text/html" : path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".ttf") ? "font/ttf" : path.endsWith(".png") ? "image/png" : "application/octet-stream";
            if (path.equals("ui/index.html")) {
                ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] b = new byte[16384]; int n; while ((n = in.read(b)) > 0) out.write(b, 0, n); in.close();
                String html = out.toString("UTF-8")
                    .replace("<head>", "<head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover\">")
                    .replace("<script src=\"ai.js\">", "<script src=\"android.js\"></script><script src=\"ai.js\">")
                    .replace("connect-src http://localhost:11434 http://127.0.0.1:11434", "connect-src 'none'");
                in = new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8));
            }
            return new WebResourceResponse(type, type.startsWith("text/") ? "utf-8" : null, 200, "OK", h, in);
        } catch (Exception e) { return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", h, new ByteArrayInputStream(new byte[0])); }
    }

    /** Text or a link shared to Buddy from another app: put it in the box to ask about. */
    private void shared(Intent i) {
        if (i == null || !Intent.ACTION_SEND.equals(i.getAction())) return;
        String t = i.getStringExtra(Intent.EXTRA_TEXT);
        if (t == null || t.trim().isEmpty()) return;
        setIntent(new Intent());
        js("(() => { const i = document.getElementById('input'); i.value = " + JSONObject.quote(t.trim().length() > 4000 ? t.trim().substring(0, 4000) : t.trim()) + "; i.focus(); i.dispatchEvent(new Event('input')); })()");
    }
    @Override protected void onNewIntent(Intent i) { super.onNewIntent(i); setIntent(i); shared(i); }

    private void back() {
        web.evaluateJavascript("(() => { const s = document.getElementById('settings'); if (!s.classList.contains('hidden')) { document.getElementById('setDone').click(); return 'ui'; } return ''; })()", r -> {
            if (!"\"ui\"".equals(r)) moveTaskToBack(true);
        });
    }
    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { back(); }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        if (req == Bridge.PICK_FOLDER) { bridge.folderPicked(res == RESULT_OK && data != null ? data.getData() : null); return; }
        super.onActivityResult(req, res, data);
    }
    @Override protected void onDestroy() { if (web != null) { web.removeJavascriptInterface("StupidBuddyNative"); web.destroy(); web = null; } super.onDestroy(); }
}
