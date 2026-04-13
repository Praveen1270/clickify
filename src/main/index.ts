import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  screen,
  ipcMain,
  desktopCapturer,
  session,
  globalShortcut,
} from 'electron';
import * as https from 'https';
import * as zlib  from 'zlib';
import * as fs   from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { parse as parseEnv } from 'dotenv';

function userEnvPath(): string {
  return path.join(app.getPath('userData'), 'clickify.env');
}

/** Dev `.env` then `%AppData%/Clickify/clickify.env` (override). */
function loadEnvFiles(): void {
  if (!app.isPackaged) {
    const devPath = path.join(__dirname, '../../.env');
    if (fs.existsSync(devPath)) dotenv.config({ path: devPath });
  }
  if (fs.existsSync(userEnvPath())) dotenv.config({ path: userEnvPath(), override: true });
}

function readMergedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!app.isPackaged) {
    const devPath = path.join(__dirname, '../../.env');
    if (fs.existsSync(devPath)) Object.assign(out, parseEnv(fs.readFileSync(devPath)));
  }
  if (fs.existsSync(userEnvPath())) Object.assign(out, parseEnv(fs.readFileSync(userEnvPath())));
  return out;
}

function missingRequiredApiKeys(): boolean {
  const m = readMergedEnv();
  if (!m.SARVAM_API_KEY?.trim()) return true;
  const prov = (m.LLM_PROVIDER ?? 'groq').toLowerCase();
  if (prov === 'groq' && !m.GROQ_API_KEY?.trim()) return true;
  if (prov === 'gemini' && !m.GEMINI_API_KEY?.trim()) return true;
  return false;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Step {
  speak: string;
}

interface HistoryEntry {
  userText:      string;
  assistantText: string;
  ts:            number;
}

// ─── Conversation history (last 3 turns, 5-min expiry) ───────────────────────

const history: HistoryEntry[] = [];
const MAX_HISTORY    = 3;
const HISTORY_EXPIRY = 5 * 60 * 1000;

function recentHistory(): HistoryEntry[] {
  const now = Date.now();
  while (history.length && now - history[0].ts > HISTORY_EXPIRY) history.shift();
  return history.slice(-MAX_HISTORY);
}

function pushHistory(userText: string, assistantText: string) {
  history.push({ userText, assistantText, ts: Date.now() });
  if (history.length > MAX_HISTORY) history.shift();
}

// ─── Native HTTPS helper ──────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 20_000;

function nodePost(url: string, headers: Record<string, string>, body: Buffer) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port:     Number(u.port) || 443,
        path:     u.pathname + u.search,
        method:   'POST',
        headers:  { ...headers, 'Content-Length': body.length },
        timeout:  REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data',  (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end',   () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timed out: ${url}`)); });
    req.write(body);
    req.end();
  });
}

function buildMultipart(
  fields: Record<string, string>,
  fileField: string, fileName: string, fileData: Buffer, fileType: string
): { contentType: string; body: Buffer } {
  const boundary = 'ClickifyBoundary' + Date.now();
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${fileType}\r\n\r\n`));
  parts.push(fileData);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}

// ─── LLM: Groq ───────────────────────────────────────────────────────────────

async function callGroq(systemPrompt: string, transcript: string, screenshotUrl: string): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set in .env');

  const ctx = recentHistory();
  const messages: object[] = [
    { role: 'system', content: systemPrompt },
    ...ctx.flatMap(h => [
      { role: 'user',      content: h.userText },
      { role: 'assistant', content: h.assistantText },
    ]),
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: screenshotUrl } },
        { type: 'text', text: transcript },
      ],
    },
  ];

  const body = Buffer.from(JSON.stringify({
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    response_format: { type: 'json_object' },
    max_tokens: 600,
    temperature: 0.1,
    messages,
  }));

  const doPost = () => nodePost(
    'https://api.groq.com/openai/v1/chat/completions',
    { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body
  );

  let res = await doPost();
  if (res.status === 429) { await delay(8000); res = await doPost(); }
  if (res.status >= 400) throw new Error(`Groq ${res.status}: ${res.text}`);

  try {
    const data = JSON.parse(res.text) as { choices?: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? '{}';
  } catch {
    throw new Error(`Groq returned non-JSON: ${res.text.slice(0, 200)}`);
  }
}

// ─── LLM: Gemini ─────────────────────────────────────────────────────────────

async function callGemini(systemPrompt: string, transcript: string, screenshotUrl: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set in .env');

  const base64Image = screenshotUrl.replace(/^data:image\/\w+;base64,/, '');
  const ctx = recentHistory();
  const contents: object[] = [
    ...ctx.flatMap(h => [
      { role: 'user',  parts: [{ text: h.userText }] },
      { role: 'model', parts: [{ text: h.assistantText }] },
    ]),
    {
      role: 'user',
      parts: [
        { inline_data: { mime_type: 'image/png', data: base64Image } },
        { text: transcript },
      ],
    },
  ];

  const body = Buffer.from(JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generation_config: { response_mime_type: 'application/json', max_output_tokens: 600, temperature: 0.1 },
  }));

  const doPost = () => nodePost(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    { 'Content-Type': 'application/json' },
    body
  );

  let res = await doPost();
  if (res.status === 429) { await delay(5000); res = await doPost(); }
  if (res.status >= 400) throw new Error(`Gemini ${res.status}: ${res.text}`);

  try {
    const data = JSON.parse(res.text) as { candidates?: Array<{ content: { parts: Array<{ text: string }> } }> };
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '{}';
  } catch {
    throw new Error(`Gemini returned non-JSON: ${res.text.slice(0, 200)}`);
  }
}

