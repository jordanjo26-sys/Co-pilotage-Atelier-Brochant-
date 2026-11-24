import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execSync } from "node:child_process";
import dotenv from "dotenv";
import { gmail_v1 } from "googleapis";
import { extrairePiecesJointes, resumerErreurs, resoudreMontantsFacture } from "../src/services/gmailSync";
import { PrismaClient } from "@prisma/client";

function part(overrides: Partial<gmail_v1.Schema$MessagePart> & { headers?: gmail_v1.Schema$MessagePartHeader[] }): gmail_v1.Schema$MessagePart {
  return {
    filename: "piece.pdf",
    mimeType: "application/pdf",
    body: { attachmentId: "abc123" },
    headers: [],
    ...overrides,
  };
}

test("retient une vraie piece jointe (sans Content-ID ni disposition inline)", () => {
  const pieces = extrairePiecesJointes(part({}));
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].nomFichier, "piece.pdf");
});

test("exclut une ressource integree via Content-ID (logo de signature)", () => {
  const pieces = extrairePiecesJointes(
    part({ filename: "logo.png", mimeType: "image/png", headers: [{ name: "Content-ID", value: "<logo123>" }] })
  );
  assert.equal(pieces.length, 0);
});

test("exclut une image de newsletter/mailing via Content-Disposition: inline (sans Content-ID)", () => {
  const pieces = extrairePiecesJointes(
    part({
      filename: "mailingassets_df1d864a92ef9fa70e9cfb8af04cb568a7259a05.jpg",
      mimeType: "image/jpeg",
      headers: [{ name: "Content-Disposition", value: "inline; filename=\"mailingassets.jpg\"" }],
    })
  );
  assert.equal(pieces.length, 0);
});

test("Content-Disposition insensible a la casse et aux espaces (sur une image)", () => {
  const pieces = extrairePiecesJointes(
    part({ filename: "logo.png", mimeType: "image/png", headers: [{ name: "content-disposition", value: "  Inline" }] })
  );
  assert.equal(pieces.length, 0);
});

// Regression reelle en production (facture Trenois Decamps, novembre
// 2026) : un VRAI document (PDF, mimeType application/octet-stream) recu
// en Content-Disposition "inline" sans Content-ID etait a tort exclu
// comme une simple ressource de mise en forme - silencieusement ignore de
// bout en bout. Le signal "inline sans Content-ID" ne doit exclure que des
// images (voir le commentaire d'extrairePiecesJointes) : une plateforme de
// facturation peut marquer un PDF "inline" par erreur/choix technique,
// mais n'integre jamais un PDF comme ressource de mise en forme.
test("retient un vrai document (PDF) marque Content-Disposition: inline sans Content-ID", () => {
  const pieces = extrairePiecesJointes(
    part({
      filename: "fac01_01_004478982.pdf",
      mimeType: "application/octet-stream",
      headers: [{ name: "Content-Disposition", value: 'inline; filename="fac01_01_004478982.pdf"' }],
    })
  );
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].nomFichier, "fac01_01_004478982.pdf");
});

test("aplatit les parts imbriquees (message multipart)", () => {
  const payload: gmail_v1.Schema$MessagePart = {
    mimeType: "multipart/mixed",
    parts: [part({ filename: "facture.pdf" }), part({ filename: "logo.png", headers: [{ name: "Content-ID", value: "<x>" }] })],
  };
  const pieces = extrairePiecesJointes(payload);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].nomFichier, "facture.pdf");
});

test("ignore une part sans attachmentId ou sans nom de fichier (corps du message)", () => {
  const pieces = extrairePiecesJointes(part({ filename: "", body: {} }));
  assert.equal(pieces.length, 0);
});

// Regression reelle en production : un quota Gmail depasse touchant de
// nombreux messages a la fois produisait un mur de texte quasi identique,
// ligne par ligne, dans le Journal - illisible pour un utilisateur non
// technique. resumerErreurs() doit regrouper les messages d'erreur
// identiques plutot que les repeter un par un.
test("resumerErreurs : liste vide -> chaine vide", () => {
  assert.equal(resumerErreurs([]), "");
});

