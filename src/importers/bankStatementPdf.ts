import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export interface PdfTransaction {
  date: string; // JJ/MM/AAAA, format directement compatible avec parseFlexibleDate
  libelle: string;
  montant: string; // texte tel qu'imprime sur le releve, ex. "- 149,07", compatible avec parseAmount
  // Reference bancaire propre a la ligne (ex. "0AFFB7G"), quand le releve
  // en imprime une - jamais affichee (le libelle reste lisible), mais
  // utilisee pour distinguer deux operations sinon identiques en
  // date+libelle+montant (ex. 4 prelevements URSSAF de rattrapage le meme
  // jour, meme montant, constate sur un releve reel) - sans elle,
  // importBankStatement les confondrait a tort en doublons et en perdrait
  // 3 sur 4 (voir receivePdfBankStatement).
  reference?: string;
}

/**
 * Extrait le texte d'un PDF via l'utilitaire externe `pdftotext` (paquet
 * poppler-utils). Ce binaire doit etre installe sur le serveur : sur
 * OVHcloud Ubuntu (section 16 du cahier des charges), `apt install
 * poppler-utils`.
 */
export function extractPdfText(buffer: Buffer): string {
  const tmpPath = path.join(os.tmpdir(), `releve-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.pdf`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    return execFileSync("pdftotext", ["-layout", tmpPath, "-"], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (err) {
    const message = (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "L'utilitaire 'pdftotext' (paquet poppler-utils) est introuvable sur ce serveur. Installer poppler-utils pour lire les relevés bancaires PDF."
      : `Echec de lecture du PDF : ${(err as Error).message}`;
    throw new Error(message);
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

/**
 * Normalise le texte extrait d'un PDF quand ce qui compte est seulement
 * "y a-t-il du texte exploitable" (classification, extraction de
 * montants) - PAS le releve bancaire, qui lit extractPdfText directement
 * et se moque de ce detail. Bug reel trouve en production (novembre 2026,
 * tickets Leclerc/REVIVAL, deux scans sans aucune couche de texte) :
 * pdftotext n'imprime JAMAIS une chaine litteralement vide, meme pour une
 * page entierement sans texte - il emet toujours au moins un saut de page
 * ("\f") par page. Un appelant qui teste juste `if (texte)` considere
 * donc a tort qu'il y a du texte (une chaine non vide est "truthy" en
 * JS), et ne declenche jamais le repli vers la vision IA sur l'image
 * rendue de la page - le document reste alors "non renseigne" sans la
 * moindre erreur nulle part, indiscernable d'une vraie panne.
 */
export function texteSignificatif(texte: string | undefined): string | undefined {
  const nettoye = texte?.trim();
  return nettoye ? nettoye : undefined;
}

// Delimite la section "ledger" chronologique du relevé (celle qui doit
// etre importee) des annexes "DETAIL DE VOS MOUVEMENTS SEPA" /
// "VIREMENTS SEPA RECUS" en fin de document, qui ne font que detailler
// des operations DEJA comptees dans le ledger — les importer aussi
// doublonnerait chaque virement/prelevement SEPA.
const LEDGER_START = /DETAIL DES OPERATIONS DE VOTRE COMPTE COURANT/i;
const LEDGER_END = /DETAIL DE VOS MOUVEMENTS SEPA/i;

// Une ligne d'operation imprime : date comptable, libelle (+ reference
// optionnelle), date operation, date valeur, montant. Les annexes SEPA
// n'ont qu'une seule date par ligne et ne peuvent donc jamais matcher ce
// motif a 3 dates.
const TRANSACTION_LINE =
  /^\s*(\d{2}\/\d{2})\s+(.+?)\s+(\d{2}\/\d{2})\s+(\d{2}\/\d{2})\s+(-?\s?[\d][\d\s]*,\d{2})\s*€\s*$/;
const REFERENCE_TOKEN = /^[A-Z0-9]{5,10}$/i;

// Une ligne "DDMMYY CB****NNNN" (paiement carte) ne porte que la reference
// de la carte, jamais le nom du commercant - celui-ci est imprime seul sur
// la ligne suivante (ex. "LEROY MERLIN SCFR COLLEGIEN"). Sans ce
// complement, 36 % des operations d'un releve reel (constate en
// production, novembre 2026) restent avec un libelle du type "050126
// CB****9020", inexploitable pour le rapprochement fournisseur.
const CARTE_SANS_COMMERCANT = /^\d{6}\s+CB\*{4}\d{4}$/;

// Bruit de mise en page recurrent (pdftotext -layout) entre une ligne
// d'operation et sa ligne de detail quand une rupture de page s'intercale :
// code pagination ("0008 0003"), ligne code-barres, numero de page, entete
// de colonnes repete en haut de chaque page, mentions legales de bas de
// page. Jamais le nom d'un commercant, donc toujours a ignorer en cherchant
// la ligne de detail.
const LIGNE_BRUIT_MISE_EN_PAGE =
  /^\d{4}\s+\d{4}$|^\d{8}\*|^Page\s+\d+\s*\/\s*\d+$|^VOTRE COMPTE COURANT|^RELEVE N°|^DATE$|^LIBELLE|^COMPTA|^Banque Populaire|^sous le N°|^compétent en cas de litige/i;

/**
 * Reconstitue les operations d'un relevé de compte Banque Populaire a
 * partir du texte extrait (mise en page conservee, `pdftotext -layout`).
 * Retourne des lignes deja au format texte attendu par les fonctions
 * generiques `parseAmount` / `parseFlexibleDate`, pour reutiliser tel
 * quel le normalisateur `importBankStatement` (voir bankStatement.ts).
 */
export function extractReleveTransactions(pdfText: string): PdfTransaction[] {
  const startIdx = pdfText.search(LEDGER_START);
  const searchBase = startIdx >= 0 ? startIdx : 0;
  const endOffset = pdfText.slice(searchBase).search(LEDGER_END);
  const ledgerText =
    startIdx === -1 ? pdfText : pdfText.slice(startIdx, endOffset === -1 ? undefined : searchBase + endOffset);

  // Annee de reference : entete "... au JJ/MM/AAAA" du relevé.
  const headerMatch = pdfText.match(/au\s+(\d{2})\/(\d{2})\/(\d{4})/);
  const headerMonth = headerMatch ? Number(headerMatch[2]) : null;
  const headerYear = headerMatch ? Number(headerMatch[3]) : new Date().getFullYear();

  const transactions: PdfTransaction[] = [];
  const lignes = ledgerText.split("\n");

  for (let i = 0; i < lignes.length; i++) {
    const m = lignes[i].match(TRANSACTION_LINE);
    if (!m) continue;

    const [, dateCompta, rest, , , montantBrut] = m;

    // Le libelle et la reference (quand elle existe) sont separes par un
    // grand blanc du a la mise en page en colonnes fixes ; les mots d'un
    // meme libelle ne sont eux separes que par un espace simple.
    const chunks = rest.split(/\s{2,}/).filter((c) => c.trim() !== "");
    let libelle: string;
    let reference: string | undefined;
    if (chunks.length >= 2 && REFERENCE_TOKEN.test(chunks[chunks.length - 1].trim())) {
      libelle = chunks.slice(0, -1).join(" ");
      reference = chunks[chunks.length - 1].trim();
    } else {
      libelle = chunks.join(" ");
    }
    libelle = libelle.replace(/\s+/g, " ").trim();
    if (!libelle) continue;

    if (CARTE_SANS_COMMERCANT.test(libelle)) {
      for (let j = i + 1; j < lignes.length && j <= i + 6; j++) {
        if (TRANSACTION_LINE.test(lignes[j])) break;
        const candidate = lignes[j].replace(/\s+/g, " ").trim();
        if (!candidate || LIGNE_BRUIT_MISE_EN_PAGE.test(candidate)) continue;
        libelle = `${candidate} (${libelle})`;
        break;
      }
    }

    const mois = Number(dateCompta.split("/")[1]);
    let annee = headerYear;
    if (headerMonth !== null && mois > headerMonth + 1) {
      // Ex. relevé "au" janvier avec une ligne datee decembre : annee precedente.
      annee -= 1;
    }

    transactions.push({
      date: `${dateCompta}/${annee}`,
      libelle,
      montant: montantBrut.replace(/\s+/g, " ").trim(),
      reference,
    });
  }

  return transactions;
}

// --- Releve de carte American Express (Carte Business Platinum) ---------
//
// Mise en page totalement differente d'un releve de compte courant
// Banque Populaire (voir extractReleveTransactions ci-dessus) : deux dates
// sans annee ("JJ mmm", ex. "29 sept"), pas de colonne debit/credit
// separee, et un montant final en EUR a virgule - jamais a confondre avec
// la colonne optionnelle "Depenses en monnaie etrangere" qui est a point
// (ex. "20.00" pour un achat en dollars).

// Identifie un releve de carte American Express (plutot qu'un releve de
// compte courant) : constate tel quel en entete de chaque page du document
// reel.
const AMEX_DOCUMENT_MARKER = /La Carte Business Platinum American Express/i;

// Deux dates "JJ mot" (transaction puis enregistrement), un libelle, puis
// en fin de ligne le montant EUR (virgule). Verifie sur un releve reel :
// "29 sept 29 sept PRELEVEMENT AUTOMATIQUE ENREGISTRE-MERCI ... 2 942,24"
// et "6 oct   7 oct   TWILIO.COM DUBLIN   20.00   18,36" (le "20.00" en
// dollars, a point, ne peut jamais matcher le groupe final a virgule).
const AMEX_TRANSACTION_LINE = /^(\d{1,2}\s+\S+)\s+(\d{1,2}\s+\S+)\s+(.+?)\s{2,}(-?[\d][\d\s]*,\d{2})\s*$/;

// Ligne imprimee seule, juste apres une ligne d'operation, pour le
// prelevement automatique qui solde le releve precedent ("CR" = credit du
// compte carte). Jamais importee (voir extractReleveCarteAmexTransactions) :
// c'est le meme mouvement d'argent que le prelevement automatique deja
// compte sur le releve du compte bancaire du mois concerne (constate sur un
// vrai releve BP : libelle identique "PRELEVEMENT AUTOMATIQUE
// ENREGISTRE-MERCI") - l'importer aussi doublonnerait cette sortie d'argent.
const AMEX_LIGNE_CREDIT_SOLDE = /^CR$/;

// Abreviations francaises standard des mois (jamais une invention propre a
// Copilote) ; seuls "sept" et "oct" ont ete verifies sur un releve reel,
// les autres sont ajoutees par prudence pour couvrir le reste de l'annee -
// un mot non reconnu fait ignorer la ligne plutot que de deviner une date.
const AMEX_MOIS: Record<string, number> = {
  janv: 1, jan: 1, fevr: 2, fev: 2, mars: 3, avr: 4, mai: 5, juin: 6,
  juil: 7, juill: 7, aout: 8, sept: 9, sep: 9, oct: 10, nov: 11, dec: 12,
};

function amexMoisVersNumero(motDate: string): number | null {
  const mot = motDate
    .toLowerCase()
    .replace(/\.$/, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  return AMEX_MOIS[mot] ?? null;
}

/**
 * Determine si le texte extrait correspond a un releve de carte American
 * Express plutot qu'a un releve de compte courant - a tester avant
 * d'appeler extractReleveCarteAmexTransactions (qui, sur un texte sans
 * rapport, renverrait simplement un tableau vide comme
 * extractReleveTransactions, mais sans la verification explicite de
 * mise en page, par prudence section 14).
 */
export function estReleveCarteAmex(pdfText: string): boolean {
  return AMEX_DOCUMENT_MARKER.test(pdfText);
}

/**
 * Reconstitue les operations d'un releve de carte American Express Carte
 * Business Platinum a partir du texte extrait (mise en page conservee,
 * `pdftotext -layout`). Meme format de sortie que
 * extractReleveTransactions pour reutiliser tel quel le normalisateur
 * generique `importBankStatement`.
 */
export function extractReleveCarteAmexTransactions(pdfText: string): PdfTransaction[] {
  // "Date de releve" et "Prochain releve" sont imprimes cote a cote sur la
  // meme ligne (ex. "25/10/26   25/11/26") : le premier couple suffit pour
  // determiner mois et annee de fin de periode.
  const headerMatch = pdfText.match(/(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2})\/(\d{2})\/(\d{2})/);
  if (!headerMatch) return [];
  const headerMonth = Number(headerMatch[2]);
  const headerYear = 2000 + Number(headerMatch[3]);

  const transactions: PdfTransaction[] = [];
  const lignes = pdfText.split("\n");

  for (let i = 0; i < lignes.length; i++) {
    const m = lignes[i].match(AMEX_TRANSACTION_LINE);
    if (!m) continue;

    const [, dateTransactionBrute, , rest, montantBrut] = m;
    const [jourStr, moisMot] = dateTransactionBrute.trim().split(/\s+/);
    const mois = amexMoisVersNumero(moisMot);
    if (mois === null) continue; // mot de mois non reconnu : jamais deviner.

    const libelle = rest.replace(/\s+/g, " ").trim();
    if (!libelle) continue;

    // Ligne suivante "CR" seule : prelevement automatique du solde
    // precedent, jamais importe (voir AMEX_LIGNE_CREDIT_SOLDE ci-dessus).
    const ligneSuivante = lignes[i + 1]?.trim();
    if (ligneSuivante && AMEX_LIGNE_CREDIT_SOLDE.test(ligneSuivante)) continue;

    let annee = headerYear;
    if (mois > headerMonth + 1) {
      // Ex. releve "au" octobre avec une ligne datee decembre : annee precedente.
      annee -= 1;
    }

    const jour = jourStr.padStart(2, "0");
    const moisFmt = String(mois).padStart(2, "0");

    transactions.push({
      date: `${jour}/${moisFmt}/${annee}`,
      libelle,
      // Une depense carte augmente ce qui est du - c'est une sortie
      // d'argent, au meme titre qu'un debit de compte courant (voir
      // importBankStatement : une seule colonne "montant" signee, negative
      // ici par convention).
      montant: `- ${montantBrut.replace(/\s+/g, " ").trim()}`,
    });
  }

  return transactions;
}
