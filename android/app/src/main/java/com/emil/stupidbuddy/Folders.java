package com.emil.stupidbuddy;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.provider.DocumentsContract;

import androidx.documentfile.provider.DocumentFile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** File Buddy on the phone: only inside folders you picked (Android's folder access). Paths look like the Mac's,
 *  "~/<folder name>/…". Moving, renaming and replacing ask you first. Deleting isn't offered: Android has no Trash. */
final class Folders {
    private final MainActivity app;
    private final Bridge bridge;
    private final SharedPreferences prefs;

    Folders(MainActivity app, Bridge bridge) { this.app = app; this.bridge = bridge; prefs = app.getSharedPreferences("folders", Context.MODE_PRIVATE); }

    /* ---------------- the folders you allowed ---------------- */
    private Map<String, DocumentFile> roots() {
        Map<String, DocumentFile> out = new LinkedHashMap<>();
        for (String s : prefs.getString("roots", "").split("\n")) {
            if (s.isEmpty()) continue;
            DocumentFile d = DocumentFile.fromTreeUri(app, Uri.parse(s));
            if (d != null && d.canRead() && d.getName() != null) out.put(d.getName(), d);
        }
        return out;
    }
    void add(Uri tree) {
        try { app.getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION); } catch (SecurityException ignored) { }
        String all = prefs.getString("roots", "");
        if (!all.contains(tree.toString())) prefs.edit().putString("roots", (all.isEmpty() ? "" : all + "\n") + tree).apply();
    }
    JSONArray rootNames() { JSONArray a = new JSONArray(); for (String n : roots().keySet()) a.put("~/" + n); return a; }

    /** "~/Download/Notes/a.txt" → the folder "Download" you allowed, then "Notes", then "a.txt". */
    private static List<String> parts(String path) {
        List<String> l = new ArrayList<>();
        for (String p : String.valueOf(path).replaceFirst("^~?/+", "").split("/")) if (!p.isEmpty() && !p.equals(".")) { if (p.equals("..")) return null; l.add(p); }
        return l;
    }
    private DocumentFile resolve(String path, boolean makeDirs) {
        List<String> p = parts(path); if (p == null || p.isEmpty()) return null;
        DocumentFile cur = null;
        for (Map.Entry<String, DocumentFile> e : roots().entrySet()) if (e.getKey().equalsIgnoreCase(p.get(0))) cur = e.getValue();
        if (cur == null) return null;
        for (int i = 1; i < p.size(); i++) {
            DocumentFile next = cur.findFile(p.get(i));
            if (next == null) { if (!makeDirs) return null; next = cur.createDirectory(p.get(i)); if (next == null) return null; }
            cur = next;
        }
        return cur;
    }
    private String outside() {
        List<String> names = new ArrayList<>(); for (String n : roots().keySet()) names.add("~/" + n);
        return names.isEmpty() ? "I don’t have any folders yet. Ask the user to allow one in Settings → Allow another folder." : "That’s not in the folders I’m allowed to use (" + String.join(", ", names) + ").";
    }
    private String missing(String path) {
        List<String> p = parts(path); if (p == null || p.size() < 2) return outside();
        StringBuilder parent = new StringBuilder("~"); for (int i = 0; i < p.size() - 1; i++) parent.append('/').append(p.get(i));
        DocumentFile dir = resolve(parent.toString(), false);
        if (dir == null) return outside();
        List<String> names = new ArrayList<>(); for (DocumentFile f : dir.listFiles()) if (names.size() < 40 && f.getName() != null) names.add(f.getName());
        return "There’s no “" + p.get(p.size() - 1) + "” in " + parent + "." + (names.isEmpty() ? "" : " What’s there: " + String.join(", ", names));
    }

    void handle(String op, JSONObject m, Bridge.Done done) {
        try {
            switch (op) {
                case "files.roots": done.done(true, rootNames()); return;
                case "files.list": {
                    DocumentFile d = resolve(m.optString("path"), false);
                    if (d == null) { done.done(false, parts(m.optString("path")) == null ? outside() : missing(m.optString("path"))); return; }
                    JSONArray items = new JSONArray(); DocumentFile[] list = d.listFiles();
                    for (int i = 0; i < list.length && i < 400; i++) items.put(new JSONObject().put("name", list[i].getName()).put("folder", list[i].isDirectory()).put("size", list[i].length()));
                    done.done(true, new JSONObject().put("path", m.optString("path")).put("count", list.length).put("items", items)); return;
                }
                case "files.read": {
                    DocumentFile f = resolve(m.optString("path"), false);
                    if (f == null || f.isDirectory()) { done.done(false, missing(m.optString("path"))); return; }
                    String name = String.valueOf(f.getName()).toLowerCase();
                    if (name.matches(".*\\.(pdf|docx?|odt|jpe?g|png|heic|mp[34]|zip|apk)$")) { done.done(false, "I can only read plain text files on the phone (like .txt, .md, .csv, .json, .html)."); return; }
                    try (InputStream in = app.getContentResolver().openInputStream(f.getUri())) {
                        String t = Bridge.read(in, 2_000_000);
                        done.done(true, new JSONObject().put("path", m.optString("path")).put("text", t.length() > 60000 ? t.substring(0, 60000) : t).put("cut", t.length() > 60000));
                    }
                    return;
                }
                case "files.search": {
                    String q = m.optString("query").toLowerCase().trim(); JSONArray hits = new JSONArray();
                    if (q.isEmpty()) { done.done(false, "What should I look for?"); return; }
                    for (Map.Entry<String, DocumentFile> e : roots().entrySet()) walk(e.getValue(), "~/" + e.getKey(), q, hits, 0);
                    done.done(true, hits); return;
                }
                case "files.mkdir": { DocumentFile d = resolve(m.optString("path"), true); done.done(d != null, d != null ? "Made the folder " + m.optString("path") : outside()); return; }
                case "files.write": {
                    List<String> p = parts(m.optString("path")); if (p == null || p.size() < 2) { done.done(false, outside()); return; }
                    String name = p.get(p.size() - 1);
                    DocumentFile dir = resolve("~/" + String.join("/", p.subList(0, p.size() - 1)), true);
                    if (dir == null) { done.done(false, outside()); return; }
                    DocumentFile existing = dir.findFile(name);
                    Runnable save = () -> {
                        try {
                            DocumentFile f = existing != null ? existing : dir.createFile(name.endsWith(".md") ? "text/markdown" : "text/plain", name);
                            if (f == null) { done.done(false, "I couldn’t save it there."); return; }
                            try (OutputStream o = app.getContentResolver().openOutputStream(f.getUri(), "wt")) { o.write(m.optString("text").getBytes(StandardCharsets.UTF_8)); }
                            done.done(true, "Saved " + m.optString("path"));
                        } catch (Exception e) { done.done(false, "I couldn’t save it there."); }
                    };
                    if (existing != null) bridge.ask("Replace “" + name + "”?", "It already exists. The old version will be gone.", "Replace", ok -> { if (ok) new Thread(save).start(); else done.done(false, "You said no, so I didn’t do it."); });
                    else save.run();
                    return;
                }
                case "files.move": move(m.optString("from"), m.optString("to"), done); return;
                case "files.moveMany": {
                    JSONArray list = m.optJSONArray("moves");
                    if (list == null || list.length() == 0) { done.done(false, "No moves given."); return; }
                    StringBuilder preview = new StringBuilder();
                    for (int i = 0; i < Math.min(list.length(), 12); i++) preview.append("• ").append(parts(list.getJSONObject(i).optString("from")).get(parts(list.getJSONObject(i).optString("from")).size() - 1)).append(" → ").append(list.getJSONObject(i).optString("to")).append('\n');
                    if (list.length() > 12) preview.append("…and ").append(list.length() - 12).append(" more");
                    bridge.ask("Move " + list.length() + " file" + (list.length() == 1 ? "" : "s") + "?", preview.toString(), "Move them", ok -> {
                        if (!ok) { done.done(false, "You said no, so I didn’t do it."); return; }
                        new Thread(() -> { int moved = 0; for (int i = 0; i < list.length(); i++) { JSONObject x = list.optJSONObject(i); if (x != null && moveNow(x.optString("from"), x.optString("to")) == null) moved++; } done.done(true, "Moved " + moved + " of " + list.length() + "."); }).start();
                    });
                    return;
                }
                case "files.trash": done.done(false, "Deleting isn’t available on the phone (Android has no Trash to undo it). Ask the user to delete it themselves."); return;
                case "files.open": case "files.reveal": {
                    DocumentFile f = resolve(m.optString("path"), false);
                    if (f == null) { done.done(false, missing(m.optString("path"))); return; }
                    Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(f.getUri(), f.isDirectory() ? DocumentsContract.Document.MIME_TYPE_DIR : f.getType()).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    try { app.startActivity(i); done.done(true, "Opened " + f.getName()); } catch (Exception e) { done.done(false, "No app on this phone opens that."); }
                    return;
                }
                default: done.done(false, "unknown " + op);
            }
        } catch (Exception e) { done.done(false, String.valueOf(e.getMessage())); }
    }
    private void walk(DocumentFile dir, String path, String q, JSONArray hits, int depth) {
        if (depth > 4 || hits.length() >= 60) return;
        for (DocumentFile f : dir.listFiles()) {
            if (hits.length() >= 60 || f.getName() == null) return;
            String p = path + "/" + f.getName();
            if (f.getName().toLowerCase().contains(q)) hits.put(p);
            if (f.isDirectory()) walk(f, p, q, hits, depth + 1);
        }
    }
    private void move(String from, String to, Bridge.Done done) {
        DocumentFile f = resolve(from, false);
        if (f == null) { done.done(false, missing(from)); return; }
        List<String> fp = parts(from), tp = parts(to);
        if (tp == null || tp.isEmpty()) { done.done(false, outside()); return; }
        boolean rename = fp.size() == tp.size() && String.join("/", fp.subList(0, fp.size() - 1)).equalsIgnoreCase(String.join("/", tp.subList(0, tp.size() - 1)));
        bridge.ask(rename ? "Rename “" + f.getName() + "”?" : "Move “" + f.getName() + "”?", rename ? "New name: " + tp.get(tp.size() - 1) : "To " + to, rename ? "Rename" : "Move", ok -> {
            if (!ok) { done.done(false, "You said no, so I didn’t do it."); return; }
            new Thread(() -> { String err = moveNow(from, to); done.done(err == null, err == null ? "Done: " + to : err); }).start();
        });
    }
    /** Moves (or renames) right away; null when it worked. */
    private String moveNow(String from, String to) {
        DocumentFile f = resolve(from, false); if (f == null) return missing(from);
        List<String> fp = parts(from), tp = parts(to); if (tp == null || tp.isEmpty()) return outside();
        DocumentFile target = resolve(to, false);
        try {
            if (target != null && target.isDirectory()) {   // into a folder
                if (target.findFile(f.getName()) != null) return to + "/" + f.getName() + " already exists.";
                DocumentFile parent = f.getParentFile();
                if (parent == null) return "I can’t move that one.";
                Uri moved = DocumentsContract.moveDocument(app.getContentResolver(), f.getUri(), parent.getUri(), target.getUri());
                return moved != null ? null : "I couldn’t move it.";
            }
            if (target != null) return to + " already exists; I won’t overwrite it.";
            String sameDir = String.join("/", fp.subList(0, fp.size() - 1)), toDir = String.join("/", tp.subList(0, tp.size() - 1));
            if (sameDir.equalsIgnoreCase(toDir)) return f.renameTo(tp.get(tp.size() - 1)) ? null : "I couldn’t rename it.";
            DocumentFile dir = resolve("~/" + toDir, true); if (dir == null) return outside();
            DocumentFile parent = f.getParentFile(); if (parent == null) return "I can’t move that one.";
            Uri moved = DocumentsContract.moveDocument(app.getContentResolver(), f.getUri(), parent.getUri(), dir.getUri());
            if (moved == null) return "I couldn’t move it.";
            DocumentFile now = DocumentFile.fromSingleUri(app, moved);
            if (now != null && !tp.get(tp.size() - 1).equals(f.getName())) now.renameTo(tp.get(tp.size() - 1));
            return null;
        } catch (Exception e) { return "I couldn’t move it: " + e.getMessage(); }
    }
}
