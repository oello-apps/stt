import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — Groq free-tier file limit

/**
 * POST /api/transcribe
 * Multipart form fields:
 *   file     — audio file (required, <= 25 MB)
 *   language — optional BCP-47 / ISO code, e.g. "en"
 *   groqKey  — optional key entered in the app's Settings.
 *               Falls back to GROQ_API_KEY from the environment.
 *               The key is used only for this request and is never stored
 *               or logged by the server.
 */
export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected an audio file upload (multipart form data)." },
      { status: 400 }
    );
  }
  try {
    const file = form.get("file");
    const language = form.get("language");
    const userKey =
      typeof form.get("groqKey") === "string"
        ? (form.get("groqKey") as string).trim()
        : "";

    const apiKey = userKey || process.env.GROQ_API_KEY || "";
    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            "NO_GROQ_KEY — Add your free Groq key in Settings in the app, or set GROQ_API_KEY in .env.local. Get a free key at https://console.groq.com/keys",
        },
        { status: 400 }
      );
    }

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "No audio file was uploaded." },
        { status: 400 }
      );
    }
    if (file.size === 0) {
      return NextResponse.json(
        { error: "That file is empty." },
        { status: 400 }
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "File is over the 25 MB limit. Please use a shorter clip." },
        { status: 413 }
      );
    }

    const groqForm = new FormData();
    groqForm.append("file", file, file.name || "audio.webm");
    groqForm.append("model", "whisper-large-v3-turbo");
    groqForm.append("response_format", "json");
    if (typeof language === "string" && language.trim()) {
      groqForm.append("language", language.trim().split("-")[0]);
    }

    const res = await fetch(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: groqForm,
      }
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message =
        (data as { error?: { message?: string } })?.error?.message ||
        (data as { error?: string })?.error ||
        `Groq returned ${res.status}. Check your key and try again.`;
      return NextResponse.json({ error: String(message) }, { status: res.status });
    }

    return NextResponse.json({ text: (data as { text?: string }).text ?? "" });
  } catch (err) {
    console.error("transcribe error", err);
    return NextResponse.json(
      { error: "Transcription failed. Please try again." },
      { status: 500 }
    );
  }
}
