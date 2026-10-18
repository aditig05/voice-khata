// Voice Khata frontend. All Sarvam calls go through our own /api routes so the key never reaches the browser.
const STORE_KEY = 'voice-khata.v1';
const MAX_SECONDS = 28; // Sarvam REST speech-to-text accepts up to 30 s per request

const $ = (id) => document.getElementById(id);
const rupee = (n) => '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n);
const LABEL = { udhaar: 'Udhaar (gave on credit)', jama: 'Jama (paid back)', kharcha: 'Kharcha (shop expense)' };

function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids) node.append(k);
  return node;
}

// spinner + disabled while a request runs
function busy(btn, on) { btn.disabled = on; btn.classList.toggle('is-busy', on); }

// header "1 Bolo → 2 Check karo → 3 Khata ready"
let stepTimer = null;
function setStep(n) {
  clearTimeout(stepTimer);
  document.querySelectorAll('.steps li').forEach((li) => li.classList.toggle('active', li.dataset.step === String(n)));
  if (n === 3) stepTimer = setTimeout(() => setStep(1), 4000);
}

let toastTimer = null;
function toast(msg, undo) {
  clearTimeout(toastTimer);
  $('toast-text').textContent = msg;
  const u = $('toast-undo');
  u.hidden = !undo;
  u.onclick = () => { $('toast').hidden = true; undo(); };
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, undo ? 6000 : 3000);
}

