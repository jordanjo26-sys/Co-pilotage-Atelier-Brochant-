import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export interface FichierExtrait {
  nom: string; // nom (chemin relatif dans l'archive), ex. "2025/01/facture-edf.pdf"
  donnees: Buffer;
}

const EXTENSIONS_AUTORISEES = [".pdf", ".jpg", ".jpeg", ".png"];

/**
 * Extrait TOUS les fichiers PDF/JPEG/PNG d'une archive ZIP (contrairement
 * a extraireTexteDepuisZip dans zipAttachment.ts, qui ne prend que le
 * premier PDF d'une piece jointe e-mail) - utilise pour l'import en masse
 * de l'archive comptable (export Dext, plusieurs centaines de fichiers
 * possibles, parfois ranges dans des sous-dossiers). Ignore silencieusement
 * les dossiers et tout fichier d'un type non reconnu (ex. un .DS_Store ou
 * un fichier recapitulatif).
 *
 * Leve une erreur explicite si l'archive est illisible - contrairement au
 * filet de securite de zipAttachment.ts, un import demande explicitement
 * par l'utilisateur doit echouer bruyamment plutot que silencieusement
 * (sinon il croirait l'import reussi alors que rien n'a ete lu).
 */
export function extraireFichiersDepuisZip(buffer: Buffer): FichierExtrait[] {
  const tmpZip = path.join(os.tmpdir(), `archive-comptable-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.zip`);
  fs.writeFileSync(tmpZip, buffer);
  try {
    const listing = execFileSync("unzip", ["-Z1", tmpZip], { encoding: "utf8" });
    const noms = listing
      .split("\n")
      .map((ligne) => ligne.trim())
      .filter((ligne) => ligne && !ligne.endsWith("/") && EXTENSIONS_AUTORISEES.some((ext) => ligne.toLowerCase().endsWith(ext)));

    return noms.map((nom) => ({
      nom,
      donnees: execFileSync("unzip", ["-p", tmpZip, nom], { maxBuffer: 50 * 1024 * 1024 }),
    }));
  } catch (err) {
    throw new Error(`Archive ZIP illisible : ${(err as Error).message}`);
  } finally {
    fs.unlinkSync(tmpZip);
  }
}

export function mimeTypeDepuisNom(nom: string): string {
  const bas = nom.toLowerCase();
  if (bas.endsWith(".pdf")) return "application/pdf";
  if (bas.endsWith(".png")) return "image/png";
  return "image/jpeg";
}
