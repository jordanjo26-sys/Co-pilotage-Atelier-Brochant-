import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { extractPdfText } from "./bankStatementPdf";

/**
 * Extrait le texte du premier PDF trouve a l'interieur d'une archive ZIP,
 * via l'utilitaire externe `unzip` (deja installe sur le serveur de
 * deploiement, voir scripts/deploy/bootstrap.sh). Certains fournisseurs
 * (ex. TotalEnergies / cartes carburant) envoient leur facture par e-mail
 * sous forme d'archive ZIP plutot qu'un PDF direct - sans cette etape, ces
 * documents n'avaient jamais de texte a analyser et restaient
 * indefiniment "HT/TTC non renseigne" (constate en production, zero
 * extraction sur ce type de piece jointe).
 *
 * Retourne undefined si l'archive est illisible, protegee par mot de
 * passe ou ne contient aucun PDF - jamais une erreur qui bloquerait le
 * reste de la synchronisation Gmail (meme discipline que
 * gmailClassifyIA.ts : une panne de ce filet retombe sur le comportement
 * actuel, pas de contenu extrait, jamais une erreur bloquante).
 */
export function extraireTexteDepuisZip(buffer: Buffer): string | undefined {
  const tmpZip = path.join(os.tmpdir(), `piece-jointe-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.zip`);
  fs.writeFileSync(tmpZip, buffer);
  try {
    const listing = execFileSync("unzip", ["-Z1", tmpZip], { encoding: "utf8" });
    const nomPdf = listing
      .split("\n")
      .map((ligne) => ligne.trim())
      .find((ligne) => ligne.toLowerCase().endsWith(".pdf"));
    if (!nomPdf) return undefined;

    const contenuPdf = execFileSync("unzip", ["-p", tmpZip, nomPdf], { maxBuffer: 20 * 1024 * 1024 });
    return extractPdfText(contenuPdf);
  } catch {
    return undefined;
  } finally {
    fs.unlinkSync(tmpZip);
  }
}