test("resumerErreurs : peu d'occurrences -> identifiants listes en clair", () => {
  const resume = resumerErreurs(["a.pdf : Insufficient Permission", "b.pdf : Insufficient Permission"]);
  assert.equal(resume, "a.pdf, b.pdf : Insufficient Permission");
});

test("resumerErreurs : beaucoup d'occurrences du meme message -> regroupees avec un compte", () => {
  const erreurs = Array.from({ length: 50 }, (_, i) => `Message ${i} : Quota exceeded for quota metric 'Total Query Cost'`);
  const resume = resumerErreurs(erreurs);
  assert.equal(resume, "50 document(s)/message(s) : Quota exceeded for quota metric 'Total Query Cost'");
});

// Seuil releve de 3 a 10 (octobre 2026) pour diagnostiquer un "Insufficient
// Permission" recurrent sur un petit nombre fixe de pieces jointes : jusqu'a
// 10 occurrences identiques, les identifiants restent listes en clair (noms
// de fichiers exploitables), au-dela ils sont regroupes avec un compte.
test("resumerErreurs : jusqu'a 10 occurrences identiques -> identifiants encore listes en clair", () => {
  const erreurs = Array.from({ length: 10 }, (_, i) => `fichier${i}.pdf : Insufficient Permission`);
  const resume = resumerErreurs(erreurs);
  assert.ok(!resume.includes("document(s)/message(s)"));
  assert.match(resume, /fichier0\.pdf.*fichier9\.pdf : Insufficient Permission/);
});

test("resumerErreurs : plusieurs types d'erreurs distincts -> une ligne par type", () => {
  const erreurs = [
    ...Array.from({ length: 15 }, (_, i) => `Message ${i} : Quota exceeded`),
    "a.pdf : Insufficient Permission",
  ];
  const resume = resumerErreurs(erreurs);
  assert.match(resume, /15 document\(s\)\/message\(s\) : Quota exceeded/);
  assert.match(resume, /a\.pdf : Insufficient Permission/);
});

// Garde-fou de plausibilite dans resoudreMontantsFacture (bug reel constate
// en production, novembre 2026 : facture Chardon Automobiles). Le tableau de
// totaux imprime "MO HT / PR HT / Base TVA / % TVA / TVA / MONTANT TTC" en
// colonnes, mais la cellule "TOTAL HT (€): 956,28" (fusion visuelle de 3
// colonnes d'en-tete) decale toute la ligne de valeurs vers la droite par
// rapport a son en-tete : le montant de TVA seul (191,26) se retrouve alors,
// en alignement de colonne, plus proche du libelle "MONTANT TTC" que le vrai
// TTC (1.147,54) - lequel apparait plus loin encore a droite. Desactive la
// cle Anthropic (comme gmailClassifyIA.test.ts) : verifie uniquement que la
// valeur implausible (TTC < HT) est rejetee avant le filet IA, jamais qu'une
// extraction IA reelle est appelee.
test("resoudreMontantsFacture : rejette un TTC extrait inferieur au HT (implausible) plutot que de le garder tel quel", async (t) => {
  const cleOriginale = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => {
    if (cleOriginale) process.env.ANTHROPIC_API_KEY = cleOriginale;
  });

  const texteFacture = `
                      MO HT (€)          PR HT (€)           Base TVA (€)       % TVA      TVA (€)         MONTANT TTC (€)
                                                                      TOTAL HT (€): 956,28                           191,26                          1.147,54
`;
  const resultat = await resoudreMontantsFacture({} as PrismaClient, "application/pdf", Buffer.from(""), texteFacture);
  // Sans cle Anthropic, le filet IA ne trouve rien : repli sur le calcul a
  // partir du HT (mention de TVA presente, taux standard 20%) - jamais le
  // 191,26 implausible extrait par la premiere passe.
  assert.equal(resultat.montantHT, 956.28);
  assert.equal(resultat.montantTTC, 1147.54);
});

