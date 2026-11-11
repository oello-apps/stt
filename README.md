# Speech to Text

A single-page Next.js 14 (App Router, TypeScript, Tailwind) web app.

- **Live dictation** — free, no key, using the browser Web Speech API
  (`SpeechRecognition`). 18 languages, continuous mode, interim results
  preview, live level visualizer.
- **File upload transcription** — audio files up to 25 MB transcribed with
  Groq Whisper (`whisper-large-v3-turbo`) on Groq's free tier, through the
  Next.js API route `POST /api/transcribe`.
- **Transcript editor** — edit, clean up (removes fillers, fixes punctuation
  and spacing locally, no extra API call), copy, download as `.txt`, and
  save to a persistent history (localStorage) you can reopen or delete.
- No database, no auth, no account. The only optional server setting is
  `GROQ_API_KEY`.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:3000

## Production

```bash
npm run build
npm run start
```

## Groq key (for file uploads only)

Live dictation needs no key. File uploads need a free Groq key, in one of
two ways — pick whichever you prefer:

**Option A — in the app (easiest)**
1. Get a free key at https://console.groq.com/keys
2. Open the app, tap **Settings: Groq key**, paste the key, save.
3. The key is stored only in your browser (localStorage). It is sent to
   this app's own `/api/transcribe` route for that request only, and is
   never stored on the server.

**Option B — on the server**
1. Copy `.env.example` to `.env.local` and set:
   ```
   GROQ_API_KEY=gsk_…
   ```
2. Restart the server. Uploads then work with no key in the app.

If no key is set in either place, uploads show a clear message telling
you to add one. Never commit a real key — `.env.local` is git-ignored.

Groq's free tier (as of writing): no card required, generous daily
limits (see https://console.groq.com/docs/rate-limits). Paid usage after
that is about $0.04/hour of audio for `whisper-large-v3-turbo`.

## Microphone fix (already in this code)

Tapping record used to fire two competing microphone requests at once —
`SpeechRecognition.start()` plus the level visualizer's own
`getUserMedia()` — and every failure showed the same "allow mic
permission" message.

This version fixes that in `app/page.tsx` (`startRecording`):

1. It awaits **a single** `getUserMedia({ audio: true })` first. A denial
   here is a real permission denial, and the app shows the exact steps to
   allow the mic, with a **Try again** button.
2. Only after the mic is granted does it create and start
   `SpeechRecognition`. A block at this stage means the browser is
   blocking the live speech service — the app says so, suggests trying
   Chrome / Edge / Safari, and offers a fallback: record with
   `MediaRecorder` and transcribe it with Groq Whisper.
3. The level visualizer reuses the granted stream (via `AnalyserNode`) —
   it never requests the mic itself.
4. `isRecording` is set on `onstart`, never before.

## Browser support

Live dictation works best in Chrome or Edge (desktop / Android). Safari
14.1+ supports it partially. Firefox support is limited — use the file
upload (or the Groq fallback recording) there instead.

## Project structure

```
app/
  layout.tsx            # metadata + global styles
  page.tsx              # the whole single-page app (client component)
  globals.css           # Tailwind + recording animation
  api/transcribe/route.ts  # Groq Whisper proxy (POST /api/transcribe)
package.json
next.config.js
tailwind.config.ts
postcss.config.js
tsconfig.json
.env.example            # GROQ_API_KEY template (no real key)
```

## Deploying to Vercel

```bash
vercel
```

Then set `GROQ_API_KEY` in the Vercel project settings (Environment
Variables) if you want uploads to work without entering a key in the app.
Live dictation works with no variables at all.
