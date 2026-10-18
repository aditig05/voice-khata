import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } }); // Vercel caps request bodies at 4.5 MB

// SARVAM_BASE_URL is only overridden in local tests (mock server). Default is the real API.
const BASE = process.env.SARVAM_BASE_URL || 'https://api.sarvam.ai';
const CHAT_MODEL = 'sarvam-105b';
const STT_MODEL = 'saaras:v4';
const TYPES = new Set(['udhaar', 'jama', 'kharcha']);

// Languages Bulbul can speak. Saaras understands more (22 Indian languages + English) and
// auto-detects them, so any of those works for input; this list is for spoken/written replies.
const LANGUAGES = {
  'hi-IN': { name: 'Hindi', script: 'Devanagari' },
  'en-IN': { name: 'English', script: 'Latin' },
  'bn-IN': { name: 'Bengali', script: 'Bengali' },
  'ta-IN': { name: 'Tamil', script: 'Tamil' },
  'te-IN': { name: 'Telugu', script: 'Telugu' },
  'kn-IN': { name: 'Kannada', script: 'Kannada' },
  'ml-IN': { name: 'Malayalam', script: 'Malayalam' },
  'mr-IN': { name: 'Marathi', script: 'Devanagari' },
  'gu-IN': { name: 'Gujarati', script: 'Gujarati' },
  'pa-IN': { name: 'Punjabi', script: 'Gurmukhi' },
  'od-IN': { name: 'Odia', script: 'Odia' },
};
const langCode = (l) => (LANGUAGES[l] ? l : 'hi-IN');

app.set('trust proxy', true); // behind Vercel / Render proxies, so req.ip is the visitor's address
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public'))); // local only; Vercel serves public/ from its CDN

// Every /api call spends Sarvam credits, so cap each visitor. In-memory, per server instance: a
// speed bump for a public demo, not a hard quota.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = Number(process.env.RATE_LIMIT_PER_10_MIN) || 40;
const hits = new Map();
app.use('/api', (req, res, next) => {
  const now = Date.now();
  if (hits.size > 5000) for (const [ip, h] of hits) if (h.reset < now) hits.delete(ip);
  const h = hits.get(req.ip);
  if (!h || h.reset < now) { hits.set(req.ip, { count: 1, reset: now + RATE_WINDOW_MS }); return next(); }
  if (++h.count > RATE_MAX) return res.status(429).json({ error: 'Too many requests from this device. Please wait a few minutes and try again.' });
  next();
});

class ApiError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function requireKey() {
  if (!process.env.SARVAM_API_KEY) {
    throw new ApiError('Server is missing SARVAM_API_KEY. Add it to .env and restart.', 500);
  }
  return process.env.SARVAM_API_KEY;
}

// fetch() throws a bare "fetch failed" on network problems; turn it into something a user can act on.
async function callSarvam(url, init) {
  try { return await fetch(url, init); }
  catch { throw new ApiError('Could not reach Sarvam. Check the internet connection and try again.', 502); }
}

async function sarvamError(r) {
  let msg = `Sarvam API returned ${r.status}`;
  try {
    const body = await r.json();
    const detail = body?.error?.message || body?.message;
    if (detail) msg += `: ${detail}`;
  } catch { /* body was not JSON */ }
  if (r.status === 429) msg = 'Sarvam rate limit or quota reached. Wait a moment and try again.';
  if (r.status === 401 || r.status === 403) msg = 'Sarvam rejected the API key. Check SARVAM_API_KEY.';
  return new ApiError(msg, 502);
}

// sarvam-105b is a reasoning model: hidden thinking counts against max_tokens (often 1-3k),
// so a small cap leaves `content` null. Keep the budget generous.
async function chat(messages, { maxTokens = 8000 } = {}) {
  const key = requireKey();
  const r = await callSarvam(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-subscription-key': key },
    body: JSON.stringify({ model: CHAT_MODEL, messages, temperature: 0.1, max_tokens: maxTokens }),
  });
  if (!r.ok) throw await sarvamError(r);
  const data = await r.json();
  let text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new ApiError('The model returned an empty answer. Please try again.');
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no json');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function cleanNames(value) {
  let arr = value;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
  if (!Array.isArray(arr)) return [];
  return arr.filter((n) => typeof n === 'string' && n.trim() && n.length <= 64).map((n) => n.trim()).slice(0, 50);
}

function normalizeEntries(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((e) => ({
      customer: typeof e?.customer === 'string' ? e.customer.trim().slice(0, 64) : '',
      type: String(e?.type || '').toLowerCase(),
      amount: Math.round(Number(e?.amount) * 100) / 100,
      note: typeof e?.note === 'string' ? e.note.trim().slice(0, 120) : '',
    }))
    .filter((e) => TYPES.has(e.type) && Number.isFinite(e.amount) && e.amount > 0)
    .map((e) => (e.type === 'kharcha' ? { ...e, customer: '' } : e))
    .filter((e) => e.type === 'kharcha' || e.customer);
}