// ---------- storage ----------
let ledger = [];
try { ledger = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { ledger = []; }
if (!Array.isArray(ledger)) ledger = [];
ledger = ledger.filter((e) => e && typeof e.amount === 'number' && ['udhaar', 'jama', 'kharcha'].includes(e.type));
let insights = new Map(); // customer(lowercase) -> {risk, why, nudge}; cleared whenever the ledger changes
const persist = () => { insights = new Map(); try { localStorage.setItem(STORE_KEY, JSON.stringify(ledger)); } catch { /* storage full or blocked */ } };

let filterName = null;
let pending = []; // entries waiting for the shopkeeper's confirmation

function balances() {
  const map = new Map();
  for (const e of ledger) {
    if (e.type === 'kharcha') continue;
    const key = e.customer.toLowerCase();
    const cur = map.get(key) || { name: e.customer, balance: 0 };
    cur.balance += e.type === 'udhaar' ? e.amount : -e.amount;
    map.set(key, cur);
  }
  return [...map.values()];
}
const customerNames = () => balances().map((b) => b.name);

// ---------- rendering ----------
function render() {
  const people = balances();
  const owed = people.reduce((s, p) => s + Math.max(p.balance, 0), 0);
  const today = new Date().toDateString();
  const receivedToday = ledger.filter((e) => e.type === 'jama' && new Date(e.date).toDateString() === today).reduce((s, e) => s + e.amount, 0);
  const expenses = ledger.filter((e) => e.type === 'kharcha').reduce((s, e) => s + e.amount, 0);
  $('t-owed').textContent = rupee(owed);
  $('t-today').textContent = rupee(receivedToday);
  $('t-exp').textContent = rupee(expenses);

  const list = $('people');
  list.replaceChildren();
  people.sort((a, b) => b.balance - a.balance).forEach((p) => {
    const pending = p.balance > 0;
    const li = el('li', { className: 'person' });
    const name = el('button', { className: 'name', type: 'button', title: 'Show only this person', textContent: p.name });
    name.onclick = () => { filterName = p.name; render(); };
    const bal = el('span', { className: 'bal ' + (pending ? 'owe' : 'clear'), textContent: pending ? rupee(p.balance) + ' baaki' : p.balance < 0 ? 'Advance ' + rupee(-p.balance) : 'Settled' });
    li.append(name, bal);
    const ins = insights.get(p.name.toLowerCase());
    if (pending && ins) li.append(el('span', { className: 'risk ' + ins.risk, textContent: ins.risk + ' risk' }));
    if (pending) {
      const b = el('button', { className: 'btn', type: 'button', textContent: 'Remind' });
      b.onclick = () => openReminder(p.name, p.balance);
      li.append(b);
    }
    if (pending && ins) li.append(el('p', { className: 'insight' }, el('b', { textContent: ins.why.charAt(0).toUpperCase() + ins.why.slice(1) }), el('br'), '→ ' + ins.nudge));
    list.append(li);
  });
  if (!people.length) list.append(el('li', { className: 'status', textContent: 'No customers yet.' }));

  const rows = $('rows');
  rows.replaceChildren();
  const shown = ledger.filter((e) => !filterName || e.customer.toLowerCase() === filterName.toLowerCase());
  [...shown].reverse().forEach((e) => {
    const tr = el('tr');
    tr.append(
      el('td', { textContent: new Date(e.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) }),
      el('td', { textContent: e.type === 'kharcha' ? 'Shop' : e.customer }),
      el('td', { textContent: e.note || '' }),
    );
    const amt = el('td', { className: 'num ' + e.type });
    amt.append(rupee(e.amount), el('span', { className: 'tag', textContent: { udhaar: 'udhaar', jama: 'jama', kharcha: 'kharcha' }[e.type] }));
    tr.append(amt);
    const del = el('button', { className: 'del', type: 'button', title: 'Remove this entry', textContent: '×' });
    del.setAttribute('aria-label', 'Remove entry');
    del.onclick = () => {
      const before = ledger;
      ledger = ledger.filter((x) => x.id !== e.id);
      persist(); render();
      toast(`Removed ${rupee(e.amount)} ${e.type}${e.customer ? ' for ' + e.customer : ''}.`, () => { ledger = before; persist(); render(); });
    };
    tr.append(el('td', {}, del));
    rows.append(tr);
  });
  $('empty').hidden = ledger.length > 0;
  $('book-body').hidden = ledger.length === 0;
  $('unfilter').hidden = !filterName;
  $('filter-note').textContent = filterName ? '– ' + filterName : '';
}

function setStatus(msg, isError = false) {
  const s = $('status');
  s.textContent = msg;
  s.classList.toggle('error', isError);
}

async function api(path, options) {
  let res;
  try { res = await fetch(path, options); }
  catch { throw new Error('Cannot reach the server. Check your connection.'); }
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- review step ----------
function renderReview(entries, unclear, { scroll = true } = {}) {
  pending = entries.map((e) => ({ ...e }));
  const box = $('review-list');
  box.replaceChildren();
  pending.forEach((e, i) => {
    const type = el('select');
    for (const t of ['udhaar', 'jama', 'kharcha']) type.append(el('option', { value: t, textContent: LABEL[t], selected: t === e.type }));
    type.onchange = () => { e.type = type.value; name.disabled = e.type === 'kharcha'; row.className = 'entry ' + e.type; };
    const name = el('input', { value: e.customer, placeholder: 'Customer name', disabled: e.type === 'kharcha' });
    name.oninput = () => { e.customer = name.value; };
    const amount = el('input', { type: 'number', min: '1', step: 'any', value: e.amount, inputMode: 'decimal' });
    amount.oninput = () => { e.amount = Number(amount.value); };
    const note = el('input', { className: 'note', value: e.note, placeholder: 'Details (optional)' });
    note.oninput = () => { e.note = note.value; };
    const x = el('button', { className: 'x', type: 'button', textContent: '×', title: 'Remove' });
    x.setAttribute('aria-label', 'Remove this entry');
    x.onclick = () => { pending.splice(i, 1); renderReview(pending, '', { scroll: false }); };
    type.setAttribute('aria-label', 'Entry type');
    name.setAttribute('aria-label', 'Customer name');
    amount.setAttribute('aria-label', 'Amount in rupees');
    note.setAttribute('aria-label', 'Details');
    const row = el('div', { className: 'entry ' + e.type }, type, name, x, amount, note);
    box.append(row);
  });
  const u = $('unclear');
  u.hidden = !unclear;
  u.textContent = unclear || '';
  $('save').disabled = pending.length === 0;
  const show = pending.length > 0 || !!unclear;
  const wasHidden = $('review').hidden;
  $('review').hidden = !show;
  setStep(show ? 2 : 1);
  if (scroll && show && wasHidden) $('review').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function readEntries() {
  const text = $('transcript').value.trim();
  if (!text) { setStatus('Say or type an entry first.', true); return; }
  busy($('read'), true);
  setStatus('Reading your entries…');
  try {
    const data = await api('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, customers: customerNames() }),
    });
    renderReview(data.entries, data.entries.length ? data.unclear : data.unclear || 'No money entry found. Try: “Ramesh ne 200 ka udhaar liya”.');
    setStatus(data.entries.length ? `Found ${data.entries.length} ${data.entries.length === 1 ? 'entry' : 'entries'}. Check and save.` : '');
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    busy($('read'), false);
  }
}

$('read').onclick = readEntries;
document.querySelectorAll('.chip').forEach((c) => {
  c.onclick = () => { $('transcript').value = c.dataset.text; readEntries(); };
});

// Saves the reviewed entries. Used by the Save button and by a spoken "haan" in talk mode.
function commitPending() {
  const bad = pending.find((e) => !(e.amount > 0) || (e.type !== 'kharcha' && !e.customer.trim()));
  if (bad) { setStatus('Every entry needs an amount and (except expenses) a name.', true); return 0; }
  const now = new Date().toISOString();
  const saved = pending.length;
  for (const e of pending) {
    ledger.push({
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
      date: now, type: e.type, amount: e.amount, note: e.note.trim(),
      customer: e.type === 'kharcha' ? '' : canonicalName(e.customer.trim()),
    });
  }
  persist();
  pending = [];
  $('review').hidden = true;
  $('transcript').value = '';
  setStatus('');
  render();
  setStep(3);
  toast(`Saved ${saved} ${saved === 1 ? 'entry' : 'entries'} to your khata.`);
  return saved;
}
function discardPending() { pending = []; $('review').hidden = true; setStatus(''); setStep(1); }
$('save').onclick = commitPending;
$('discard').onclick = discardPending;

// reuse existing spelling so "ramesh" and "Ramesh" stay one customer
function canonicalName(name) {
  const hit = customerNames().find((n) => n.toLowerCase() === name.toLowerCase());
  return hit || name;
}

// ---------- recording ----------
function pickMime() {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return options.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

// One tap starts, the next tap stops (or the time limit does). onAudio(blob, filename) runs afterwards.
function makeRecorder({ button, label, timer, idle, busy, say, onAudio }) {
  let recorder = null, chunks = [], stream = null, tick = null, startedAt = 0;

  async function start() {
    if (!navigator.mediaDevices || !window.MediaRecorder) { say('This browser cannot record audio. Type it instead.', true); return; }
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { say('Microphone blocked. Allow mic access in the browser, or type it.', true); return; }
    chunks = [];
    const mimeType = pickMime();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    recorder.onstop = finish;
    recorder.start();
    startedAt = Date.now();
    button.setAttribute('aria-pressed', 'true');
    label.textContent = 'Listening… tap to stop';
    say('');
    tick = setInterval(() => {
      const sec = Math.floor((Date.now() - startedAt) / 1000);
      timer.textContent = `${sec}s / ${MAX_SECONDS}s`;
      if (sec >= MAX_SECONDS) stop();
    }, 250);
  }

  function stop() {
    clearInterval(tick);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    stream?.getTracks().forEach((t) => t.stop());
    button.setAttribute('aria-pressed', 'false');
    timer.textContent = '';
  }

  async function finish() {
    const type = recorder.mimeType || 'audio/webm';
    const blob = new Blob(chunks, { type });
    if (blob.size < 1500) { label.textContent = idle; say('That was too short. Tap, speak, then tap again.', true); return; }
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    button.disabled = true;
    button.classList.add('is-busy');
    label.textContent = busy;
    try { await onAudio(blob, `speech.${ext}`); }
    catch (e) { say(e.message, true); }
    finally { button.disabled = false; button.classList.remove('is-busy'); label.textContent = idle; }
  }

  button.onclick = () => (recorder && recorder.state === 'recording' ? stop() : start());
}

async function transcribe(blob, filename) {
  const form = new FormData();
  form.append('audio', blob, filename);
  form.append('names', JSON.stringify(customerNames()));
  return api('/api/transcribe', { method: 'POST', body: form });
}

makeRecorder({
  button: $('mic'), label: $('mic-label'), timer: $('timer'), idle: 'Tap to speak', busy: 'Working…', say: setStatus,
  onAudio: async (blob, name) => {
    setStatus('Turning your voice into text…');
    const data = await transcribe(blob, name);
    $('transcript').value = data.transcript;
    await readEntries();
  },
});

// ---------- scan a paper page ----------
// Phone photos are often 5-10 MB; shrink them so the upload is fast and under the server limit.
async function shrinkImage(file) {
  if (!file.type.startsWith('image/') || file.size < 1.5 * 1024 * 1024) return file; // createImageBitmap can't read HEIC; the server rejects it with a clear message
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.85));
    return blob || file;
  } catch { return file; }
}

