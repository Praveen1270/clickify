// ─── API Bridge ───────────────────────────────────────────────────────────────

interface Step {
  speak: string;
}

interface ClickifyAPI {
  captureScreenshot: () => Promise<string | null>;
  transcribeAudio:   (buf: ArrayBuffer) => Promise<{ transcript: string; language: string } | null>;
  askAI:             (transcript: string, screenshot: string, language: string) => Promise<Step[] | null>;
  textToSpeech:      (text: string, language: string) => Promise<string | null>;
  setSessionState:   (active: boolean) => void;
  onPTT:             (cb: () => void) => void;
  onAudioResume:     (cb: () => void) => void;
}

const api = (window as unknown as { clickify: ClickifyAPI }).clickify;

// ─── State ────────────────────────────────────────────────────────────────────

type AppState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';
let state: AppState = 'idle';
const orb = document.getElementById('orb') as HTMLDivElement;

function setState(next: AppState) {
  state = next;
  orb.className = next;
  api.setSessionState(next !== 'idle');
}

// ─── Stop-command detection ───────────────────────────────────────────────────

const STOP_PHRASES = [
  'stop', 'stop it', 'cancel', 'quit', 'enough', 'shut up', 'be quiet', 'silence',
  'రుకో', 'రుక జాఓ', 'ఆపు', 'ఆపండి', 'చాలు', 'మాట్లాడకు',
  'रुको', 'रुक जाओ', 'बंद करो', 'चुप', 'बस',
];

function isStopCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  return STOP_PHRASES.some((p) => t === p || t.startsWith(p + ' ') || t.endsWith(' ' + p));
}

// ─── VAD loop ─────────────────────────────────────────────────────────────────

let micStream:    MediaStream | null = null;
let busy          = false;
let currentAudio: HTMLAudioElement | null = null;

async function init() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    setState('idle');

    // Ctrl+Shift+Space push-to-talk
    api.onPTT(() => handlePTT());

    runLoop();
  } catch {
    setState('error');
  }
}

function runLoop() {
  const audioCtx = new AudioContext();
  const resumeAudio = () => {
    if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => {});
  };
  resumeAudio();
  api.onAudioResume(resumeAudio);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumeAudio();
  });

  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  audioCtx.createMediaStreamSource(micStream!).connect(analyser);

  const pcmData = new Uint8Array(analyser.frequencyBinCount);
  let recording = false;
  let recorder:  MediaRecorder | null = null;
  let chunks:    Blob[] = [];
  let silTimer:  ReturnType<typeof setTimeout> | null = null;

  function tick() {
    if (busy) { setTimeout(() => requestAnimationFrame(tick), 200); return; }

    analyser.getByteTimeDomainData(pcmData);
    const rms = calcRMS(pcmData);

    if (rms > 8 && !recording) {
      recording = true; chunks = [];
      recorder = new MediaRecorder(micStream!, { mimeType: bestMime() });
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.start();
      setState('listening');

    } else if (rms > 8 && recording) {
      if (silTimer) { clearTimeout(silTimer); silTimer = null; }

    } else if (rms <= 8 && recording && !silTimer) {
      silTimer = setTimeout(() => {
        if (!recorder || recorder.state !== 'recording') return;
        recording = false; busy = true;
        recorder.onstop = async () => {
          setState('thinking');
          try { await runPipeline(chunks); }
          catch (err) {
            console.error('[Clickify]', err);
            setState('error');
            await sleep(1000);
          }
          busy = false; silTimer = null;
          setState('idle');
          requestAnimationFrame(tick);
        };
        recorder.stop();
      }, 900);
    }

    if (!busy) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

// ─── Push-to-Talk handler ─────────────────────────────────────────────────────

let pttRecording = false;
let pttRecorder:  MediaRecorder | null = null;
let pttChunks:    Blob[] = [];

function handlePTT() {
  if (busy || !micStream) return;

  if (!pttRecording) {
    pttRecording = true;
    pttChunks = [];
    pttRecorder = new MediaRecorder(micStream!, { mimeType: bestMime() });
    pttRecorder.ondataavailable = (e) => { if (e.data.size > 0) pttChunks.push(e.data); };
    pttRecorder.start();
    setState('listening');
  } else {
    if (!pttRecorder || pttRecorder.state !== 'recording') { pttRecording = false; return; }
    pttRecording = false;
    busy = true;
    pttRecorder.onstop = async () => {
      setState('thinking');
      try { await runPipeline(pttChunks); }
      catch (err) {
        console.error('[Clickify PTT]', err);
        setState('error');
        await sleep(1000);
      }
      busy = false;
      setState('idle');
    };
    pttRecorder.stop();
  }
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async function runPipeline(chunks: Blob[]) {
  const blob = new Blob(chunks, { type: chunks[0]?.type ?? 'audio/webm' });
  const [screenshot, stt] = await Promise.all([
    api.captureScreenshot(),
    blob.arrayBuffer().then((ab) => api.transcribeAudio(ab)),
  ]);

  if (!stt) throw new Error('Nothing heard — speak a bit louder.');
  const { transcript, language } = stt;

  if (isStopCommand(transcript)) {
    stopAudio();
    return;
  }

  const steps = await api.askAI(transcript, screenshot ?? '', language);
  if (!steps || steps.length === 0) throw new Error('No AI response.');

  // Pre-generate TTS for all steps in parallel
  const ttsJobs = steps.map((s) => api.textToSpeech(s.speak, language));

  setState('speaking');

  for (let i = 0; i < steps.length; i++) {
    const base64 = await ttsJobs[i];
    if (!base64) throw new Error(`TTS failed on step ${i + 1}.`);
    await playWav(base64);

    if (i < steps.length - 1) await sleep(800);
  }
}

// ─── Audio helpers ────────────────────────────────────────────────────────────

function stopAudio() {
  if (currentAudio) { currentAudio.pause(); currentAudio.src = ''; currentAudio = null; }
}

function playWav(base64: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stopAudio();
    const audio = new Audio(`data:audio/wav;base64,${base64}`);
    currentAudio = audio;
    audio.onended = () => { currentAudio = null; resolve(); };
    audio.onerror = () => { currentAudio = null; reject(new Error('Playback failed.')); };
    audio.play().catch(reject);
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function calcRMS(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += (data[i] - 128) ** 2;
  return Math.sqrt(sum / data.length);
}

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

function bestMime(): string {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return 'audio/webm';
}

init();
