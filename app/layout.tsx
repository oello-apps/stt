import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Speech to Text",
  description:
    "Live dictation with the Web Speech API and file transcription with Groq Whisper.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
