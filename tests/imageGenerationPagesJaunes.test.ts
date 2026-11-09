import { test } from "node:test";
import assert from "node:assert/strict";

// Generation de photo IA pour les actualites PagesJaunes : meme principe que
// transcriptionAudio.test.ts - jamais d'appel reel a l'API OpenAI en test,
// uniquement le rejet explicite en l'absence de cle configuree (et de
// description).
test("genererImagePagesJaunes : rejet explicite si OPENAI_API_KEY absente", async () => {
  const sauvegarde = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { genererImagePagesJaunes, GenerationImagePagesJaunesError } = await import("../src/services/imageGenerationPagesJaunes");
    await assert.rejects(genererImagePagesJaunes("plombier en intervention"), GenerationImagePagesJaunesError);
  } finally {
    if (sauvegarde === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = sauvegarde;
  }
});

test("genererImagePagesJaunes : rejet explicite si description manquante (meme avec une cle presente)", async () => {
  const sauvegarde = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "cle-test";
  try {
    const { genererImagePagesJaunes, GenerationImagePagesJaunesError } = await import("../src/services/imageGenerationPagesJaunes");
    await assert.rejects(genererImagePagesJaunes(""), GenerationImagePagesJaunesError);
  } finally {
    if (sauvegarde === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = sauvegarde;
  }
});
