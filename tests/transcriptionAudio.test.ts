import { test } from "node:test";
import assert from "node:assert/strict";

// Transcription audio (devis dictes sur chantier) : meme principe que les
// autres integrations optionnelles (Stripe, Twilio, Meta...) - jamais
// d'appel reel a l'API OpenAI en test, uniquement le rejet explicite en
// l'absence de cle configuree.
test("transcrireAudio : rejet explicite si OPENAI_API_KEY absente", async () => {
  const sauvegarde = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { transcrireAudio, TranscriptionAudioError } = await import("../src/services/transcriptionAudio");
    await assert.rejects(transcrireAudio(Buffer.from("test"), "audio/webm", "message.webm"), TranscriptionAudioError);
  } finally {
    if (sauvegarde === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = sauvegarde;
  }
});