// ─── Language maps ────────────────────────────────────────────────────────────

const LANG_NAMES: Record<string, string> = {
  'en-IN': 'English', 'hi-IN': 'Hindi', 'te-IN': 'Telugu',
};
const LANG_SPEAKERS: Record<string, string> = {
  'en-IN': 'shubh', 'hi-IN': 'rahul', 'te-IN': 'gokul',
};

// ─── Tray icon (generated in-memory, no file needed) ─────────────────────────

function makeTrayIcon(): Electron.NativeImage {
  const SIZE = 16;
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  function crc32(buf: Buffer): number {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type: string, data: Buffer): Buffer {
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4), 0);
  // Right-pointing triangle (same style as overlay), tip ≈(13, 7), base (2,2)–(2,12)
  const ax = 13, ay = 7, bx = 2, by = 2, cx = 2, cy = 12;
  const sign = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) =>
    (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
  const inTri = (px: number, py: number) => {
    const d1 = sign(px, py, ax, ay, bx, by);
    const d2 = sign(px, py, bx, by, cx, cy);
    const d3 = sign(px, py, cx, cy, ax, ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  for (let y = 0; y < SIZE; y++) {
    raw[y * (1 + SIZE * 4)] = 0;
    for (let x = 0; x < SIZE; x++) {
      let a = 0;
      if (inTri(x + 0.5, y + 0.5)) a = 255;
      else {
        // Soft halo (match “glow” look on a tiny tray icon)
        for (let dy = -1; dy <= 1 && !a; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (inTri(x + 0.5 + dx * 0.45, y + 0.5 + dy * 0.45)) { a = 90; break; }
          }
        }
      }
      if (a > 0) {
        const o = y * (1 + SIZE * 4) + 1 + x * 4;
        raw[o] = 255; raw[o + 1] = 130; raw[o + 2] = 20; raw[o + 3] = a;
      }
    }
  }
  return nativeImage.createFromBuffer(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** Same orange triangle as `assets/icon.png` (generated by scripts/generate-icon.js). */
function appIconPath(): string {
  return path.join(__dirname, '../assets/icon.png');
}

function loadAppIcon(): Electron.NativeImage {
  const p = appIconPath();
  if (fs.existsSync(p)) {
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    } catch {
      /* use generated fallback */
    }
  }
  return makeTrayIcon();
}

// ─── Overlay window — follows the cursor ─────────────────────────────────────
//
// The SVG is a right-pointing triangle; its tip sits at ≈(40, 24) within the 48×48 window.
// Positioning the window at (cursor.x − 40, cursor.y − 24) aligns the tip with the OS cursor.

const CURSOR_TIP_X = 40;
const CURSOR_TIP_Y = 24;

let overlayWindow:   BrowserWindow | null = null;
let settingsWindow:  BrowserWindow | null = null;
let tray:            Tray | null = null;
let followInterval:  ReturnType<typeof setInterval> | null = null;

function startCursorFollow() {
  if (followInterval) clearInterval(followInterval);
  followInterval = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const pt = screen.getCursorScreenPoint();
    overlayWindow.setPosition(
      Math.round(pt.x - CURSOR_TIP_X),
      Math.round(pt.y - CURSOR_TIP_Y),
    );
  }, 16); // ~60 fps
}