// 1) Speech -> text (Sarvam Saaras)
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    const key = requireKey();
    if (!req.file || !req.file.size) throw new ApiError('No audio received. Tap the mic, speak, then tap again.', 400);

    const mime = (req.file.mimetype || 'audio/webm').split(';')[0];
    const form = new FormData();
    form.append('file', new Blob([req.file.buffer], { type: mime }), req.file.originalname || 'speech.webm');
    form.append('model', STT_MODEL);
    form.append('language_code', 'unknown'); // auto-detect Hindi / English / mixed
    const names = cleanNames(req.body?.names);
    if (names.length) form.append('keyterms', JSON.stringify(names)); // bias toward known customer names

    const r = await callSarvam(`${BASE}/speech-to-text`, {
      method: 'POST',
      headers: { 'api-subscription-key': key },
      body: form,
    });
    if (!r.ok) throw await sarvamError(r);
    const data = await r.json();
    const transcript = (data?.transcript || '').trim();
    if (!transcript) throw new ApiError('Could not hear any speech. Try again closer to the mic.', 422);
    res.json({ transcript, language_code: data.language_code ?? null });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Transcription failed.' });
  }
});

const PARSE_SYSTEM = `You are the bookkeeping assistant of an Indian kirana (neighbourhood) shop. The shopkeeper may speak any Indian language (Hindi, Tamil, Bengali, Marathi, Telugu, ...), English, or a mix, and the text may contain speech-recognition mistakes. Extract every money entry.

Entry types:
- "udhaar": a customer took goods on credit and still owes the shop (e.g. "Ramesh ne 200 ka udhaar liya", "Ramesh ko 200 ka saman diya udhaar").
- "jama": a customer paid money back / paid dues (e.g. "Sunita ne 150 wapas kiye", "Sunita ne 150 diye").
- "kharcha": a shop expense not tied to a customer (e.g. "bijli bill 800", "transport 300").

Rules:
- Write customer names in Latin letters (English spelling), e.g. "Ramesh", "Sunita Devi". If a name matches or sounds like one in the known customer list, use exactly that spelling.
- amount is a positive number in rupees. Convert spoken numbers in any language ("do sau" = 200, "dedh sau" = 150, "dhai sau" = 250, "இருநூறு" = 200).
- note is a few words about what it was for (e.g. "atta, chini"); use "" if none. Keep the note in the language it was spoken in.
- For "kharcha", customer must be "".
- If the text has no money entry, or something is too unclear to record, return an empty entries list and explain briefly in "unclear".
- Reply with ONLY a JSON object, no markdown, no explanation:
{"entries":[{"customer":"","type":"udhaar|jama|kharcha","amount":0,"note":""}],"unclear":""}`;

// 2) Text -> structured khata entries (Sarvam 105B)
app.post('/api/parse', async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 1500) : '';
    if (!text) throw new ApiError('Nothing to read. Speak or type an entry first.', 400);
    const known = cleanNames(req.body?.customers);

    const answer = await chat([
      { role: 'system', content: PARSE_SYSTEM },
      { role: 'user', content: `Known customers: ${known.length ? known.join(', ') : '(none yet)'}\n\nShopkeeper said: """${text}"""` },
    ]);

    let parsed;
    try { parsed = extractJson(answer); }
    catch { throw new ApiError('Could not understand the model reply. Please say it again.', 502); }

    const entries = normalizeEntries(parsed.entries);

    res.json({ entries, unclear: typeof parsed.unclear === 'string' ? parsed.unclear.trim() : '' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Could not read the entry.' });
  }
});

const reminderLanguage = (l) => (l === 'hinglish' ? 'Hinglish (Hindi in Roman letters)'
  : l === 'en-IN' ? 'English'
  : LANGUAGES[l] ? `${LANGUAGES[l].name}, written entirely in ${LANGUAGES[l].script} script (not Roman letters)` : 'Hindi, written entirely in Devanagari script (not Roman letters)');