$('scan').onchange = async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  setStatus('Reading the page… this takes a few seconds.');
  $('scan-label').classList.add('is-busy');
  try {
    const small = await shrinkImage(file);
    if (small.size > 4 * 1024 * 1024) throw new Error('That file is over 4 MB. Use a smaller photo or a PDF with fewer pages.');
    const form = new FormData();
    form.append('image', small, small.type === 'application/pdf' ? 'page.pdf' : 'page.jpg');
    const data = await api('/api/scan', { method: 'POST', body: form });
    renderReview(data.entries, data.unclear);
    setStatus(data.entries.length ? `Found ${data.entries.length} ${data.entries.length === 1 ? 'line' : 'lines'} on the page. Check names and amounts, then save.` : '');
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    $('scan-label').classList.remove('is-busy');
  }
};

// When no voice comes back from the server (every voice service failed), the phone reads the text itself.
function browserSpeak(text, lang, onEnd) {
  if (!text || !window.speechSynthesis) { onEnd?.(); return; }
  speechSynthesis.cancel();
  const pick = phoneVoice(text, lang === 'hinglish' ? 'hi-IN' : lang);
  if (!pick) { toast('This phone has no Hindi voice. Pick English at the top to hear replies.'); onEnd?.(); return; }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = pick.lang;
  if (pick.voice) u.voice = pick.voice;
  u.onend = u.onerror = () => onEnd?.();
  speechSynthesis.speak(u);
}

