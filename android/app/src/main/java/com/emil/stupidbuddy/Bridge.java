package com.emil.stupidbuddy;

import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** What Buddy's screens ask the phone for (the same messages as the Mac app's main.swift and Tools.swift).
 *  Only the app's own page can call it. Your AI key lives in the Android Keystore and is added here, so the
 *  page never sees it. */
final class Bridge {
    static final int PICK_FOLDER = 21;
    interface Done { void done(boolean ok, Object value); }
    private final MainActivity app;
    private final Folders folders;
    private final ExecutorService work = Executors.newCachedThreadPool();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final SharedPreferences secrets;
    private Done folderDone;
    private static final Map<String, String> BASES = new HashMap<>();
    static {
        BASES.put("gemini", "https://generativelanguage.googleapis.com/v1beta/openai/");
        BASES.put("groq", "https://api.groq.com/openai/v1/");
        BASES.put("openrouter", "https://openrouter.ai/api/v1/");
    }

    Bridge(MainActivity app) {
        this.app = app;
        secrets = app.getSharedPreferences("keys", Context.MODE_PRIVATE);
        folders = new Folders(app, this);
    }

    @JavascriptInterface
    public void post(String body) {
        main.post(() -> {
            if (!app.isOwnPage()) return;
            try {
                JSONObject m = new JSONObject(body);
                int id = m.optInt("id");
                handle(m.optString("op"), m, (ok, v) -> main.post(() -> app.js("window.__native && __native.reply(" + id + "," + ok + "," + json(v) + ")")));
            } catch (Exception ignored) { }
        });
    }
    static String json(Object v) {
        if (v == null || v == JSONObject.NULL) return "null";
        if (v instanceof String) return JSONObject.quote((String) v);
        return v.toString();
    }

    private void handle(String op, JSONObject m, Done done) throws Exception {
        switch (op) {
            case "window": case "drag": case "dragEnd": case "release": done.done(true, true); return;   // the phone app is always open
            case "quit": done.done(true, true); app.moveTaskToBack(true); return;
            case "log": android.util.Log.i("stupid-buddy", m.optString("text")); done.done(true, true); return;
            case "confirm": ask(m.optString("title"), m.optString("text"), m.optString("yes", "Allow"), ok -> done.done(true, ok)); return;
            case "clipboard.write":
                ((ClipboardManager) app.getSystemService(Context.CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Buddy", m.optString("text")));
                done.done(true, "Copied"); return;
            case "keys.set": {
                String p = m.optString("provider"), key = m.optString("key").trim();
                if (!BASES.containsKey(p) || key.length() < 10 || key.length() > 300 || key.matches(".*\\s.*")) { done.done(false, "That doesn’t look like a key."); return; }
                secrets.edit().putString(p, seal(key)).apply(); done.done(true, true); return;
            }
            case "keys.has": done.done(true, key(m.optString("provider")) != null); return;
            case "keys.remove": secrets.edit().remove(m.optString("provider")).apply(); done.done(true, true); return;
            case "ai.request": work.execute(() -> aiRequest(m, done)); return;
            case "web.search": work.execute(() -> search(m.optString("query"), done)); return;
            case "web.fetch": work.execute(() -> fetchPage(m.optString("url"), done)); return;
            case "web.open": openLink(m.optString("url")); done.done(true, "Opened"); return;
            case "files.addRoot": folderDone = done; app.startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), PICK_FOLDER); return;
            default:
                if (op.startsWith("files.")) { work.execute(() -> folders.handle(op, m, done)); return; }
                done.done(false, "unknown " + op);
        }
    }

