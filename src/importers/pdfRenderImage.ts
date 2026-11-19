import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Rend la premiere page d'un PDF en image PNG (via pdftoppm, le meme
 * paquet poppler-utils que pdftotext/extractPdfText) - necessaire en
 * dernier recours quand un PDF ne contient AUCUN texte extractible (scan
 * ou photo integree sans couche texte, vu en production sur des factures
 * papier numerisees) : extraireMontantHTFacture/extraireMontantTTCFacture
 * n'ont alors rien a lire, meme si une vision IA pourrait lire le montant
 * directement sur l'image de la page (voir extraireChampsFactureImage).
 *
 * Retourne undefined en cas d'echec (poppler-utils absent, PDF illisible,
 * page vide...) plutot que de lever une erreur bloquante - un PDF qui ne
 * peut etre ni lu en texte ni rendu en image reste simplement sans montant
 * extrait, comme avant cette amelioration.
 */
export function rendrePremierePageEnImage(buffer: Buffer): Buffer | undefined {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-vers-image-"));
  const cheminPdf = path.join(dossier, "document.pdf");
  const prefixeSortie = path.join(dossier, "page");
  try {
    fs.writeFileSync(cheminPdf, buffer);
    // -r 150 : resolution suffisante pour qu'un montant reste lisible par
    // la vision IA, sans generer une image demesuree (cout/latence).
    execFileSync("pdftoppm", ["-png", "-f", "1", "-l", "1", "-r", "150", cheminPdf, prefixeSortie]);
    // pdftoppm suffixe lui-meme le nom de sortie (ex. "page-1.png") - on
    // cherche le fichier produit plutot que de supposer le suffixe exact.
    const fichierPng = fs.readdirSync(dossier).find((f) => f.endsWith(".png"));
    return fichierPng ? fs.readFileSync(path.join(dossier, fichierPng)) : undefined;
  } catch {
    return undefined;
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
}
