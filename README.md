# The Stupid Buddy

Buddy from The Stupid Browser, living on your Mac or Windows desktop (and your Android phone), with a small team that does work for you.

- **File Buddy** finds, reads, sorts, renames and tidies files
- **Writer Buddy** writes emails, notes, summaries and documents
- **Web Buddy** looks things up and brings back facts with sources
- **Hands Buddy** (Mac and Windows) uses other apps for you: it looks at the screen, clicks and types

Click Buddy's ball, say what you need, and watch the team work. Buddy always asks before moving, renaming, replacing or deleting anything (in an alert only you can answer), and helpers only use the folders you allow.

[Website](https://stupidbuddy.vercel.app) · [Download](https://github.com/lattewirell-creator/stupid-buddy/releases/latest) · Part of [The Stupid Company](https://thestupidcompany.net)

## Hands Buddy

On a Mac, Hands Buddy needs two permissions: System Settings → Privacy & Security → **Screen & System Audio Recording** (to see) and **Accessibility** (to click and type). Turn on The Stupid Buddy in both, then quit and reopen it.

It asks you before every task. While it works a red bar shows at the top of the screen, and **Esc stops it at once**. It won't type into password fields, and clicking anything like Send, Buy, Pay, Post or Delete needs your OK in an alert. With Ollama it uses `qwen3-vl:8b-instruct` (it can see); on Groq it switches to a model that can see screenshots.

## The AI

Pick where Buddy's brain runs in Settings:

| | Cost | Speed | Privacy |
| --- | --- | --- | --- |
| This Mac ([Ollama](https://ollama.com)) | Free | Slower (15–40 s a task) | Nothing leaves your Mac |
| Groq | Free key | Very fast | Requests go to Groq |
| Google Gemini | Free key | Fast | Requests go to Google |
| OpenRouter | Free key (free models) | Varies | Requests go to OpenRouter |

For This Mac: install Ollama, then `ollama pull qwen3-vl:8b-instruct` (6 GB). Online keys are kept in your Mac's Keychain.

## Install

**Mac:** download `The.Stupid.Buddy.Mac.zip`, unzip it and drag The Stupid Buddy into Applications. macOS 14 or newer, Apple chip or Intel. It isn't notarized by Apple: the first time, right-click the app → Open → Open.

**Windows:** download `StupidBuddy-<version>-windows-setup.exe` and run it (Windows 10 or 11, no administrator needed). It isn't signed: if Windows SmartScreen warns you, click More info → Run anyway. Keys are kept with Windows' own per-user encryption. Hands Buddy needs no extra permission on Windows; it still asks before every task, and Esc stops it.

**Android:** download `StupidBuddy-<version>-android.apk` on your phone and open it (Android 8 or newer). The phone uses an online AI with a free key (Groq, Gemini or OpenRouter), kept in the phone's secure storage. File Buddy works in folders you allow; deleting isn't offered on the phone.

## Build

Mac: `bash mac/build.sh` → `mac/build/The Stupid Buddy.app`. Android: `cd android && ./gradlew assembleRelease`. Both share `ui/` (plain HTML/JS: the team and the AI); the Mac side is Swift, the phone side Java.

Routing test: `node scripts/route-test.mjs` asks Buddy 13 typical things (in English and Swedish) and checks it hands each one to the right helper, without the helpers touching anything. It uses Ollama on this computer; `--model <name>` tries another model, and `GROQ_API_KEY=… node scripts/route-test.mjs --provider groq` (or gemini, openrouter) an online one.

Free and open source under the MIT license.