    /** "Can I…?" before anything risky: a dialog only you can answer (the AI can't fake or skip it). */
    void ask(String title, String text, String yes, java.util.function.Consumer<Boolean> answer) {
        main.post(() -> new AlertDialog.Builder(app).setTitle(title).setMessage(text)
            .setPositiveButton(yes, (d, w) -> answer.accept(true)).setNegativeButton("Don’t", (d, w) -> answer.accept(false))
            .setOnCancelListener(d -> answer.accept(false)).show());
    }
    void folderPicked(Uri tree) {
        Done d = folderDone; folderDone = null;
        if (tree != null) folders.add(tree);
        if (d != null) d.done(true, folders.rootNames());
    }
    void openLink(String url) {
        if (url == null || !url.startsWith("https://") && !url.startsWith("http://")) return;
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE);
        i.setPackage("com.emil.stupidbrowser");   // The Stupid Browser when it's installed, else the usual browser
        try { app.startActivity(i); } catch (ActivityNotFoundException e) { i.setPackage(null); try { app.startActivity(i); } catch (ActivityNotFoundException ignored) { } }
    }

    /* ---------------- the online AI, with your key ---------------- */
    private void aiRequest(JSONObject m, Done done) {
        String p = m.optString("provider"), path = m.optString("path"), base = BASES.get(p);
        if (base == null || !(path.equals("chat/completions") || path.equals("models"))) { done.done(false, "bad request"); return; }
        String key = key(p);
        if (key == null) { done.done(false, "nokey"); return; }
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
            c.setConnectTimeout(20000); c.setReadTimeout(180000);
            c.setRequestProperty("Authorization", "Bearer " + key);
            if (p.equals("openrouter")) { c.setRequestProperty("HTTP-Referer", "https://thestupidcompany.net"); c.setRequestProperty("X-Title", "The Stupid Buddy"); }
            if (m.has("body")) {
                c.setRequestMethod("POST"); c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream o = c.getOutputStream()) { o.write(m.optString("body").getBytes(StandardCharsets.UTF_8)); }
            }
            int status = c.getResponseCode();
            String body = read(status >= 400 ? c.getErrorStream() : c.getInputStream(), 4_000_000);
            done.done(true, new JSONObject().put("status", status).put("body", body));
        } catch (java.net.UnknownHostException e) { done.done(false, "offline"); }
        catch (Exception e) { done.done(false, String.valueOf(e.getMessage())); }
    }
    private String key(String provider) { String s = secrets.getString(provider, null); return s == null ? null : open(s); }

    /* ---------------- the web ---------------- */
    private static final String UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Mobile TheStupidBuddy/0.2";
    private String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000); c.setReadTimeout(20000); c.setRequestProperty("User-Agent", UA);
        c.setInstanceFollowRedirects(true);
        return read(c.getInputStream(), 3_000_000);
    }
    /** DuckDuckGo's plain HTML results: titles, links and snippets. */
    private void search(String q, Done done) {
        if (q == null || q.trim().isEmpty()) { done.done(false, "What should I look for?"); return; }
        try {
            String html = get("https://html.duckduckgo.com/html/?q=" + URLEncoder.encode(q.trim(), "UTF-8"));
            JSONArray out = new JSONArray();
            String[] blocks = html.split("class=\"result__body\"");
            for (int i = 1; i < blocks.length && out.length() < 8; i++) {
                String href = cap("class=\"result__a\" href=\"([^\"]+)\"", blocks[i]);
                if (href == null) continue;
                String link = href.replace("&amp;", "&");
                String uddg = cap("uddg=([^&]+)", link);
                if (uddg != null) link = URLDecoder.decode(uddg, "UTF-8");
                out.put(new JSONObject().put("title", plain(cap("class=\"result__a\"[^>]*>(.*?)</a>", blocks[i]))).put("url", link).put("snippet", plain(cap("class=\"result__snippet\"[^>]*>(.*?)</a>", blocks[i]))));
            }
            done.done(true, out);
        } catch (Exception e) { done.done(false, "The search didn’t answer. Is the internet on?"); }
    }
    private void fetchPage(String url, Done done) {
        if (url == null || !url.matches("^https?://.+")) { done.done(false, "bad link"); return; }
        try {
            String html = get(url);
            String title = plain(cap("<title[^>]*>(.*?)</title>", html));
            String body = html.replaceAll("(?is)<(script|style|noscript|svg|nav|footer|header|form)[^>]*>.*?</\\1>", " ").replaceAll("(?i)<(br|/p|/div|/li|/h[1-6]|/tr)[^>]*>", "\n");
            String text = plain(body).replaceAll("\n\\s*\n\\s*\n+", "\n\n");
            done.done(true, new JSONObject().put("url", url).put("title", title).put("text", text.length() > 30000 ? text.substring(0, 30000) : text));
        } catch (Exception e) { done.done(false, "I couldn’t open that page."); }
    }
    private static String cap(String re, String s) { Matcher m = Pattern.compile(re, Pattern.CASE_INSENSITIVE | Pattern.DOTALL).matcher(s == null ? "" : s); return m.find() ? m.group(1) : null; }
    private static String plain(String html) {
        if (html == null) return "";
        String t = html.replaceAll("<[^>]+>", "").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#x27;", "'").replace("&#39;", "'").replace("&nbsp;", " ");
        return t.replaceAll("[ \\t]+", " ").trim();
    }
    static String read(InputStream in, int max) throws java.io.IOException {
        if (in == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] b = new byte[16384]; int n;
        while ((n = in.read(b)) > 0 && out.size() < max) out.write(b, 0, n);
        in.close(); return out.toString("UTF-8");
    }

    /* ---------------- keys, sealed with the phone's secure hardware ---------------- */
    private static SecretKey vault() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
        if (ks.containsAlias("stupid-buddy-keys")) return ((KeyStore.SecretKeyEntry) ks.getEntry("stupid-buddy-keys", null)).getSecretKey();
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder("stupid-buddy-keys", KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
        return g.generateKey();
    }
    private static String seal(String text) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE, vault());
        Base64.Encoder b = Base64.getEncoder();
        return b.encodeToString(c.getIV()) + ":" + b.encodeToString(c.doFinal(text.getBytes(StandardCharsets.UTF_8)));
    }
    private static String open(String sealed) {
        try {
            String[] p = sealed.split(":", 2); Base64.Decoder b = Base64.getDecoder();
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.DECRYPT_MODE, vault(), new GCMParameterSpec(128, b.decode(p[0])));
            return new String(c.doFinal(b.decode(p[1])), StandardCharsets.UTF_8);
        } catch (Exception e) { return null; }
    }
}