ipcMain.on('session-state',    (_e, active: boolean) => {
  if (active) console.log('[Clickify] Session active');
});

ipcMain.handle('settings:get', () => {
  const m = readMergedEnv();
  return {
    sarvam: m.SARVAM_API_KEY ?? '',
    groq: m.GROQ_API_KEY ?? '',
    gemini: m.GEMINI_API_KEY ?? '',
    llmProvider: (m.LLM_PROVIDER ?? 'groq').toLowerCase() === 'gemini' ? 'gemini' : 'groq',
  };
});

ipcMain.handle(
  'settings:save',
  async (_e, data: { sarvam: string; groq: string; gemini: string; llmProvider: string }) => {
    const llm = data.llmProvider === 'gemini' ? 'gemini' : 'groq';
    const body =
      `LLM_PROVIDER=${llm}\n` +
      `SARVAM_API_KEY=${data.sarvam.trim()}\n` +
      `GROQ_API_KEY=${data.groq.trim()}\n` +
      `GEMINI_API_KEY=${data.gemini.trim()}\n`;
    fs.mkdirSync(path.dirname(userEnvPath()), { recursive: true });
    fs.writeFileSync(userEnvPath(), body, 'utf8');
    loadEnvFiles();
    return { ok: true };
  }
);

// ─── Window creation ──────────────────────────────────────────────────────────

function createOverlay() {
  overlayWindow = new BrowserWindow({
    width: 48, height: 48,
    x: 100, y: 100,
    transparent: true, frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, movable: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  // Always ignore mouse events — the icon follows the cursor, clicks pass through
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  // Never let this window be closed by other means
  overlayWindow.on('close', (e) => { e.preventDefault(); });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === 'media'));
  startCursorFollow();
}

// ─── System Tray ─────────────────────────────────────────────────────────────

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Clickify — AI Screen Assistant', enabled: false },
    { type: 'separator' },
    { label: 'Show cursor icon', click: () => overlayWindow?.show() },
    { label: 'API keys…', click: () => createSettingsWindow() },
    { type: 'separator' },
    {
      label:   'Launch on startup',
      type:    'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked }); rebuildTrayMenu(); },
    },
    { type: 'separator' },
    { label: 'Quit Clickify', click: () => app.exit(0) },
  ]));
}

