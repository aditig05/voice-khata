# Voice Khata (खाता)

**Speak your udhaar and expenses in Hindi, English, or a mix. Get a running khata.**

**Live demo:** https://voice-khata-ten.vercel.app (press **Load demo data** to try it with sample customers)

Built for the Sarvam AI Buildathon with four Sarvam models: **Saaras v4** (speech-to-text), **Sarvam 105B** (chat), **Bulbul v3** (text-to-speech) and **Document AI** (reading photos of paper ledgers).

## Problem

A kirana shopkeeper records udhaar (credit) in a paper bahi-khata, in the middle of serving customers. Writing is slow, names are spelled differently each time, and chasing pending payments is awkward. Typing on a phone is even slower than writing. Speaking is the natural way to record it.

## What it does

1. **Tap the mic and speak**, for example: *"Ramesh ne do sau ka udhaar liya, atta aur chini"* or *"Bijli bill 800 and Sunita ne 150 wapas kiye"*.
2. **Saaras v4** turns the speech into text. It auto-detects the language and is biased toward your existing customers' names.
3. **Sarvam 105B** reads the text and extracts structured entries (name, amount, type, note). Spoken numbers like "dedh sau" become 150.
4. You **check and edit** the entries, then save them.
5. The **khata** shows who owes what, today's collections and shop expenses.
6. For anyone with a pending balance, **Remind** asks Sarvam 105B to write a polite WhatsApp message in Hindi, Hinglish or English.

7. **Ask your khata out loud**, e.g. *"Ramesh ka kitna baaki hai?"* or *"is hafte kitna aaya?"*. Sarvam 105B answers from the ledger only, and **Bulbul** speaks the answer in Hindi. A shopkeeper who doesn't read well can use the whole app by voice.
8. **Voice-note reminders:** turn any reminder into a Bulbul audio clip you can download and send on WhatsApp as a voice message.
9. **Who may pay late? (AI):** the app works out each customer's payment history (total given vs paid back, days since last payment, age of the oldest unpaid credit). Sarvam 105B uses it to mark each customer as low, medium or high risk, says why using the numbers, and suggests a respectful nudge or a credit limit.
10. **Scan a paper page:** photograph an old bahi-khata page. **Sarvam Document AI** extracts the lines into entries, and you review them before saving. This is how a shop moves its paper khata into the app.

You can also download the khata as CSV, or press **Load demo data** to fill the app with sample customers.

## Entry types

| Type | Meaning | Effect |
|---|---|---|
| `udhaar` | Customer took goods on credit | Balance goes up |
| `jama` | Customer paid money back | Balance goes down |
| `kharcha` | Shop expense (not tied to a customer) | Added to expenses |

## Where Sarvam AI is used

| Feature | Sarvam API | Model |
|---|---|---|
| Voice to text | `POST /speech-to-text` (REST, up to 30 s) | `saaras:v4`, `language_code=unknown`, `keyterms` = known customer names |
| Understand the entry | `POST /v1/chat/completions` | `sarvam-105b` |
| Draft payment reminder | `POST /v1/chat/completions` | `sarvam-105b` |
| Answer questions about the khata | `POST /v1/chat/completions` | `sarvam-105b` (answers only from the ledger sent with the question) |
| Speak answers and reminders | `POST /text-to-speech` | `bulbul:v3`, speaker `priya` (change with `TTS_SPEAKER`), mp3 |
| Credit-risk insights | `POST /v1/chat/completions` | `sarvam-105b`, from per-customer stats computed in the browser |
| Read a paper ledger photo | `POST /doc-ai/v1/job/extract`, then poll `/status` and fetch `/results` | Document AI with a JSON schema for entries |

`sarvam-105b` is a reasoning model, and its hidden thinking counts against `max_tokens`. If the cap is too small, `content` comes back empty, so the server uses generous limits (6000–8000). Each call takes about 5–15 seconds.

All calls are made by the Node backend (`server.js`). The API key is read from an environment variable and never sent to the browser.

## Tech stack

Node.js 18+, Express, Multer, and plain HTML/CSS/JS, with no build step. The khata is stored in the browser's `localStorage`, so there is no database to set up.

## Setup

```bash
git clone <your-repo-url>
cd voice-khata
npm install
cp .env.example .env      # then put your key in .env
npm start
```

Open http://localhost:3000.

Environment variables:

| Name | Required | Description |
|---|---|---|
| `SARVAM_API_KEY` | yes | Key from https://dashboard.sarvam.ai |
| `PORT` | no | Defaults to 3000 |
| `TTS_SPEAKER` | no | Bulbul v3 voice, defaults to `priya` |
| `RATE_LIMIT_PER_10_MIN` | no | API calls allowed per visitor per 10 minutes, defaults to 40 |

## How to test

1. Click one of the sample lines. You should see entries to review, then press **Save to khata**.
2. Tap the mic, say an entry in Hindi or English, and tap again. The transcript fills in and entries appear for review.
3. Press **Remind** next to a customer with a balance to generate a message, then **Make voice note** to hear it.
4. Press **Load demo data**, then **Who may pay late?** to see risk badges.
5. In **Ask your khata**, tap **Ask by voice** and ask "Imran ka kitna baaki hai?". You should hear the answer.
6. Press **Scan a paper page** and pick a photo of a ledger page.
7. Try the failure cases: stop the server and see the error message, or use a wrong key.

## Deploy

**Vercel (used for the live demo).** `server.js` exports the Express app, which Vercel runs as one serverless function (zero-config Express), and `public/` is served from Vercel's CDN.

```bash
npx vercel login
npx vercel --prod          # first run links the project; accept the defaults
npx vercel env add SARVAM_API_KEY production
npx vercel --prod          # redeploy so the key is picked up
```

Or import the GitHub repo at https://vercel.com/new and add `SARVAM_API_KEY` under Environment Variables. Vercel gives you HTTPS, which the microphone needs.

Any other Node host works too, e.g. Render: build `npm install`, start `npm start`, and set `SARVAM_API_KEY`.

Each visitor is limited to 40 API calls per 10 minutes (change with `RATE_LIMIT_PER_10_MIN`) so a public link can't use up your Sarvam credits. The limit is kept in memory per server instance, so it slows down abuse but isn't a strict quota.

## Limitations

- Each recording is limited to about 28 seconds (Sarvam REST limit is 30 s).
- Uploads are capped at 4 MB (Vercel's request limit is 4.5 MB). Large phone photos are shrunk in the browser first. iPhone HEIC photos aren't supported; use JPG or PNG.
- The khata lives in one browser. Clearing site data erases it, so use **Download CSV** for backups.
- Handwriting recognition on real bahi-khata pages varies with photo quality. Scanned lines always go through the review step.
- Answers to spoken questions use the latest 80 entries plus every customer's balance.
- The model can mis-hear names. That is why every entry goes through a review step before it is saved.

## Project structure

```
server.js          Express API: /api/transcribe, /api/parse, /api/reminder, /api/ask, /api/speak, /api/insights, /api/scan
public/index.html  UI
public/app.js      Recording, review, ledger, reminders, ask, insights, scan, demo data
public/style.css   Bahi-khata styling
.env.example       Placeholder environment variables
```