// Pick a phone voice for the reply. Devanagari needs a Hindi voice; Hinglish/English text can use an English one.
function phoneVoice(text, lang) {
  const voices = speechSynthesis.getVoices();
  const hindi = voices.find((v) => v.lang?.toLowerCase().startsWith('hi'));
  const english = voices.find((v) => v.lang?.toLowerCase() === 'en-in') || voices.find((v) => v.lang?.toLowerCase().startsWith('en'));
  const devanagari = /[\u0900-\u097F]/.test(text);
  if (devanagari) return hindi ? { voice: hindi, lang: 'hi-IN' } : null;
  if (lang === 'hi-IN' && hindi) return { voice: hindi, lang: 'hi-IN' };
  return { voice: english || null, lang: 'en-IN' };
}


// ---------- talking khata ----------
const askStatus = (msg, isError = false) => { $('ask-status').textContent = msg; $('ask-status').classList.toggle('error', isError); };

function ledgerContext() {
  const weekAgo = Date.now() - 7 * 864e5;
  const today = new Date().toDateString();
  const jama = ledger.filter((e) => e.type === 'jama');
  return {
    today: new Date().toISOString(),
    owed: balances().reduce((s, p) => s + Math.max(p.balance, 0), 0),
    receivedToday: jama.filter((e) => new Date(e.date).toDateString() === today).reduce((s, e) => s + e.amount, 0),
    receivedWeek: jama.filter((e) => new Date(e.date).getTime() >= weekAgo).reduce((s, e) => s + e.amount, 0),
    expenses: ledger.filter((e) => e.type === 'kharcha').reduce((s, e) => s + e.amount, 0),
    people: balances(),
    recent: [...ledger].reverse().slice(0, 80),
  };
}

async function askKhata(question) {
  askStatus('Looking through your khata…');
  busy($('ask-go'), true);
  try {
    const data = await api('/api/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, language_code: $('lang').value, context: ledgerContext() }),
    });
    $('answer').textContent = data.answer;
    $('answer-box').hidden = false;
    const audio = $('answer-audio');
    audio.hidden = !data.audio;
    if (data.audio) {
      audio.src = data.audio;
      audio.play().catch(() => { /* autoplay blocked: the player is visible */ });
    } else browserSpeak(data.answer, $('lang').value);
    askStatus('');
  } catch (e) {
    askStatus(e.message, true);
  } finally {
    busy($('ask-go'), false);
  }
}

$('ask-form').onsubmit = (ev) => {
  ev.preventDefault();
  const q = $('question').value.trim();
  if (!q) { askStatus('Type or speak a question first.', true); return; }
  askKhata(q);
};

makeRecorder({
  button: $('ask-mic'), label: $('ask-mic-label'), timer: $('ask-timer'), idle: 'Ask by voice', busy: 'Listening to the recording…', say: askStatus,
  onAudio: async (blob, name) => {
    askStatus('Turning your voice into text…');
    const data = await transcribe(blob, name);
    $('question').value = data.transcript;
    await askKhata(data.transcript);
  },
});