// 3) Draft a polite payment reminder (Sarvam 105B)
app.post('/api/reminder', async (req, res) => {
  try {
    const customer = typeof req.body?.customer === 'string' ? req.body.customer.trim().slice(0, 64) : '';
    const balance = Number(req.body?.balance);
    const shop = typeof req.body?.shop === 'string' ? req.body.shop.trim().slice(0, 64) : '';
    const language = reminderLanguage(req.body?.language);
    if (!customer || !Number.isFinite(balance) || balance <= 0) throw new ApiError('A customer with a pending balance is required.', 400);

    const message = await chat([
      {
        role: 'system',
        content: 'You write short, warm, respectful WhatsApp payment reminders for a small neighbourhood shop in India. Never threaten or shame. 2 to 3 sentences. Reply with only the message text, nothing else.',
      },
      {
        role: 'user',
        content: `Write the reminder in ${language}. Customer: ${customer}. Pending amount: Rs ${balance}. ${shop ? `Shop name: ${shop}.` : ''} Thank them for their business and ask them to clear the amount when convenient.`,
      },
    ], { maxTokens: 6000 });

    res.json({ message });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Could not draft the reminder.' });
  }
});

// ---------- Text -> speech (Sarvam Bulbul) ----------
const TTS_MODEL = 'bulbul:v3';
const TTS_SPEAKER = process.env.TTS_SPEAKER || 'priya';

async function speak(text, languageCode = 'hi-IN') {
  const key = requireKey();
  const r = await callSarvam(`${BASE}/text-to-speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-subscription-key': key },
    body: JSON.stringify({
      text: text.slice(0, 2500), language_code: languageCode, model: TTS_MODEL, speaker: TTS_SPEAKER,
      output_audio_codec: 'mp3',
    }),
  });
  if (!r.ok) throw await sarvamError(r);
  const data = await r.json();
  const audio = data?.audios?.[0];
  if (!audio) throw new ApiError('Sarvam returned no audio. Please try again.');
  return audio; // base64 mp3
}


app.post('/api/speak', async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) throw new ApiError('Nothing to speak.', 400);
    res.json({ audio: await speak(text, langCode(req.body?.language_code)) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Could not make the audio.' });
  }
});

// ---------- Talking khata: answer a question from the ledger, then speak it ----------
function ledgerBrief(ctx) {
  const people = (Array.isArray(ctx?.people) ? ctx.people : []).slice(0, 60)
    .map((p) => `- ${String(p.name).slice(0, 64)}: ${Number(p.balance) > 0 ? 'owes Rs ' + Number(p.balance) : Number(p.balance) < 0 ? 'advance Rs ' + -Number(p.balance) : 'settled'}`);
  const recent = (Array.isArray(ctx?.recent) ? ctx.recent : []).slice(0, 80)
    .map((e) => `- ${String(e.date).slice(0, 10)} | ${e.type} | ${e.customer || 'shop'} | Rs ${Number(e.amount)} | ${String(e.note || '').slice(0, 60)}`);
  return `Today: ${String(ctx?.today || '').slice(0, 10)}
Totals: to receive Rs ${Number(ctx?.owed) || 0}; received today Rs ${Number(ctx?.receivedToday) || 0}; received this week Rs ${Number(ctx?.receivedWeek) || 0}; shop expenses Rs ${Number(ctx?.expenses) || 0}.
Customer balances:
${people.join('\n') || '(none)'}
Entries (newest first):
${recent.join('\n') || '(none)'}`;
}

app.post('/api/ask', async (req, res) => {
  try {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim().slice(0, 500) : '';
    if (!question) throw new ApiError('Ask something first.', 400);
    const code = langCode(req.body?.language_code);
    const { name, script } = LANGUAGES[code];

    const answer = await chat([
      {
        role: 'system',
        content: `You are the khata assistant of a kirana shop, speaking to the shopkeeper. Answer ONLY from the ledger data given. If the data does not contain the answer, say so plainly; never invent numbers. Be brief: 1 to 3 short sentences, easy to listen to. Write amounts as digits with the word for rupees in the reply language (e.g. "2,500 rupees" / "2,500 रुपये"). ${code === 'en-IN' ? 'Reply in simple English.' : `Reply in simple ${name}, written entirely in ${script} script, including customer names, because the answer will be read aloud.`} No markdown, no lists, no emojis.`,
      },
      { role: 'user', content: `${ledgerBrief(req.body?.context)}\n\nQuestion: ${question}` },
    ], { maxTokens: 6000 });

    let audio = null;
    try { audio = await speak(answer, code); } catch { /* text answer is still useful */ }
    res.json({ answer, audio });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Could not answer.' });
  }
});

// ---------- Trust insights: who is likely to pay late, and how to nudge ----------
app.post('/api/insights', async (req, res) => {
  try {
    const stats = (Array.isArray(req.body?.customers) ? req.body.customers : []).slice(0, 25).map((c) => ({
      customer: String(c.customer).slice(0, 64),
      balance: Number(c.balance) || 0,
      total_credit_given: Number(c.given) || 0,
      total_paid_back: Number(c.paid) || 0,
      times_credit: Number(c.udhaarCount) || 0,
      times_paid: Number(c.jamaCount) || 0,
      days_since_last_credit: c.daysSinceCredit ?? null,
      days_since_last_payment: c.daysSincePayment ?? null,
      days_oldest_unpaid: c.daysOldestUnpaid ?? null,
    })).filter((c) => c.customer && c.balance > 0);
    if (!stats.length) throw new ApiError('No pending balances to analyse.', 400);

    const answer = await chat([
      {
        role: 'system',
        content: `You advise a kirana shopkeeper on credit risk using each customer's payment history. For every customer decide risk: "low" (pays regularly or balance is small and recent), "medium", or "high" (large or old balance, rarely or never pays back). Give "why" in at most 14 words citing the actual numbers, and "nudge": one practical, respectful suggestion (when/how to remind, or whether to limit further credit). Reply with ONLY JSON: {"insights":[{"customer":"","risk":"low|medium|high","why":"","nudge":""}]}`,
      },
      { role: 'user', content: JSON.stringify(stats) },
    ], { maxTokens: 8000 });

    let parsed;
    try { parsed = extractJson(answer); }
    catch { throw new ApiError('Could not understand the model reply. Please try again.', 502); }
    const names = new Set(stats.map((c) => c.customer.toLowerCase()));
    const insights = (Array.isArray(parsed.insights) ? parsed.insights : [])
      .filter((i) => typeof i?.customer === 'string' && names.has(i.customer.trim().toLowerCase()))
      .map((i) => ({
        customer: i.customer.trim(),
        risk: ['low', 'medium', 'high'].includes(String(i.risk).toLowerCase()) ? String(i.risk).toLowerCase() : 'medium',
        why: String(i.why || '').slice(0, 200),
        nudge: String(i.nudge || '').slice(0, 240),
      }));
    res.json({ insights });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Could not analyse customers.' });
  }
});

