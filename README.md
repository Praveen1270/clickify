# Clickify

Clickify is a small Windows app that sits on your screen and follows your mouse. You speak, it looks at your screen, and it talks back with step-by-step answers.

---

## Install (Windows)

1. Open the **[latest release](https://github.com/Praveen1270/clickify/releases/latest)** and download **`Clickify Setup … .exe`**.
2. Run the installer and finish the steps.
3. Start Clickify from the Start menu or your desktop shortcut.

**First time:** If something is missing, the app opens **API keys**. You can also open it from the **tray icon → API keys…**. Keys are stored only on your PC in `%APPDATA%\Clickify\clickify.env`.

| Key      | Needed for                          |
|----------|-------------------------------------|
| Sarvam   | Listening and speaking (always)     |
| Groq     | If you pick Groq as the vision model |
| Gemini   | If you pick Gemini as the vision model |

**No `.exe` on the release page yet?** Someone with the repo can [publish a release](#publish-a-release) or you can build it yourself: `npm install`, then `npm run package` — the installer ends up in the `release/` folder.

---

## How to use

| Shortcut              | What it does                          |
|-----------------------|---------------------------------------|
| **Ctrl+Shift+Space** | Hold to talk; release when you’re done |
| **Tray icon**        | Show overlay, API keys, startup, quit |

Say things like “stop” or “cancel” to interrupt playback (Telugu and Hindi phrases work too).

**Tip:** Ask about what you actually see on the screen; the app sends a screenshot to the AI.

---

## What happens under the hood (short version)

1. Your mic is used only when you’re speaking (quiet parts are skipped).
2. The app takes a quick screenshot of your main screen (the overlay hides for a moment).
3. Your speech is turned into text (Sarvam).
4. The text and image go to Groq or Gemini, which returns spoken steps.
5. Clickify reads those steps aloud (Sarvam).

A little recent chat history is sent each time so follow-up questions make sense.

---

## Remove audio from a video (`clip.mp4`)

Demo (screen recording of the steps):

<video src="https://raw.githubusercontent.com/Praveen1270/clickify/main/docs/how-to-remove-audio-from-video.mp4" controls playsinline preload="metadata" width="720"></video>

*[If the player does not show, open the file in the repo: [`docs/how-to-remove-audio-from-video.mp4`](docs/how-to-remove-audio-from-video.mp4)]*

If you have a file named **`clip.mp4`** (or any `.mp4`) and want **video only, no sound**, use **FFmpeg** (free, common tool).

1. Install FFmpeg if you don’t have it: [ffmpeg.org/download.html](https://ffmpeg.org/download.html) (or `winget install ffmpeg` on Windows).
2. Open a terminal in the folder that contains your video.
3. Run:

```bash
ffmpeg -i clip.mp4 -c copy -an clip_no_audio.mp4
```

- **`-i clip.mp4`** — your input file (change the name if yours is different).
- **`-an`** — removes all audio tracks.
- **`-c copy`** — copies the video without re-encoding (fast; same quality).

The new file is **`clip_no_audio.mp4`**. To overwrite the original instead, use a temporary name first, then rename—overwriting the same file FFmpeg is reading can cause errors.

**If you need to re-encode** (for example copy fails), try:

```bash
ffmpeg -i clip.mp4 -c:v libx264 -an clip_no_audio.mp4
```

---

## For developers

**You need:** Node.js, npm, and Windows (the build is set up for Windows x64).

Install and run from source:

```bash
npm install
```

Copy `.env.example` to `.env` and add your API keys. Same variables as in the table above, plus `LLM_PROVIDER` (`groq` or `gemini`).

```bash
npm start
```

**Build the installer:**

```bash
npm run package
```

Output: `release/` (e.g. `Clickify Setup 0.1.1.exe`).

**Project folders (overview):**

- `src/main/` — Electron main process (tray, APIs, overlay wiring)
- `src/renderer/` — Overlay UI, voice, playback
- `assets/` — App icon
- `docs/` — Extra files for the README (e.g. demo video)

---

## Publish a release

GitHub Actions builds the Windows installer (`.github/workflows/release-windows.yml`).

1. Update `version` in `package.json` if needed.
2. Create and push a tag, for example:

```bash
git tag v0.1.1
git push origin v0.1.1
```

3. Check **[Releases](https://github.com/Praveen1270/clickify/releases)** — the workflow attaches the setup `.exe`.

You can also run **Actions → Release Windows installer → Run workflow** and download the artifact.

---

## More detail (optional)

- **Installed app keys** live in `clickify.env` under your user data folder. While developing, that file overrides a project `.env` if both exist.
- **Models:** Groq uses `meta-llama/llama-4-scout-17b-16e-instruct`; Gemini uses `gemini-2.0-flash`.
- **Languages:** TTS uses `en-IN`, `hi-IN`, and `te-IN` presets.
- The overlay stays visible (opacity) during screenshots so audio recording stays stable.