// ---------- AI insights: who may pay late ----------
const daysAgo = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);

function customerStats() {
  return balances().filter((p) => p.balance > 0).map((p) => {
    const mine = ledger.filter((e) => e.type !== 'kharcha' && e.customer.toLowerCase() === p.name.toLowerCase());
    const credits = mine.filter((e) => e.type === 'udhaar');
    const pays = mine.filter((e) => e.type === 'jama');
    const given = credits.reduce((s, e) => s + e.amount, 0);
    const paid = pays.reduce((s, e) => s + e.amount, 0);
    let run = 0, oldest = null; // oldest credit not yet covered by payments (first-in, first-out)
    for (const e of credits) { run += e.amount; if (run > paid) { oldest = e.date; break; } }
    const newest = (list) => (list.length ? daysAgo(list[list.length - 1].date) : null);
    return {
      customer: p.name, balance: p.balance, given, paid, udhaarCount: credits.length, jamaCount: pays.length,
      daysSinceCredit: newest(credits), daysSincePayment: newest(pays), daysOldestUnpaid: oldest ? daysAgo(oldest) : null,
    };
  });
}

$('insights-btn').onclick = async () => {
  const stats = customerStats();
  const st = $('insights-status');
  st.classList.remove('error');
  if (!stats.length) { st.textContent = 'Nobody has a pending balance.'; return; }
  st.textContent = 'Studying everyone’s payment history…';
  busy($('insights-btn'), true);
  try {
    const data = await api('/api/insights', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customers: stats }) });
    insights = new Map(data.insights.map((i) => [i.customer.toLowerCase(), i]));
    st.textContent = insights.size ? '' : 'No insights came back. Try again.';
    render();
  } catch (e) {
    st.textContent = e.message;
    st.classList.add('error');
  } finally {
    busy($('insights-btn'), false);
  }
};

// ---------- demo data (for trying the app or showing it off) ----------
function loadDemo() {
  if (ledger.length && !confirm('Replace your current entries with demo data?')) return;
  const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
  const rows = [
    ['Ramesh', 'udhaar', 1500, 'atta, chawal', 45], ['Ramesh', 'jama', 300, '', 30], ['Ramesh', 'udhaar', 800, 'tel, dal', 20],
    ['Imran', 'udhaar', 2200, 'ration', 60],
    ['Sunita', 'udhaar', 600, 'chini, chai', 14], ['Sunita', 'jama', 300, '', 9], ['Sunita', 'jama', 150, '', 0],
    ['Mohan', 'udhaar', 350, 'biscuit, doodh', 2],
    ['', 'kharcha', 800, 'bijli bill', 5], ['', 'kharcha', 300, 'transport', 1],
  ];
  ledger = rows.map(([customer, type, amount, note, d]) => ({ id: crypto.randomUUID(), date: ago(d), type, amount, note, customer }))
    .sort((x, y) => x.date.localeCompare(y.date)); // the ledger is kept oldest-first
  filterName = null;
  persist();
  render();
  toast('Demo khata loaded. Try “Who may pay late?” or ask a question.');
}
$('demo').onclick = loadDemo;
$('demo-empty').onclick = loadDemo;

