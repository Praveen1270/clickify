import { contextBridge, ipcRenderer } from 'electron';

export interface Step {
  speak: string;
}

contextBridge.exposeInMainWorld('clickify', {
  captureScreenshot: (): Promise<string | null> =>
    ipcRenderer.invoke('capture-screenshot'),

  transcribeAudio: (buf: ArrayBuffer): Promise<{ transcript: string; language: string } | null> =>
    ipcRenderer.invoke('transcribe-audio', buf),

  askAI: (transcript: string, screenshot: string, language: string): Promise<Step[] | null> =>
    ipcRenderer.invoke('ask-ai', { transcript, screenshot, language }),

  textToSpeech: (text: string, language: string): Promise<string | null> =>
    ipcRenderer.invoke('text-to-speech', text, language),

  setSessionState: (active: boolean): void =>
    ipcRenderer.send('session-state', active),

  // Push-to-talk: Ctrl+Shift+Space from main → toggle recording
  onPTT: (cb: () => void): void => {
    ipcRenderer.on('ptt-toggle', () => cb());
  },

  onAudioResume: (cb: () => void): void => {
    ipcRenderer.on('audio-resume', () => cb());
  },
});

export interface SettingsPayload {
  sarvam: string;
  groq: string;
  gemini: string;
  llmProvider: string;
}

contextBridge.exposeInMainWorld('clickifySettings', {
  get: (): Promise<SettingsPayload> => ipcRenderer.invoke('settings:get'),
  save: (data: SettingsPayload): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('settings:save', data),
});