function createTray() {
  tray = new Tray(loadAppIcon());
  tray.setToolTip('Clickify — AI Screen Assistant\nCtrl+Shift+Space to talk');
  tray.on('click', () => overlayWindow?.show());
  rebuildTrayMenu();
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width:  520,
    height: 600,
    minWidth: 480,
    minHeight: 440,
    title:  'Clickify — API keys',
    icon:   loadAppIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ─── IPC: Screenshot ──────────────────────────────────────────────────────────

ipcMain.handle('capture-screenshot', async () => {
  const win = overlayWindow;
  if (!win || win.isDestroyed()) return null;

  // Never use hide(): it throttles/suspends the renderer and can freeze Web Audio,
  // which breaks voice (VAD) until restart. Opacity keeps the window "visible" for Chromium.
  let prevOpacity = 1;
  try {
    prevOpacity = win.getOpacity();
    win.setOpacity(0);
    await delay(80);
    const sources = await desktopCapturer.getSources({
      types: ['screen'], thumbnailSize: { width: 960, height: 540 },
    });
    const primaryId = screen.getPrimaryDisplay().id.toString();
    const primary   = sources.find((s) => s.display_id === primaryId) ?? sources[0];
    return primary?.thumbnail.toDataURL() ?? null;
  } catch (err) {
    console.error('Screenshot failed:', err);
    return null;
  } finally {
    const w = overlayWindow;
    if (w && !w.isDestroyed()) {
      w.setOpacity(prevOpacity);
      w.show();
      w.webContents.send('audio-resume');
    }
  }
});

// ─── IPC: Transcribe Audio ────────────────────────────────────────────────────

ipcMain.handle('transcribe-audio', async (_e, audioBuffer: ArrayBuffer) => {
  try {
    const key = process.env.SARVAM_API_KEY;
    if (!key) throw new Error('SARVAM_API_KEY not set');
    const { contentType, body } = buildMultipart(
      { model: 'saarika:v2.5', language_code: 'unknown' },
      'file', 'audio.webm', Buffer.from(audioBuffer), 'audio/webm'
    );
    const res = await nodePost(
      'https://api.sarvam.ai/speech-to-text',
      { 'api-subscription-key': key, 'Content-Type': contentType }, body
    );
    if (res.status >= 400) throw new Error(`Sarvam STT ${res.status}: ${res.text}`);
    const data = JSON.parse(res.text) as { transcript: string; language_code?: string };
    const transcript = data.transcript?.trim() ?? null;
    if (!transcript) return null;
    return { transcript, language: data.language_code ?? 'en-IN' };
  } catch (err) {
    console.error('Transcription failed:', err);
    return null;
  }
});

// ─── IPC: Ask AI (with conversation history) ──────────────────────────────────

function buildSystemPrompt(langName: string): string {
  return `You are Clickify — a real-time AI screen assistant that guides users step-by-step.

RESPONSE FORMAT — return ONLY a valid JSON object, no markdown, no code fences:
{"steps":[{"speak":"instruction"},{"speak":"next instruction"}]}

Rules:
- "steps" is an ORDERED array of 1–5 sequential spoken instructions to complete the task.
- "speak": instruction in ${langName} (1–2 natural sentences, TTS-friendly, no symbols). Describe what to do on screen in words; do not output coordinates.
- Use conversation history for context if the user is following up.
- Guide the user through the COMPLETE task — each step leads to the next.
- Respond ONLY in ${langName}. Be direct. No filler words.`;
}

ipcMain.handle(
  'ask-ai',
  async (_e, { transcript, screenshot, language }:
    { transcript: string; screenshot: string; language: string }
  ): Promise<Step[] | null> => {
    try {
      const prompt   = buildSystemPrompt(LANG_NAMES[language] ?? 'English');
      const provider = (process.env.LLM_PROVIDER ?? 'groq').toLowerCase();
      const raw      = provider === 'gemini'
        ? await callGemini(prompt, transcript, screenshot)
        : await callGroq(prompt, transcript, screenshot);

      const parsed = JSON.parse(raw) as {
        steps?: Step[];
        speak?: string;
      };

      let steps: Step[] | null = null;
      if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
        steps = parsed.steps.map((s) => ({ speak: String(s.speak ?? '') })).filter((s) => s.speak.length);
      }
      if (!steps?.length && parsed.speak) steps = [{ speak: parsed.speak }];
      if (!steps?.length) steps = null;

      if (steps) pushHistory(transcript, steps.map(s => s.speak).join(' '));
      else console.warn('[Clickify] Unexpected AI response shape — dropping');

      return steps;
    } catch (err) {
      console.error('AI request failed:', err);
      return null;
    }
  }
);

// ─── IPC: Text-to-Speech ──────────────────────────────────────────────────────

ipcMain.handle('text-to-speech', async (_e, text: string, language = 'en-IN') => {
  try {
    const key = process.env.SARVAM_API_KEY;
    if (!key) throw new Error('SARVAM_API_KEY not set');
    const body = Buffer.from(JSON.stringify({
      text,
      target_language_code: language,
      speaker: LANG_SPEAKERS[language] ?? 'shubh',
      model: 'bulbul:v3',
      pace: 1.15,
      speech_sample_rate: 22050,
    }));
    const res = await nodePost(
      'https://api.sarvam.ai/text-to-speech',
      { 'api-subscription-key': key, 'Content-Type': 'application/json' }, body
    );
    if (res.status >= 400) throw new Error(`Sarvam TTS ${res.status}: ${res.text}`);
    return (JSON.parse(res.text) as { audios: string[] }).audios?.[0] ?? null;
  } catch (err) {
    console.error('TTS failed:', err);
    return null;
  }
});

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // No File / Edit / View menu — keeps windows (e.g. API keys) minimal.
  Menu.setApplicationMenu(null);

  loadEnvFiles();

  const provider = (process.env.LLM_PROVIDER ?? 'groq').toLowerCase();
  if (provider === 'gemini' && !process.env.GEMINI_API_KEY) console.warn('[Clickify] GEMINI_API_KEY missing');
  if (provider === 'groq'   && !process.env.GROQ_API_KEY)   console.warn('[Clickify] GROQ_API_KEY missing');
  if (!process.env.SARVAM_API_KEY) console.warn('[Clickify] SARVAM_API_KEY missing');

  createOverlay();
  createTray();

  if (missingRequiredApiKeys()) createSettingsWindow();

  // Ctrl+Shift+Space — push-to-talk toggle
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    overlayWindow?.webContents.send('ptt-toggle');
  });
});

app.on('window-all-closed', () => { /* tray keeps the app alive */ });
app.on('will-quit',         () => globalShortcut.unregisterAll());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }
