"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types for the Web Speech API (not in the standard TS DOM lib)
// ---------------------------------------------------------------------------
type SpeechRecognitionResultItem = { transcript: string; isFinal: boolean };
type SpeechRecognitionResult = ArrayLike<SpeechRecognitionResultItem> & {
  isFinal: boolean;
};
type SpeechRecognitionEvent = Event & {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResult>;
};
type SpeechRecognitionErrorEvent = Event & { error: string };
interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: ((ev: Event) => void) | null;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((ev: Event) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition as SpeechRecognitionCtor | undefined) ||
    (w.webkitSpeechRecognition as SpeechRecognitionCtor | undefined) ||
    null;
}

const LANGUAGES = [
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "es-ES", label: "Spanish" },
  { code: "fr-FR", label: "French" },
  { code: "de-DE", label: "German" },
  { code: "it-IT", label: "Italian" },
  { code: "pt-BR", label: "Portuguese (Brazil)" },
  { code: "nl-NL", label: "Dutch" },
  { code: "pl-PL", label: "Polish" },
  { code: "ru-RU", label: "Russian" },
  { code: "ar-SA", label: "Arabic" },
  { code: "hi-IN", label: "Hindi" },
  { code: "zh-CN", label: "Chinese (Mandarin)" },
  { code: "ja-JP", label: "Japanese" },
  { code: "ko-KR", label: "Korean" },
  { code: "tr-TR", label: "Turkish" },
  { code: "sv-SE", label: "Swedish" },
  { code: "uk-UA", label: "Ukrainian" },
];

const FILLERS = /\b(um+|uh+|er+|erm+|hmm+|ah+)\b[,.]?/gi;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

type HistoryItem = {
  id: string;
  text: string;
  createdAt: string;
  source: string;
};

type ErrorStage = "permission" | "service" | "other" | null;

function cleanTranscript(input: string): string {
  let text = input.replace(FILLERS, " ");
  // Collapse repeated words ("the the" -> "the")
  text = text.replace(/\b(\w+)(\s+\1\b)+/gi, "$1");
  // Normalise spacing around punctuation, capitalise sentence starts.
  text = text.replace(/\s+([,.!?;:])/g, "$1");
  text = text.replace(/\s{2,}/g, " ").trim();
  text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_m, p1, p2) =>
    p1 + p2.toUpperCase()
  );
  if (text && !/[.!?]$/.test(text)) text += ".";
  return text;
}