// ---------- reminders ----------
let remindFor = null;
async function genReminder() {
  const st = $('remind-status');
  st.classList.remove('error');
  st.textContent = 'Writing the message…';
  $('voice-box').hidden = true; // an old voice note no longer matches the new text
  busy($('remind-gen'), true);
  try {
    const data = await api('/api/reminder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: remindFor.name, balance: remindFor.balance, language: $('remind-lang').value }),
    });
    $('remind-text').value = data.message;
    $('remind-wa').href = 'https://wa.me/?text=' + encodeURIComponent(data.message);
    st.textContent = '';
  } catch (e) {
    st.textContent = e.message;
    st.classList.add('error');
  } finally {
    busy($('remind-gen'), false);
  }
}
function openReminder(name, balance) {
  remindFor = { name, balance };
  $('remind-title').textContent = `Reminder for ${name} (${rupee(balance)})`;
  $('remind-lang').value = $('lang').value;
  $('remind-text').value = '';
  $('voice-box').hidden = true;
  $('remind-audio').removeAttribute('src');
  $('remind').showModal();
  genReminder();
}
$('remind-voice').onclick = async () => {
  const text = $('remind-text').value.trim();
  const st = $('remind-status');
  st.classList.remove('error');
  if (!text) { st.textContent = 'Write the message first.'; return; }
  st.textContent = 'Recording the voice note…';
  busy($('remind-voice'), true);
  try {
    const data = await api('/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, language_code: $('remind-lang').value === 'hinglish' ? 'hi-IN' : $('remind-lang').value }) });
    const src = data.audio; // a data: URI (mp3 from Sarvam, wav from the free fallback)
    $('remind-audio').src = src;
    $('remind-dl').href = src;
    $('remind-dl').download = src.startsWith('data:audio/wav') ? 'reminder.wav' : 'reminder.mp3';
    $('voice-box').hidden = false;
    $('remind-audio').play().catch(() => {});
    st.textContent = '';
  } catch (e) {
    st.textContent = e.message;
    st.classList.add('error');
  } finally {
    busy($('remind-voice'), false);
  }
};
$('remind-gen').onclick = genReminder;
$('remind-lang').onchange = genReminder;
$('remind-text').oninput = () => { $('remind-wa').href = 'https://wa.me/?text=' + encodeURIComponent($('remind-text').value); };
$('remind-copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('remind-text').value); $('remind-status').textContent = 'Copied.'; }
  catch { $('remind-status').textContent = 'Could not copy. Select the text and copy it manually.'; }
};

// ---------- talk mode: hands-free voice agent ----------
// Loop: listen (stops by itself after a pause) -> /api/talk (transcribe + decide + reply + voice)
// -> act on it -> play the reply -> listen again. Entries go to the review card and are saved only
// when the shopkeeper says yes (or presses Save).
const talk = { on: false, stream: null, ctx: null, analyser: null, recorder: null, audio: null, history: [], quietTurns: 0, timer: null };
const TALK_LABEL = { idle: 'Off', listening: 'Listening… boliye', thinking: 'Thinking…', speaking: 'Speaking…' };

function talkState(state) {
  $('talk-state').dataset.state = state;
  $('talk-state-text').textContent = TALK_LABEL[state];
  $('talk-btn').textContent = talk.on ? 'Stop talking' : 'Start talking';
  $('talk-btn').classList.toggle('on', talk.on);
}

function talkBubble(who, text) {
  const log = $('talk-log');
  log.hidden = false;
  log.append(el('p', { className: 'bubble ' + who, textContent: text }));
  log.scrollTop = log.scrollHeight;
}

// short rising tone = "your turn to speak"
function beep() {
  try {
    const o = talk.ctx.createOscillator(), g = talk.ctx.createGain(), t = talk.ctx.currentTime;
    o.frequency.setValueAtTime(660, t); o.frequency.linearRampToValueAtTime(880, t + 0.12);
    g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g).connect(talk.ctx.destination); o.start(t); o.stop(t + 0.2);
  } catch { /* no sound is fine */ }
}

