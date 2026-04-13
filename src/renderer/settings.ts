interface SettingsPayload {
  sarvam: string;
  groq: string;
  gemini: string;
  llmProvider: string;
}

interface SettingsAPI {
  get: () => Promise<SettingsPayload>;
  save: (data: SettingsPayload) => Promise<{ ok: boolean }>;
}

const settingsApi = (window as unknown as { clickifySettings: SettingsAPI }).clickifySettings;

function el<T extends HTMLElement>(id: string): T {
  const n = document.getElementById(id);
  if (!n) throw new Error(`#${id}`); return n as T;
}

const LLM_COPY: Record<string, string> = {
  groq:
    'Uses Groq’s Llama vision model. Enter your Groq API key in the field below.',
  gemini:
    'Uses Google Gemini 2.0 Flash for vision. Enter your Gemini API key in the field below.',
};

function setLlmUi(provider: 'groq' | 'gemini') {
  el<HTMLInputElement>('llmProvider').value = provider;
  el<HTMLButtonElement>('btn-llm-groq').classList.toggle('active', provider === 'groq');
  el<HTMLButtonElement>('btn-llm-gemini').classList.toggle('active', provider === 'gemini');
  el<HTMLElement>('panel-groq').hidden = provider !== 'groq';
  el<HTMLElement>('panel-gemini').hidden = provider !== 'gemini';
  el<HTMLParagraphElement>('llm-desc').textContent = LLM_COPY[provider];
}

async function load() {
  const s = await settingsApi.get();
  el<HTMLInputElement>('sarvam').value = s.sarvam;
  el<HTMLInputElement>('groq').value = s.groq;
  el<HTMLInputElement>('gemini').value = s.gemini;
  const p = s.llmProvider === 'gemini' ? 'gemini' : 'groq';
  setLlmUi(p);
}

el<HTMLButtonElement>('btn-llm-groq').addEventListener('click', () => setLlmUi('groq'));
el<HTMLButtonElement>('btn-llm-gemini').addEventListener('click', () => setLlmUi('gemini'));

document.querySelectorAll<HTMLButtonElement>('.toggle-vis').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-target');
    if (!id) return;
    const input = el<HTMLInputElement>(id);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'Show' : 'Hide';
  });
});

function validate(): string | null {
  const sarvam = el<HTMLInputElement>('sarvam').value.trim();
  const groq = el<HTMLInputElement>('groq').value.trim();
  const gemini = el<HTMLInputElement>('gemini').value.trim();
  const llm = el<HTMLInputElement>('llmProvider').value;
  if (!sarvam) return 'Sarvam API key is required for speech.';
  if (llm === 'groq' && !groq) return 'Groq API key is required when Groq is selected.';
  if (llm === 'gemini' && !gemini) return 'Gemini API key is required when Gemini is selected.';
  return null;
}

el<HTMLFormElement>('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = el<HTMLDivElement>('msg');
  const err = validate();
  if (err) { msg.textContent = err; msg.className = 'err'; return; }
  msg.textContent = '';
  await settingsApi.save({
    sarvam: el<HTMLInputElement>('sarvam').value.trim(),
    groq: el<HTMLInputElement>('groq').value.trim(),
    gemini: el<HTMLInputElement>('gemini').value.trim(),
    llmProvider: el<HTMLInputElement>('llmProvider').value,
  });
  msg.textContent = 'Saved. You can close this window.';
  msg.className = 'ok';
});

void load();