export default function Home() {
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [language, setLanguage] = useState("en-US");
  const [continuous, setContinuous] = useState(true);
  const [errorStage, setErrorStage] = useState<ErrorStage>(null);
  const [errorDetail, setErrorDetail] = useState("");
  const [level, setLevel] = useState(0);
  const [status, setStatus] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [groqKey, setGroqKey] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [isFallbackRecording, setIsFallbackRecording] = useState(false);
  const [fallbackSeconds, setFallbackSeconds] = useState(0);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const transcriptRef = useRef("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const fallbackChunksRef = useRef<Blob[]>([]);
  const fallbackTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const supported =
    typeof window !== "undefined" && getSpeechRecognitionCtor() !== null;

  // Load saved Groq key + history (localStorage only, never sent anywhere
  // except to /api/transcribe for a transcription request).
  useEffect(() => {
    try {
      setGroqKey(localStorage.getItem("groq_api_key") || "");
      const raw = localStorage.getItem("stt-history");
      if (raw) setHistory(JSON.parse(raw) as HistoryItem[]);
    } catch {
      /* storage unavailable — app still works, history just won't persist */
    }
  }, []);

  const persistHistory = useCallback((items: HistoryItem[]) => {
    setHistory(items);
    try {
      localStorage.setItem("stt-history", JSON.stringify(items));
    } catch {
      /* ignore */
    }
  }, []);

  const stopStream = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setLevel(0);
  }, []);

  // Level visualizer — reuses the granted mic stream. It never calls
  // getUserMedia itself; that is the mic fix: one mic request per tap.
  const startVisualizer = useCallback((stream: MediaStream) => {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new AudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        setLevel(Math.min(100, Math.round((sum / data.length / 255) * 220)));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* visualizer is cosmetic — dictation works without it */
    }
  }, []);

  const stopRecording = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      /* ignore */
    }
    recognitionRef.current = null;
    setIsRecording(false);
    setInterim("");
    stopStream();
  }, [stopStream]);

  useEffect(() => () => stopRecording(), [stopRecording]);

  // ------------------------------------------------------------------
  // Live dictation — mic fix:
  // 1. await ONE getUserMedia() first. A denial here is a real
  //    permission denial (stage: "permission").
  // 2. Only then create + start SpeechRecognition. A failure here,
  //    after the mic check passed, means the browser is blocking the
  //    live speech service (stage: "service"), not the mic.
  // 3. isRecording is set on onstart, never before.
  // ------------------------------------------------------------------
  const startRecording = useCallback(async () => {
    setErrorStage(null);
    setErrorDetail("");
    setStatus("");

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setErrorStage("service");
      setErrorDetail(
        "This browser does not support live dictation. Try Chrome, Edge, or Safari."
      );
      return;
    }

    // Step 1 — the single mic request.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      setErrorStage("permission");
      setErrorDetail(
        name === "NotFoundError"
          ? "No microphone was found on this device."
          : "Microphone access was blocked."
      );
      return;
    }
    streamRef.current = stream;
    startVisualizer(stream);

    // Step 2 — start recognition only after the mic was granted.
    try {
      const recognition = new Ctor();
      recognition.lang = language;
      recognition.continuous = continuous;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setIsRecording(true);
        setStatus("Listening… speak now.");
      };
      recognition.onresult = (event) => {
        let finalText = "";
        let interimText = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0]?.transcript ?? "";
          if (result.isFinal) finalText += text;
          else interimText += text;
        }
        if (finalText) {
          transcriptRef.current = (
            transcriptRef.current + " " + finalText
          ).trim();
          setTranscript(transcriptRef.current);
        }
        setInterim(interimText);
      };
      recognition.onerror = (event) => {
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          // Mic was already granted above, so this is the browser
          // blocking the live speech service — not a mic permission issue.
          setErrorStage("service");
          setErrorDetail(
            "The microphone was allowed, but this browser view is blocking the live speech service."
          );
        } else if (event.error === "audio-capture") {
          setErrorStage("other");
          setErrorDetail("The microphone could not be read. Check it is not in use by another app.");
        } else if (event.error === "network") {
          setErrorStage("other");
          setErrorDetail("Live dictation needs an internet connection for its speech service.");
        } else if (event.error !== "no-speech" && event.error !== "aborted") {
          setErrorStage("other");
          setErrorDetail(`Dictation stopped (${event.error}).`);
        }
        stopRecording();
      };
      recognition.onend = () => {
        setIsRecording(false);
        setInterim("");
        if (continuous) {
          // In continuous mode, restart after a natural pause, unless
          // the user stopped it.
          if (recognitionRef.current === recognition) {
            try {
              recognition.start();
            } catch {
              stopStream();
            }
          }
        } else {
          stopStream();
        }
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch {
      setErrorStage("service");
      setErrorDetail(
        "The microphone was allowed, but live dictation could not start in this browser."
      );
      stopStream();
    }
  }, [language, continuous, startVisualizer, stopRecording, stopStream]);

  // ------------------------------------------------------------------
  // Fallback: record with MediaRecorder, transcribe with Groq Whisper.
  // ------------------------------------------------------------------
  const transcribeBlob = useCallback(
    async (blob: Blob, name: string, source: string) => {
      const form = new FormData();
      form.append("file", blob, name);
      form.append("language", language);
      if (groqKey) form.append("groqKey", groqKey);
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      const data = (await res.json().catch(() => ({}))) as {
        text?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || "Transcription failed.");
      const text = (data.text ?? "").trim();
      if (text) {
        transcriptRef.current = (transcriptRef.current + " " + text).trim();
        setTranscript(transcriptRef.current);
      }
      setStatus(`Transcribed ${source}.`);
      return text;
    },
    [language, groqKey]
  );

  const startFallbackRecording = useCallback(async () => {
    setErrorStage(null);
    setErrorDetail("");
    if (!groqKey && !process.env.NEXT_PUBLIC_GROQ_CONFIGURED) {
      // Server may still have GROQ_API_KEY; only warn, don't block.
      setStatus("Recording… you'll need a Groq key in Settings to transcribe it, or set GROQ_API_KEY on the server.");
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setErrorStage("permission");
      setErrorDetail("Microphone access was blocked.");
      return;
    }
    streamRef.current = stream;
    startVisualizer(stream);
    fallbackChunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) fallbackChunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      const blob = new Blob(fallbackChunksRef.current, {
        type: recorder.mimeType || "audio/webm",
      });
      stopStream();
      setIsFallbackRecording(false);
      if (fallbackTimerRef.current) clearInterval(fallbackTimerRef.current);
      setFallbackSeconds(0);
      if (blob.size === 0) return;
      setIsUploading(true);
      try {
        await transcribeBlob(blob, "fallback-recording.webm", "your recording");
      } catch (err) {
        setErrorStage("other");
        setErrorDetail(err instanceof Error ? err.message : "Transcription failed.");
      } finally {
        setIsUploading(false);
      }
    };
    recorder.start();
    setIsFallbackRecording(true);
    setStatus("Recording fallback audio… tap Stop to transcribe it.");
    setFallbackSeconds(0);
    fallbackTimerRef.current = setInterval(
      () => setFallbackSeconds((s) => s + 1),
      1000
    );
  }, [groqKey, startVisualizer, stopStream, transcribeBlob]);

  const stopFallbackRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
  }, []);

  // ------------------------------------------------------------------
  // File upload transcription (Groq)
  // ------------------------------------------------------------------
  const handleFile = useCallback(
    async (file: File) => {
      setErrorStage(null);
      setErrorDetail("");
      if (file.size > MAX_UPLOAD_BYTES) {
        setErrorStage("other");
        setErrorDetail("File is over the 25 MB limit. Please use a shorter clip.");
        return;
      }
      setUploadName(file.name);
      setIsUploading(true);
      setStatus(`Transcribing ${file.name}…`);
      try {
        await transcribeBlob(file, file.name, file.name);
      } catch (err) {
        setErrorStage("other");
        setErrorDetail(err instanceof Error ? err.message : "Transcription failed.");
      } finally {
        setIsUploading(false);
      }
    },
    [transcribeBlob]
  );

  // ------------------------------------------------------------------
  // Transcript actions + history
  // ------------------------------------------------------------------
  const saveToHistory = useCallback(() => {
    const text = transcript.trim();
    if (!text) return;
    const item: HistoryItem = {
      id: `${Date.now()}`,
      text,
      createdAt: new Date().toISOString(),
      source: "Live / upload",
    };
    persistHistory([item, ...history]);
    setStatus("Saved to your transcripts below.");
  }, [transcript, history, persistHistory]);

  const copyTranscript = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(transcript);
      setStatus("Copied to clipboard.");
    } catch {
      setStatus("Copy needs clipboard permission in this browser.");
    }
  }, [transcript]);

  const downloadTranscript = useCallback(() => {
    const blob = new Blob([transcript], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "transcript.txt";
    a.click();
    URL.revokeObjectURL(url);
    setStatus("Downloaded transcript.txt.");
  }, [transcript]);

  const saveGroqKey = useCallback(() => {
    const key = keyInput.trim();
    try {
      if (key) localStorage.setItem("groq_api_key", key);
      else localStorage.removeItem("groq_api_key");
    } catch {
      /* ignore */
    }
    setGroqKey(key);
    setKeyInput("");
    setShowSettings(false);
    setStatus(key ? "Groq key saved in this browser only." : "Groq key removed.");
  }, [keyInput]);

  const bars = [0.4, 0.7, 1, 0.7, 0.4, 0.8, 0.55, 0.9, 0.5, 0.65, 0.85, 0.45];

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Speech to Text</h1>
            <p className="mt-1 max-w-xl text-slate-600">
              Dictate live for free — no key needed — or upload an audio file
              and transcribe it with Groq Whisper on the free tier.
            </p>
          </div>
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium shadow-sm hover:bg-slate-50"
          >
            {groqKey ? "Groq key saved ✓" : "Settings: Groq key"}
          </button>
        </header>

        {showSettings && (
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Groq key for file uploads</h2>
            <p className="mt-1 text-sm text-slate-600">
              Live dictation needs no key. File uploads use Groq Whisper
              (<code>whisper-large-v3-turbo</code>). Get a free key at{" "}
              <a
                className="text-indigo-600 underline"
                href="https://console.groq.com/keys"
                target="_blank"
                rel="noreferrer"
              >
                console.groq.com/keys
              </a>
              . The key is stored only in this browser (localStorage) and sent
              to this app&apos;s own <code>/api/transcribe</code> route for that
              request. You can also set <code>GROQ_API_KEY</code> in{" "}
              <code>.env.local</code> on the server instead — then no key is
              needed in the app at all.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder={groqKey ? "Key saved — enter a new one to replace it" : "gsk_…"}
                className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                onClick={saveGroqKey}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
              >
                Save key
              </button>
              {groqKey && (
                <button
                  onClick={() => {
                    setKeyInput("");
                    try {
                      localStorage.removeItem("groq_api_key");
                    } catch {
                      /* ignore */
                    }
                    setGroqKey("");
                    setStatus("Groq key removed.");
                  }}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm"
                >
                  Remove key
                </button>
              )}
            </div>
            {!groqKey && (
              <p className="mt-2 text-sm text-amber-700">
                No Groq key set yet — file uploads will ask for one. Live
                dictation still works.
              </p>
            )}
          </section>
        )}

        {status && (
          <p className="mt-4 rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-800" role="status">
            {status}
          </p>
        )}

        <div className="mt-6 grid gap-6 md:grid-cols-2">
          {/* Live dictation */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Live dictation</h2>
            <p className="mt-1 text-sm text-slate-600">
              Free, in your browser, using the Web Speech API. Works best in
              Chrome or Edge.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                aria-label="Language"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={continuous}
                  onChange={(e) => setContinuous(e.target.checked)}
                />
                Continuous mode
              </label>
            </div>

            <div className="mt-5 flex flex-col items-center">
              <button
                onClick={isRecording ? stopRecording : startRecording}
                className={`flex h-24 w-24 items-center justify-center rounded-full text-white shadow-lg ${
                  isRecording ? "bg-red-600 recording-ring" : "bg-indigo-600 hover:bg-indigo-700"
                }`}
                aria-label={isRecording ? "Stop recording" : "Tap to record"}
              >
                <span className="text-3xl">{isRecording ? "■" : "🎙"}</span>
              </button>
              <p className="mt-3 text-sm font-medium">
                {isRecording ? "Listening… tap to stop" : "Tap to record"}
              </p>
              <div className="mt-3 flex h-8 items-end gap-1" aria-hidden="true">
                {bars.map((h, i) => (
                  <span
                    key={i}
                    className="w-1.5 rounded bg-indigo-500 transition-all"
                    style={{ height: `${Math.max(6, Math.round(h * level))}px`, opacity: level > 4 ? 1 : 0.35 }}
                  />
                ))}
              </div>
            </div>

            {interim && (
              <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm italic text-slate-500">
                {interim}…
              </p>
            )}

            {errorStage === "permission" && (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm">
                <p className="font-semibold text-red-800">
                  {errorDetail || "Microphone access was blocked."}
                </p>
                <p className="mt-1 text-red-700">To allow the mic:</p>
                <ol className="mt-1 list-decimal pl-5 text-red-700">
                  <li>Tap the lock / site-settings icon in your browser&apos;s address bar.</li>
                  <li>Set Microphone to Allow for this page.</li>
                  <li>Reload the page, then tap record again.</li>
                </ol>
                <button
                  onClick={startRecording}
                  className="mt-3 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white"
                >
                  Try again
                </button>
              </div>
            )}

            {errorStage === "service" && (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
                <p className="font-semibold text-amber-800">
                  {errorDetail ||
                    "The microphone was allowed, but this browser view is blocking the live speech service."}
                </p>
                <p className="mt-1 text-amber-700">
                  This is not a mic-permission problem. Try opening this page
                  in Chrome, Edge, or Safari, or use the fallback below.
                </p>
                <button
                  onClick={
                    isFallbackRecording ? stopFallbackRecording : startFallbackRecording
                  }
                  className="mt-3 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white"
                  disabled={isUploading}
                >
                  {isFallbackRecording
                    ? `Stop fallback recording (${fallbackSeconds}s) — transcribe with Groq`
                    : "Record and transcribe with Groq instead"}
                </button>
              </div>
            )}

            {errorStage === "other" && (
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
                <p className="font-semibold">{errorDetail}</p>
                <button
                  onClick={startRecording}
                  className="mt-3 rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white"
                >
                  Try again
                </button>
              </div>
            )}

            {!supported && (
              <p className="mt-4 text-sm text-slate-600">
                Live dictation is not supported in this browser. Use Chrome,
                Edge, or Safari — or upload a file instead.
              </p>
            )}
          </section>

          {/* File upload */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Upload an audio file</h2>
            <p className="mt-1 text-sm text-slate-600">
              Transcribed with Groq Whisper (<code>whisper-large-v3-turbo</code>),
              up to 25 MB. Needs a free Groq key — in Settings, or{" "}
              <code>GROQ_API_KEY</code> on the server.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,video/*,.mp3,.wav,.m4a,.webm,.ogg,.flac,.mp4"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="mt-4 w-full rounded-lg border-2 border-dashed border-slate-300 px-4 py-8 text-sm text-slate-600 hover:border-indigo-400 hover:text-indigo-700 disabled:opacity-50"
            >
              {isUploading ? "Transcribing…" : "Choose an audio file (max 25 MB)"}
            </button>
            {uploadName && (
              <p className="mt-2 text-sm text-slate-600">Last file: {uploadName}</p>
            )}
            {!groqKey && (
              <p className="mt-3 text-sm text-amber-700">
                No Groq key set yet. Add one in Settings — it&apos;s free at{" "}
                <a
                  className="underline"
                  href="https://console.groq.com/keys"
                  target="_blank"
                  rel="noreferrer"
                >
                  console.groq.com/keys
                </a>
                .
              </p>
            )}
          </section>
        </div>

        {/* Transcript editor */}
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Transcript</h2>
          <textarea
            value={transcript}
            onChange={(e) => {
              transcriptRef.current = e.target.value;
              setTranscript(e.target.value);
            }}
            rows={8}
            placeholder="Your transcript will appear here. Tap the mic to dictate, or upload an audio file."
            className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm leading-relaxed"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => {
                const cleaned = cleanTranscript(transcript);
                transcriptRef.current = cleaned;
                setTranscript(cleaned);
                setStatus("Cleaned up: fillers removed, punctuation fixed.");
              }}
              disabled={!transcript.trim()}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Clean up
            </button>
            <button
              onClick={copyTranscript}
              disabled={!transcript.trim()}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm disabled:opacity-50"
            >
              Copy
            </button>
            <button
              onClick={downloadTranscript}
              disabled={!transcript.trim()}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm disabled:opacity-50"
            >
              Download .txt
            </button>
            <button
              onClick={saveToHistory}
              disabled={!transcript.trim()}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm disabled:opacity-50"
            >
              Save to history
            </button>
            <button
              onClick={() => {
                transcriptRef.current = "";
                setTranscript("");
                setInterim("");
                setStatus("");
              }}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-red-700"
            >
              Clear
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Clean-up runs locally in your browser — it removes fillers like
            &quot;um&quot; and &quot;uh&quot;, fixes spacing and capitalisation, and adds
            a final full stop. No extra API call.
          </p>
        </section>

        {/* History */}
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Saved transcripts</h2>
            {history.length > 0 && (
              <button
                onClick={() => persistHistory([])}
                className="text-sm text-red-700 underline"
              >
                Clear all
              </button>
            )}
          </div>
          {history.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">
              Nothing saved yet. Save a transcript above and it will stay in
              this browser until you delete it.
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {history.map((item) => (
                <li key={item.id} className="rounded-lg border border-slate-200 p-3">
                  <p className="line-clamp-3 text-sm">{item.text}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                    <span>{new Date(item.createdAt).toLocaleString()}</span>
                    <button
                      className="text-indigo-700 underline"
                      onClick={() => {
                        transcriptRef.current = item.text;
                        setTranscript(item.text);
                        setStatus("Reopened a saved transcript.");
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                    >
                      Reopen
                    </button>
                    <button
                      className="text-red-700 underline"
                      onClick={() =>
                        persistHistory(history.filter((h) => h.id !== item.id))
                      }
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <footer className="mt-8 text-center text-xs text-slate-400">
          Live dictation: Web Speech API (free, no key). File uploads: Groq
          Whisper free tier. No database, no account, no key stored on a server.
        </footer>
      </div>
    </main>
  );
}
