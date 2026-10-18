// AI providers with automatic fallback.
// Sarvam is used first. If it fails (credits used up, rate limit, outage), the same request goes to a
// free provider instead: Groq (gpt-oss-120b chat, Whisper speech-to-text) and Google Gemini
// (Flash chat, Flash TTS, photo reading). AI_PROVIDER=free skips Sarvam entirely; =sarvam disables fallback.

const SARVAM = process.env.SARVAM_BASE_URL || 'https://api.sarvam.ai';
const GROQ = 'https://api.groq.com/openai/v1';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const GROQ_CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-120b';
const GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-flash-lite-latest';
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts';
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-flash-latest';
const SARVAM_SPEAKER = process.env.TTS_SPEAKER || 'priya';

export class ApiError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

const keys = {
  sarvam: () => process.env.SARVAM_API_KEY,
  groq: () => process.env.GROQ_API_KEY,
  gemini: () => process.env.GEMINI_API_KEY,
};

// After Sarvam says "no" (no credits, bad key, rate limit), skip it for a while instead of
// paying its latency on every request. Per server instance.
let sarvamPausedUntil = 0;
function noteFailure(provider, err) {
  if (provider === 'sarvam' && [401, 402, 403, 429].includes(err.upstream)) sarvamPausedUntil = Date.now() + 10 * 60 * 1000;
}

// providers to try, in order, for one capability
function order(capable) {
  const mode = (process.env.AI_PROVIDER || 'auto').toLowerCase();
  const list = mode === 'free' ? capable.filter((p) => p !== 'sarvam') : mode === 'sarvam' ? ['sarvam'] : capable;
  const usable = list.filter((p) => keys[p]());
  if (usable.length > 1 && usable[0] === 'sarvam' && Date.now() < sarvamPausedUntil) usable.push(usable.shift());
  if (!usable.length) throw new ApiError('No AI provider is configured. Add SARVAM_API_KEY, GROQ_API_KEY or GEMINI_API_KEY.', 500);
  return usable;
}

async function tryInOrder(capable, fns) {
  let first;
  for (const p of order(capable)) {
    try { return await fns[p](); }
    catch (e) {
      noteFailure(p, e);
      first ??= e;
      console.warn(`[ai] ${p} failed: ${e.message}`);
    }
  }
  throw first;
}

async function call(url, init, who) {
  let r;
  try { r = await fetch(url, init); }
  catch { throw new ApiError(`Could not reach ${who}. Check the internet connection.`, 502); }
  if (r.ok) return r;
  let detail = '';
  try { const b = await r.json(); detail = b?.error?.message || b?.message || ''; } catch { /* not JSON */ }
  const msg = r.status === 429 ? `${who} rate limit or quota reached. Wait a moment and try again.`
    : r.status === 401 || r.status === 403 ? `${who} rejected the API key.`
      : `${who} returned ${r.status}${detail ? `: ${detail}` : ''}`;
  throw Object.assign(new ApiError(msg, 502), { upstream: r.status });
}

const clean = (text) => {
  if (typeof text !== 'string' || !text.trim()) throw new ApiError('The model returned an empty answer. Please try again.');
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // smaller free models sometimes slip Chinese/Japanese characters into Indian-language replies; let the next provider answer
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) throw new ApiError('The model mixed in characters from another language.');
  return text;
};

