# Clickify

A small Electron overlay that follows your cursor. It listens when you speak, captures what is on screen, and answers with synthesized speech. The model can return a short sequence of spoken steps; the icon stays with your cursor.

## How it works

1. **Microphone** — Voice activity detection records when you talk (and ignores silence).
2. **Screenshot** — Before each reply, the app grabs a thumbnail of the primary display (the overlay fades out so it is not in the shot).
3. **Speech-to-text** — Audio is sent to Sarvam (`saarika`) with automatic language handling.
4. **Vision + instructions** — The transcript and image go to your chosen LLM provider (Groq or Gemini). The model returns JSON: ordered `steps`, each with `speak` text for that step.
5. **Speech** — Each step is spoken with Sarvam TTS in order.

Recent conversation context (last few turns, short TTL) is sent with each request so follow-ups stay coherent.

## Requirements

- **Node.js** (for development) and **npm**
- **Windows** — packaging scripts target Windows x64 (see `package.json`)

## Setup

Install dependencies:

```bash
npm install
```

**From source (development)** — Copy `.env.example` to `.env` in the project root and add your keys.

**Installed app** — The installer does not ship API keys. On first launch, Clickify opens the API keys window if anything required is missing. You can open it anytime from the tray menu (**API keys…**). Keys are saved to `clickify.env` under your user data directory (on Windows, under `%APPDATA%\Clickify\`).

| Variable | Purpose |
|----------|---------|
| `SARVAM_API_KEY` | Speech-to-text and text-to-speech |
| `GROQ_API_KEY` | Vision LLM when using Groq |
| `GEMINI_API_KEY` | Vision LLM when using Gemini |
| `LLM_PROVIDER` | `groq` (default) or `gemini` |

If both a project `.env` and `clickify.env` exist while developing, the user file overrides.

Groq uses `meta-llama/llama-4-scout-17b-16e-instruct`. Gemini uses `gemini-2.0-flash`.

## Run

```bash
npm start
```

This builds TypeScript and launches Electron. The triangle icon tracks the cursor; the window ignores mouse input so clicks pass through to apps underneath.

## Controls

| Action | Result |
|--------|--------|
| **Ctrl+Shift+Space** | Push-to-talk: start/stop the voice pipeline |
| **Tray icon** | Show the overlay, **API keys…**, launch at startup, quit |

Spoken stop phrases (e.g. “stop”, “cancel”) can interrupt playback; Telugu and Hindi phrases are included in the stop list.

## Project layout

```
clickify/
├── assets/
│   └── icon.png           # App + tray icon (orange triangle; generated on build)
├── src/
│   ├── main/index.ts      # Electron: tray, overlay, IPC, Groq/Gemini, Sarvam
│   ├── preload/index.ts   # `clickify` bridge for the renderer
│   └── renderer/          # Cursor overlay, VAD, playback, step runner
├── scripts/
│   ├── generate-icon.js   # Writes assets/icon.png before compile
│   └── copy-assets.js
├── dist/                  # Build output
└── package.json
```

## Packaging

```bash
npm run package
```

Build output goes under `release/` (NSIS installer on Windows per `electron-builder` config).

## Tips

- Ask clear questions about what is visible on screen; the model reasons over the screenshot resolution above.
- The overlay uses opacity (not `hide()`) during capture so the audio graph keeps running reliably.
- TTS language/voice mapping uses `en-IN`, `hi-IN`, and `te-IN` presets in the main process.