async function startTalk() {
  if (!navigator.mediaDevices || !window.MediaRecorder) { talkBubble('error', 'This browser cannot record audio.'); return; }
  try { talk.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { talkBubble('error', 'Microphone blocked. Allow mic access in the browser to talk.'); return; }
  talk.ctx = new (window.AudioContext || window.webkitAudioContext)();
  talk.analyser = talk.ctx.createAnalyser();
  talk.analyser.fftSize = 1024;
  talk.ctx.createMediaStreamSource(talk.stream).connect(talk.analyser);
  talk.on = true;
  talk.quietTurns = 0;
  talk.history = [];
  $('talk-log').replaceChildren();
  listen();
}

function stopTalk(note) {
  talk.on = false;
  clearInterval(talk.timer);
  if (talk.recorder && talk.recorder.state !== 'inactive') { talk.recorder.onstop = null; talk.recorder.stop(); }
  talk.audio?.pause();
  window.speechSynthesis?.cancel();
  talk.stream?.getTracks().forEach((t) => t.stop());
  talk.ctx?.close().catch(() => {});
  talk.stream = talk.ctx = talk.recorder = talk.audio = null;
  if (note) talkBubble('note', note);
  talkState('idle');
}

function listen() {
  if (!talk.on) return;
  talkState('listening');
  beep();
  const chunks = [];
  const mimeType = pickMime();
  const rec = new MediaRecorder(talk.stream, mimeType ? { mimeType } : undefined);
  talk.recorder = rec;
  rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };

  // simple voice-activity detection: learn the room's noise level, then stop after ~1.2 s of quiet
  const buf = new Float32Array(talk.analyser.fftSize);
  const started = Date.now();
  let floor = 0, samples = 0, spoke = false, lastLoud = 0, loudMs = 0;
  rec.onstop = () => {
    clearInterval(talk.timer);
    if (!talk.on) return;
    if (loudMs < 300) { // under ~0.3 s of sound: a click or cough, not speech
      if (++talk.quietTurns >= 2) { stopTalk('Talk mode stopped: I did not hear anything.'); return; }
      talkBubble('note', 'I did not hear anything. Speak after the beep, or tap Stop.');
      listen();
      return;
    }
    talk.quietTurns = 0;
    sendTurn(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
  };
  rec.start();
  talk.timer = setInterval(() => {
    talk.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    const now = Date.now();
    if (now - started < 300) { floor += rms; samples++; return; } // calibrate on the first 300 ms
    const threshold = Math.max(0.015, (floor / Math.max(samples, 1)) * 3);
    if (rms > threshold) { spoke = true; lastLoud = now; loudMs += 50; }
    const done = (spoke && now - lastLoud > 1200) || (!spoke && now - started > 7000) || now - started > MAX_SECONDS * 1000;
    if (done && rec.state === 'recording') rec.stop();
  }, 50);
}

async function sendTurn(blob) {
  talkState('thinking');
  const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('audio', blob, `speech.${ext}`);
  form.append('state', JSON.stringify({ language_code: $('lang').value, pending, history: talk.history.slice(-6), context: ledgerContext() }));
  let data;
  try { data = await api('/api/talk', { method: 'POST', body: form }); }
  catch (e) {
    if (!talk.on) return;
    talkBubble('error', e.message);
    if (/too many|quota|api key/i.test(e.message)) { stopTalk(); return; }
    listen();
    return;
  }
  if (!talk.on) return;
  talkBubble('user', data.transcript);
  talk.history.push({ role: 'user', content: data.transcript });

  if (data.action === 'add') renderReview(data.entries, '', { scroll: false }); // keep the conversation in view
  if (data.action === 'confirm' && !commitPending()) data.reply = $('status').textContent || data.reply;
  if (data.action === 'cancel') discardPending();

  talkBubble('agent', data.reply);
  talk.history.push({ role: 'assistant', content: data.reply });
  const next = () => (data.action === 'stop' ? stopTalk() : listen());
  talkState('speaking');
  if (!data.audio) { browserSpeak(data.reply, $('lang').value, () => { if (talk.on) next(); }); return; }
  talk.audio = new Audio(data.audio);
  talk.audio.onended = () => { if (talk.on) next(); };
  talk.audio.play().catch(() => { if (talk.on) next(); });
}

$('talk-btn').onclick = () => (talk.on ? stopTalk() : startTalk());

// ---------- reply language + intro (remembered per browser) ----------
const LANG_KEY = 'voice-khata.lang';
const INTRO_KEY = 'voice-khata.intro-hidden';
const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };
const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

const savedLang = recall(LANG_KEY);
if (savedLang && [...$('lang').options].some((o) => o.value === savedLang)) $('lang').value = savedLang;
$('lang').onchange = () => remember(LANG_KEY, $('lang').value);

function showIntro(show) {
  $('intro').hidden = !show;
  $('intro-open').hidden = show;
  remember(INTRO_KEY, show ? '' : '1');
}
showIntro(!recall(INTRO_KEY));
$('intro-close').onclick = () => showIntro(false);
$('intro-open').onclick = () => { showIntro(true); $('intro').scrollIntoView({ behavior: 'smooth', block: 'start' }); };

// ---------- misc ----------
$('unfilter').onclick = () => { filterName = null; render(); };
$('clear').onclick = () => {
  if (ledger.length && confirm('Delete every entry from this browser? This cannot be undone.')) { ledger = []; filterName = null; persist(); render(); }
};
$('export').onclick = () => {
  // quote every cell, and defuse values Excel would run as formulas (=, +, -, @)
  const esc = (v) => `"${String(v).replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"`;
  const csv = ['date,type,customer,amount,note', ...ledger.map((e) => [e.date, e.type, e.customer, e.amount, e.note].map(esc).join(','))].join('\n');
  const a = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: 'khata.csv' });
  a.click();
  URL.revokeObjectURL(a.href);
};

render();