// ---------- chat ----------
// reasoning: Sarvam 105B thinks for 5-15 s by default; false turns that off for quick tasks.
export function chat(messages, { maxTokens = 1500, reasoning = false, model = 'sarvam-105b' } = {}) {
  return tryInOrder(['sarvam', 'groq', 'gemini'], {
    sarvam: async () => {
      const r = await call(`${SARVAM}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'api-subscription-key': keys.sarvam() },
        body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: maxTokens, ...(reasoning ? {} : { reasoning_effort: null }) }),
      }, 'Sarvam');
      return clean((await r.json())?.choices?.[0]?.message?.content);
    },
    groq: async () => {
      const r = await call(`${GROQ}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keys.groq()}` },
        body: JSON.stringify({ model: GROQ_CHAT_MODEL, messages, temperature: 0.1, max_tokens: Math.max(maxTokens, 1500), reasoning_effort: reasoning ? 'medium' : 'low' }),
      }, 'Groq');
      return clean((await r.json())?.choices?.[0]?.message?.content);
    },
    gemini: async () => {
      const r = await call(`${GEMINI}/openai/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keys.gemini()}` },
        body: JSON.stringify({ model: GEMINI_CHAT_MODEL, messages, temperature: 0.1, max_tokens: Math.max(maxTokens, 1500) }),
      }, 'Gemini');
      return clean((await r.json())?.choices?.[0]?.message?.content);
    },
  });
}

// ---------- speech to text ----------
const WHISPER_LANGS = { hindi: 'hi-IN', english: 'en-IN', bengali: 'bn-IN', tamil: 'ta-IN', telugu: 'te-IN', kannada: 'kn-IN', malayalam: 'ml-IN', marathi: 'mr-IN', gujarati: 'gu-IN', punjabi: 'pa-IN', odia: 'od-IN', urdu: 'ur-IN' };

export function transcribe(file, names = []) {
  const mime = (file.mimetype || 'audio/webm').split(';')[0];
  const blob = () => new Blob([file.buffer], { type: mime });
  const done = (transcript, language_code) => {
    transcript = (transcript || '').trim();
    if (!transcript) throw new ApiError('Could not hear any speech. Try again closer to the mic.', 422);
    return { transcript, language_code: language_code ?? null };
  };
  return tryInOrder(['sarvam', 'groq'], {
    sarvam: async () => {
      const form = new FormData();
      form.append('file', blob(), file.originalname || 'speech.webm');
      form.append('model', 'saaras:v4');
      form.append('language_code', 'unknown'); // auto-detect any of 22 Indian languages, English, or a mix
      if (names.length) form.append('keyterms', JSON.stringify(names)); // bias toward known names
      const r = await call(`${SARVAM}/speech-to-text`, { method: 'POST', headers: { 'api-subscription-key': keys.sarvam() }, body: form }, 'Sarvam');
      const d = await r.json();
      return done(d?.transcript, d?.language_code);
    },
    groq: async () => {
      const whisper = async (language) => {
        const form = new FormData();
        form.append('file', blob(), file.originalname || 'speech.webm');
        form.append('model', 'whisper-large-v3');
        form.append('response_format', 'verbose_json');
        if (language) form.append('language', language);
        // the prompt nudges spelling: number words written apart ("दो सौ", not "दोसों") and known names
        form.append('prompt', `दो सौ, ढाई सौ, डेढ़ सौ, पाँच सौ, हज़ार, रुपये, घंटे, मिनट.${names.length ? ` Names: ${names.slice(0, 30).join(', ')}.` : ''}`);
        const r = await call(`${GROQ}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${keys.groq()}` }, body: form }, 'Groq');
        return r.json();
      };
      let d = await whisper();
      // spoken Hindi and Urdu sound the same; Whisper often writes Hindi in Urdu script, so redo it as Hindi
      if (String(d?.language).toLowerCase() === 'urdu') d = { ...(await whisper('hi')), language: 'hindi' };
      return done(d?.text, WHISPER_LANGS[String(d?.language || '').toLowerCase()]);
    },
  });
}

// ---------- text to speech ----------
// Returns a data: URI ready for <audio src>, or throws. Callers that can live without audio use
// speakQuietly(); the browser then reads the text aloud itself.
function pcmToWav(b64, rate = 24000) {
  const pcm = Buffer.from(b64, 'base64');
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]).toString('base64');
}

export function speak(text, languageCode = 'hi-IN') {
  text = String(text).slice(0, 2500);
  return tryInOrder(['sarvam', 'gemini'], {
    sarvam: async () => {
      const r = await call(`${SARVAM}/text-to-speech`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'api-subscription-key': keys.sarvam() },
        body: JSON.stringify({ text, language_code: languageCode, model: 'bulbul:v3', speaker: SARVAM_SPEAKER, output_audio_codec: 'mp3' }),
      }, 'Sarvam');
      const audio = (await r.json())?.audios?.[0];
      if (!audio) throw new ApiError('Sarvam returned no audio.');
      return `data:audio/mpeg;base64,${audio}`;
    },
    gemini: async () => {
      const r = await call(`${GEMINI}/models/${GEMINI_TTS_MODEL}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys.gemini() },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } },
        }),
      }, 'Gemini');
      const part = (await r.json())?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
      if (!part?.data) throw new ApiError('Gemini returned no audio.');
      if (/wav/i.test(part.mimeType)) return `data:audio/wav;base64,${part.data}`;
      const rate = Number(/rate=(\d+)/.exec(part.mimeType || '')?.[1]) || 24000; // raw 16-bit PCM
      return `data:audio/wav;base64,${pcmToWav(part.data, rate)}`;
    },
  });
}
export const speakQuietly = (text, code) => speak(text, code).catch(() => null);

// ---------- reading a photo (free fallback for document scanning) ----------
export async function readImageWithGemini(buffer, mime, prompt) {
  if (!keys.gemini()) throw new ApiError('No free photo reader is configured (GEMINI_API_KEY).', 503);
  const r = await call(`${GEMINI}/models/${GEMINI_VISION_MODEL}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys.gemini() },
    body: JSON.stringify({
      contents: [{ parts: [{ inlineData: { mimeType: mime, data: buffer.toString('base64') } }, { text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
    }),
  }, 'Gemini');
  return clean((await r.json())?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join(''));
}

export const providerKeys = () => ({ sarvam: !!keys.sarvam(), groq: !!keys.groq(), gemini: !!keys.gemini(), mode: process.env.AI_PROVIDER || 'auto' });
