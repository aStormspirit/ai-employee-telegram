// Расшифровка голосовых через OpenAI-совместимый API (POST multipart: file, model, language → { text }).
import { stt } from './config.mjs';

export const sttEnabled = Boolean(stt);

export async function transcribe(data, filename = 'voice.ogg') {
  const form = new FormData();
  form.append('file', new Blob([data], { type: 'audio/ogg' }), filename);
  form.append('model', stt.model);
  if (stt.language) form.append('language', stt.language);
  const res = await fetch(stt.url, { method: 'POST', headers: { authorization: `Bearer ${stt.key}` }, body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`STT: HTTP ${res.status} ${body?.error?.message || ''}`.trim());
  return String(body.text || '').trim();
}
