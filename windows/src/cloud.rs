// Buddy's brain (mac/Sources/Cloud.swift): online AIs with free keys (Gemini, Groq, OpenRouter), the key added
// here so the page never sees it, and Ollama on this PC. On Windows the page's address isn't one Ollama
// accepts, so its requests come through here too. Returns { status, body } like the Mac app.
use crate::store;
use serde_json::{json, Map, Value};
use std::time::Duration;

fn base(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/openai/",
        "groq" => "https://api.groq.com/openai/v1/",
        "openrouter" => "https://openrouter.ai/api/v1/",
        "local" => "http://localhost:11434/v1/",
        _ => return None,
    })
}

/// Runs on a worker thread.
pub fn handle(op: &str, m: &Map<String, Value>) -> Result<Value, String> {
    let provider = m.get("provider").and_then(Value::as_str).unwrap_or("");
    match op {
        "keys.set" => {
            let key = m.get("key").and_then(Value::as_str).unwrap_or("").trim().to_string();
            if base(provider).is_none() || provider == "local" || key.len() < 10 || key.len() > 300 || key.chars().any(char::is_whitespace) {
                return Err("That doesn’t look like a key.".into());
            }
            Ok(json!(store::save_key(provider, &key)))
        }
        "keys.has" => Ok(json!(store::load_key(provider).is_some())),
        "keys.remove" => Ok(json!(store::remove_key(provider))),
        "ai.request" => {
            let path = m.get("path").and_then(Value::as_str).unwrap_or("");
            let Some(base) = base(provider) else { return Err("bad request".into()) };
            if !["chat/completions", "models"].contains(&path) { return Err("bad request".into()); }
            let mut headers = vec![];
            if provider != "local" {
                let Some(key) = store::load_key(provider) else { return Err("nokey".into()) };
                headers.push(("Authorization".to_string(), format!("Bearer {key}")));
            }
            if provider == "openrouter" {
                headers.push(("HTTP-Referer".into(), "https://thestupidcompany.net".into()));
                headers.push(("X-Title".into(), "The Stupid Buddy".into()));
            }
            send(&format!("{base}{path}"), &headers, m.get("body").and_then(Value::as_str), 180)
        }
        "ollama.request" => {
            let path = m.get("path").and_then(Value::as_str).unwrap_or("");
            if !["api/tags", "api/chat"].contains(&path) { return Err("bad request".into()); }
            // A small local AI can take minutes on a slow PC; checking whether Ollama runs should be quick.
            send(&format!("http://localhost:11434/{path}"), &[], m.get("body").and_then(Value::as_str), if path == "api/tags" { 4 } else { 900 })
        }
        _ => Err("unknown".into()),
    }
}

fn send(url: &str, headers: &[(String, String)], body: Option<&str>, timeout: u64) -> Result<Value, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(timeout))).build().into();
    let response = match body {
        Some(b) => {
            let mut r = agent.post(url).header("Content-Type", "application/json");
            for (k, v) in headers { r = r.header(k, v); }
            r.send(b.as_bytes())
        }
        None => {
            let mut r = agent.get(url);
            for (k, v) in headers { r = r.header(k, v); }
            r.call()
        }
    }.map_err(|_| "offline".to_string())?;
    let status = response.status().as_u16();
    let text = response.into_body().with_config().limit(32 * 1024 * 1024).read_to_string().map_err(|_| "offline".to_string())?;
    Ok(json!({ "status": status, "body": text }))
}