// Les cas ci-dessous ne testent que les gardes-fous d'envoyerDocumentFournisseurVersDext
// qui ne necessitent pas d'appel reel a l'API Gmail (rejetes avant getGmailClient) :
// coherent avec le reste de ce fichier, qui ne mocke jamais l'API Gmail elle-meme.
test("envoi manuel vers Dext : gardes-fous", async (t) => {
  dotenv.config({ path: path.join(__dirname, "..", ".env") });
  const testDatabaseUrl =
    process.env.TEST_DATABASE_URL ||
    (process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/(\?|$)/, "_test$1") : undefined);
  if (!testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL (ou DATABASE_URL) manquante : voir .env.example.");
  }
  process.env.DATABASE_URL = testDatabaseUrl;
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });

  const { PrismaClient } = await import("@prisma/client");
  const { envoyerDocumentFournisseurVersDext, DocumentFournisseurEnvoiError } = await import("../src/services/gmailSync");
  const prisma = new PrismaClient();

  await t.test("document introuvable -> erreur", async () => {
    await assert.rejects(envoyerDocumentFournisseurVersDext(prisma, "inexistant"), DocumentFournisseurEnvoiError);
  });

  await t.test("type different de facture -> erreur", async () => {
    const d = await prisma.documentFournisseur.create({ data: { type: "avoir", fichierNom: "avoir.pdf" } });
    await assert.rejects(envoyerDocumentFournisseurVersDext(prisma, d.id), DocumentFournisseurEnvoiError);
  });

  await t.test("deja envoyee -> erreur", async () => {
    const d = await prisma.documentFournisseur.create({ data: { type: "facture", fichierNom: "f.pdf", statutDext: "envoye" } });
    await assert.rejects(envoyerDocumentFournisseurVersDext(prisma, d.id), DocumentFournisseurEnvoiError);
  });

  await t.test("reference Gmail manquante (document ancien) -> erreur", async () => {
    const d = await prisma.documentFournisseur.create({ data: { type: "facture", fichierNom: "f.pdf", statutDext: "a_valider" } });
    await assert.rejects(envoyerDocumentFournisseurVersDext(prisma, d.id), DocumentFournisseurEnvoiError);
  });

  await prisma.$disconnect();
});