// ---------- Scan a paper bahi-khata page (Sarvam Document AI) ----------
const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      description: 'Every handwritten or printed ledger line on the page, top to bottom.',
      items: {
        type: 'object',
        properties: {
          customer: { type: 'string', description: 'Customer name written in Latin letters. Empty for shop expenses.' },
          type: { type: 'string', enum: ['udhaar', 'jama', 'kharcha'], description: 'udhaar = goods given on credit (customer owes), jama = customer paid money back, kharcha = shop expense.' },
          amount: { type: 'number', description: 'Amount in rupees, number only.' },
          note: { type: 'string', description: 'Items or remarks on the line, if any.' },
        },
      },
    },
  },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.post('/api/scan', upload.single('image'), async (req, res) => {
  try {
    const key = requireKey();
    if (!req.file?.size) throw new ApiError('No photo received.', 400);
    const mime = req.file.mimetype || '';
    if (!/^(image\/(png|jpe?g)|application\/pdf)$/.test(mime)) throw new ApiError('Please upload a JPG or PNG photo (or a PDF).', 400);
    const headers = { 'api-subscription-key': key };

    const form = new FormData();
    form.append('file', new Blob([req.file.buffer], { type: mime }), req.file.originalname || 'page.jpg');
    form.append('language', 'hi-IN');
    form.append('output_format', 'json');
    form.append('schema', JSON.stringify(SCAN_SCHEMA));
    let r = await callSarvam(`${BASE}/doc-ai/v1/job/extract`, { method: 'POST', headers, body: form });
    if (!r.ok) throw await sarvamError(r);
    const jobId = (await r.json())?.job_id;
    if (!jobId) throw new ApiError('Sarvam did not start the scan. Please try again.');

    let status = 'pending';
    for (let i = 0; i < 60 && ['pending', 'running'].includes(status); i++) {
      await sleep(2000);
      r = await callSarvam(`${BASE}/doc-ai/v1/job/${jobId}/status`, { headers });
      if (!r.ok) throw await sarvamError(r);
      status = (await r.json())?.status;
    }
    if (['pending', 'running'].includes(status)) throw new ApiError('Scanning is taking too long. Try a smaller or clearer photo.', 504);
    if (!['completed', 'partially_completed'].includes(status)) throw new ApiError('Sarvam could not read this page. Try a clearer, well-lit photo.', 422);

    r = await callSarvam(`${BASE}/doc-ai/v1/job/${jobId}/results`, { headers });
    if (!r.ok) throw await sarvamError(r);
    const result = (await r.json())?.result;
    const entries = normalizeEntries(result?.entries ?? result);
    res.json({ entries, unclear: entries.length ? '' : 'No ledger lines were found on that page.' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Could not scan the page.' });
  }
});

app.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large. Keep recordings under 30 seconds and photos under 4 MB.' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON.' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Too much data in one request.' });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Upload problem: ' + err.message });
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

// On Vercel the exported app becomes a serverless function; locally (and on Render etc.) we listen on a port.
if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Voice Khata running on http://localhost:${port}`));
}

export default app;
