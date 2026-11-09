import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

// Diaporama video PagesJaunes (ffmpeg local, aucun fournisseur IA/paye) :
// contrairement a transcriptionAudio/imageGenerationPagesJaunes (API tierces
// payantes jamais appelees en test), ffmpeg est gratuit et local - on peut
// donc tester un vrai assemblage de bout en bout avec deux images de test
// generees a la volee, sans fixture binaire committee.
test("genererVideoDiaporamaPagesJaunes", async (t) => {
  const dossierMediaPublics = path.join(__dirname, "..", "public", "media-publics");
  await fs.mkdir(dossierMediaPublics, { recursive: true });

  const imagesTest = ["test-video-img-1.png", "test-video-img-2.png"].map((n) => path.join(dossierMediaPublics, n));
  const cheminsRelatifs = ["media-publics/test-video-img-1.png", "media-publics/test-video-img-2.png"];
  const fichiersGeneres: string[] = [];

  t.after(async () => {
    for (const f of [...imagesTest, ...fichiersGeneres]) {
      await fs.unlink(f).catch(() => {});
    }
  });

  await t.test("prepare deux images de test via ffmpeg", async () => {
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:s=32x32", "-frames:v", "1", imagesTest[0]]);
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=32x32", "-frames:v", "1", imagesTest[1]]);
    await assert.doesNotReject(fs.access(imagesTest[0]));
    await assert.doesNotReject(fs.access(imagesTest[1]));
  });

  const { genererVideoDiaporamaPagesJaunes, GenerationVideoPagesJaunesError } = await import("../src/services/videoGenerationPagesJaunes");

  await t.test("rejette une liste vide", async () => {
    await assert.rejects(genererVideoDiaporamaPagesJaunes([]), GenerationVideoPagesJaunesError);
  });

  await t.test("rejette un chemin hors de media-publics/", async () => {
    await assert.rejects(genererVideoDiaporamaPagesJaunes(["../../etc/passwd"]), GenerationVideoPagesJaunesError);
  });

  await t.test("rejette une photo introuvable", async () => {
    await assert.rejects(genererVideoDiaporamaPagesJaunes(["media-publics/n-existe-pas.png"]), GenerationVideoPagesJaunesError);
  });

  await t.test("assemble bien un diaporama a partir de deux vraies images, fichier mp4 non vide", async () => {
    const resultat = await genererVideoDiaporamaPagesJaunes(cheminsRelatifs, 1);
    assert.match(resultat.chemin, /^media-publics\/.+\.mp4$/);
    const cheminAbsolu = path.join(__dirname, "..", "public", resultat.chemin);
    fichiersGeneres.push(cheminAbsolu);
    const stats = await fs.stat(cheminAbsolu);
    assert.ok(stats.size > 0, "le fichier video genere ne doit pas etre vide");
  });
});