// classerAnomalieCommeFacture et backfillFournisseurDocumentsSansFournisseur
// ne necessitent jamais l'API Gmail (resoudreFournisseur ne depend que de
// gmailExpediteur, deja en base) - testables directement, sans mock.
test("classerAnomalieCommeFacture : resout aussi le fournisseur si le document reclasse n'en avait pas (bug reel corrige)", async (t) => {
  dotenv.config({ path: path.join(__dirname, "..", ".env") });
  const testDatabaseUrl =
    process.env.TEST_DATABASE_URL ||
    (process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/(\?|$)/, "_test$1") : undefined);
  if (!testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL (ou DATABASE_URL) manquante : voir .env.example.");
  }
  process.env.DATABASE_URL = testDatabaseUrl;
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });

  const { PrismaClient } = await import("@prisma/client");
  const { classerAnomalieCommeFacture, backfillFournisseurDocumentsSansFournisseur, AnomalieClassificationError } = await import(
    "../src/services/gmailSync"
  );
  const prisma = new PrismaClient();

  await t.test("reclasse un document ambigu sans fournisseur : le fournisseur est resolu depuis l'expediteur", async () => {
    const document = await prisma.documentFournisseur.create({
      data: {
        type: "ambigu",
        fichierNom: "ticket.pdf",
        gmailMessageId: "msg-1",
        gmailAttachmentId: "att-1",
        gmailExpediteur: "Leroy Merlin <no_reply@leroymerlin.fr>",
      },
    });
    const anomalie = await prisma.anomalie.create({
      data: {
        type: "document_gmail_ambigu",
        preuves: JSON.stringify({ messageId: "msg-1", attachmentId: "att-1" }),
      },
    });

    await classerAnomalieCommeFacture(prisma, anomalie.id);

    const miseAJour = await prisma.documentFournisseur.findUnique({ where: { id: document.id }, include: { fournisseur: true } });
    assert.equal(miseAJour?.type, "facture");
    assert.equal(miseAJour?.statutDext, "a_valider");
    assert.equal(miseAJour?.fournisseur?.nom, "Leroy Merlin");
  });

  await t.test("anomalie deja traitee -> erreur", async () => {
    const anomalie = await prisma.anomalie.create({ data: { type: "document_gmail_ambigu", statut: "validee" } });
    await assert.rejects(classerAnomalieCommeFacture(prisma, anomalie.id), AnomalieClassificationError);
  });

  await t.test("backfillFournisseurDocumentsSansFournisseur : rattache les factures historiques sans fournisseur", async () => {
    await prisma.documentFournisseur.create({
      data: {
        type: "facture",
        fichierNom: "vieux-ticket.pdf",
        gmailExpediteur: "Leroy Merlin <no_reply@leroymerlin.fr>",
        statutDext: "envoye",
      },
    });
    // Document deja rattache : ne doit jamais etre retouche.
    const fournisseurExistant = await prisma.fournisseur.create({ data: { nom: "Autre Fournisseur" } });
    const dejaRattache = await prisma.documentFournisseur.create({
      data: { type: "facture", fichierNom: "deja-ok.pdf", gmailExpediteur: "x@autre.fr", fournisseurId: fournisseurExistant.id },
    });

    const resultat = await backfillFournisseurDocumentsSansFournisseur(prisma);
    assert.equal(resultat.total, 1);
    assert.equal(resultat.resolues, 1);

    const vieuxTicket = await prisma.documentFournisseur.findFirst({
      where: { fichierNom: "vieux-ticket.pdf" },
      include: { fournisseur: true },
    });
    assert.equal(vieuxTicket?.fournisseur?.nom, "Leroy Merlin");

    const inchange = await prisma.documentFournisseur.findUnique({ where: { id: dejaRattache.id } });
    assert.equal(inchange?.fournisseurId, fournisseurExistant.id);
  });

  await prisma.$disconnect();
});

// Meme principe que ci-dessus (aucun mock de l'API Gmail) : ne teste que le
// cas ou backfillMontantsFacturesSansMontant n'a litteralement rien a
// retraiter (aucun document eligible), donc jamais besoin d'appeler
// getGmailClient - le seul chemin verifiable sans connexion Gmail reelle.
test("backfillMontantsFacturesSansMontant : rien a traiter -> ne tente jamais de contacter Gmail", async (t) => {
  dotenv.config({ path: path.join(__dirname, "..", ".env") });
  const testDatabaseUrl =
    process.env.TEST_DATABASE_URL ||
    (process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/(\?|$)/, "_test$1") : undefined);
  if (!testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL (ou DATABASE_URL) manquante : voir .env.example.");
  }
  process.env.DATABASE_URL = testDatabaseUrl;
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });

  const { PrismaClient } = await import("@prisma/client");
  const { backfillMontantsFacturesSansMontant } = await import("../src/services/gmailSync");
  const prisma = new PrismaClient();

  await t.test("aucune facture sans montant -> resultat vide, pas d'erreur", async () => {
    await prisma.documentFournisseur.create({
      data: { type: "facture", fichierNom: "complete.pdf", montantHT: 100, montantTTC: 120 },
    });
    const resultat = await backfillMontantsFacturesSansMontant(prisma);
    assert.deepEqual(resultat, { traitees: 0, miseAJour: 0, toujoursSansMontant: 0, ignorees: 0, erreurs: [] });
  });

  await t.test("facture sans montant mais sans reference Gmail (document ancien) -> ignoree, pas d'appel Gmail", async () => {
    await prisma.documentFournisseur.create({ data: { type: "facture", fichierNom: "ancien.pdf" } });
    const resultat = await backfillMontantsFacturesSansMontant(prisma);
    assert.equal(resultat.ignorees, 1);
    assert.equal(resultat.traitees, 0);
    assert.deepEqual(resultat.erreurs, []);
  });

  await prisma.$disconnect();
});
