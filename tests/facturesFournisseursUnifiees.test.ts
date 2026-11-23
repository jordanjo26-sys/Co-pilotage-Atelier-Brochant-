import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execSync } from "node:child_process";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ||
  (process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/(\?|$)/, "_test$1") : undefined);

if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL (ou DATABASE_URL) manquante : voir .env.example.");
}
process.env.DATABASE_URL = testDatabaseUrl;

test("Ecran unifie 'Factures fournisseurs' (V2) — fusion DocumentFournisseur + ArchiveComptable", async (t) => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });

  const { PrismaClient } = await import("@prisma/client");
  const { listerFacturesFournisseursUnifiees, obtenirDetailFactureFournisseurUnifiee, FactureFournisseurUnifieeError } = await import(
    "../src/services/facturesFournisseursUnifiees"
  );
  const prisma = new PrismaClient();

  t.after(async () => {
    await prisma.$disconnect();
  });

  await t.test("exclut les copies archive_comptable d'une facture deja envoyee a Dext (origine=dext_copie)", async () => {
    const document = await prisma.documentFournisseur.create({
      data: { type: "facture", fichierNom: "facture-edf.pdf", numero: "FA-1", montantHT: 100, montantTTC: 120, statutDext: "envoye" },
    });
    await prisma.archiveComptable.create({
      data: {
        fichierNom: "facture-edf.pdf",
        cheminFichier: "/tmp/inexistant-edf.pdf",
        mimeType: "application/pdf",
        fournisseurNom: "EDF",
        numero: "FA-1",
        montantHT: 100,
        montantTTC: 120,
        statut: "complete",
        origine: "dext_copie",
        documentFournisseurId: document.id,
      },
    });

    const resultat = await listerFacturesFournisseursUnifiees(prisma);
    assert.equal(resultat.total, 1, "la copie dext_copie ne doit jamais doubler la facture");
    assert.equal(resultat.factures[0].id, `document:${document.id}`);
  });

  await t.test("inclut les archives non-Dext (zip_manuel, ovh_api, origine historique NULL) a cote des documents Gmail/Dext", async () => {
    await prisma.archiveComptable.create({
      data: {
        fichierNom: "ovh-1.pdf",
        cheminFichier: "/tmp/inexistant-ovh.pdf",
        mimeType: "application/pdf",
        fournisseurNom: "OVHcloud",
        numero: "OVH-1",
        montantHT: 10,
        montantTTC: 12,
        statut: "complete",
        origine: "ovh_api",
      },
    });
    await prisma.archiveComptable.create({
      data: {
        fichierNom: "zip-1.pdf",
        cheminFichier: "/tmp/inexistant-zip.pdf",
        mimeType: "application/pdf",
        fournisseurNom: "Bouygues Telecom",
        numero: null,
        montantHT: null,
        montantTTC: 30,
        statut: "a_verifier",
        origine: "zip_manuel",
      },
    });
    await prisma.archiveComptable.create({
      data: {
        fichierNom: "historique-1.pdf",
        cheminFichier: "/tmp/inexistant-historique.pdf",
        mimeType: "application/pdf",
        fournisseurNom: "Castorama",
        numero: "HIST-1",
        montantHT: 5,
        montantTTC: 6,
        statut: "complete",
        origine: null,
      },
    });

    const resultat = await listerFacturesFournisseursUnifiees(prisma);
    // 1 document Dext (sous-test precedent) + 3 archives non-dext_copie.
    assert.equal(resultat.total, 4);
    const ovh = resultat.factures.find((f) => f.fournisseurNom === "OVHcloud");
    assert.equal(ovh?.statut, "validee");
    const zip = resultat.factures.find((f) => f.fournisseurNom === "Bouygues Telecom");
    assert.equal(zip?.statut, "a_corriger");
    const historique = resultat.factures.find((f) => f.fournisseurNom === "Castorama");
    assert.ok(historique, "une archive d'origine NULL (anterieure au marqueur) reste affichee, jamais masquee par hypothese");
  });

  await t.test("exclut les documents non-facture (avoir, bon_enlevement...) : ce ne sont pas des factures fournisseurs", async () => {
    await prisma.documentFournisseur.create({
      data: { type: "avoir", fichierNom: "avoir.pdf", montantTTC: 50, statutDext: "archive" },
    });
    await prisma.documentFournisseur.create({
      data: { type: "ambigu", fichierNom: "ambigu.pdf", statutDext: "a_valider" },
    });

    const resultat = await listerFacturesFournisseursUnifiees(prisma);
    assert.equal(resultat.total, 4, "le total ne doit pas bouger : avoir/ambigu restent hors de cet ecran");
  });

  await t.test("statut 'a_traiter' pour un document Gmail/Dext pas encore envoye (a_valider)", async () => {
    await prisma.documentFournisseur.create({
      data: { type: "facture", fichierNom: "en-attente.pdf", numero: "FA-2", montantTTC: 80, statutDext: "a_valider" },
    });
    const resultat = await listerFacturesFournisseursUnifiees(prisma, { statut: "a_traiter" });
    assert.equal(resultat.total, 1);
    assert.equal(resultat.factures[0].fichierNom, "en-attente.pdf");
    assert.equal(resultat.compteurs.toutes, 5);
    assert.equal(resultat.compteurs.aTraiter, 1);

    const tout = await listerFacturesFournisseursUnifiees(prisma);
    // 120 (doc envoye) + 12 (ovh) + 30 (zip) + 6 (historique) + 80 (a_valider) = 248
    assert.equal(tout.montantTotalTTC, 248);
  });

  await t.test("recherche texte (fournisseur, numero) et pagination", async () => {
    const parNumero = await listerFacturesFournisseursUnifiees(prisma, { recherche: "OVH-1" });
    assert.equal(parNumero.total, 1);
    assert.equal(parNumero.factures[0].fournisseurNom, "OVHcloud");

    const parFournisseur = await listerFacturesFournisseursUnifiees(prisma, { fournisseurNom: "bouygues" });
    assert.equal(parFournisseur.total, 1);

    const page1 = await listerFacturesFournisseursUnifiees(prisma, { parPage: 2, page: 1 });
    const page2 = await listerFacturesFournisseursUnifiees(prisma, { parPage: 2, page: 2 });
    assert.equal(page1.factures.length, 2);
    assert.equal(page1.total, 5);
    assert.notDeepEqual(page1.factures.map((f) => f.id), page2.factures.map((f) => f.id));
  });

  await t.test("obtenirDetailFactureFournisseurUnifiee : detail reel pour chaque source, jamais d'historique invente", async () => {
    const document = await prisma.documentFournisseur.findFirst({ where: { numero: "FA-2" } });
    const detailDocument = await obtenirDetailFactureFournisseurUnifiee(prisma, `document:${document!.id}`);
    assert.equal(detailDocument.statut, "a_traiter");
    assert.ok(detailDocument.historique.length >= 1);
    assert.ok(detailDocument.historique.every((h) => h.date instanceof Date));

    const archive = await prisma.archiveComptable.findFirst({ where: { origine: "ovh_api" } });
    const detailArchive = await obtenirDetailFactureFournisseurUnifiee(prisma, `archive:${archive!.id}`);
    assert.equal(detailArchive.statut, "validee");
    assert.equal(detailArchive.historique[0].libelle, "Synchronisée depuis OVHcloud");

    await assert.rejects(() => obtenirDetailFactureFournisseurUnifiee(prisma, "document:introuvable"), FactureFournisseurUnifieeError);
    await assert.rejects(() => obtenirDetailFactureFournisseurUnifiee(prisma, "bruit-invalide"), FactureFournisseurUnifieeError);
  });
});

test("reconcilierDoublonsHistoriquesDext — reclasse a posteriori les copies archive_comptable anterieures au suivi 'origine'", async (t) => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });

  const { PrismaClient } = await import("@prisma/client");
  const { reconcilierDoublonsHistoriquesDext, listerFacturesFournisseursUnifiees } = await import("../src/services/facturesFournisseursUnifiees");
  const prisma = new PrismaClient();

  t.after(async () => {
    await prisma.$disconnect();
  });

  await t.test("cas reel signale par l'utilisateur : meme numero + meme montant TTC + meme fournisseur -> reclassee", async () => {
    const fournisseur = await prisma.fournisseur.create({ data: { nom: "Point.P" } });
    const document = await prisma.documentFournisseur.create({
      data: {
        type: "facture",
        fichierNom: "e-Facture PA.pdf",
        numero: "CFR00111626020513",
        montantHT: 44.17,
        montantTTC: 53,
        statutDext: "envoye",
        fournisseurId: fournisseur.id,
      },
    });
    const archive = await prisma.archiveComptable.create({
      data: {
        fichierNom: "e-Facture PA.pdf",
        cheminFichier: "/tmp/inexistant-pa.pdf",
        mimeType: "application/pdf",
        fournisseurNom: "Point.P",
        numero: "CFR00111626020513",
        montantHT: 44.17,
        montantTTC: 53,
        statut: "complete",
        origine: null,
      },
    });

    const avant = await listerFacturesFournisseursUnifiees(prisma);
    assert.equal(avant.total, 2, "avant reconciliation, la facture apparait bien en double (bug signale)");

    const resultat = await reconcilierDoublonsHistoriquesDext(prisma);
    assert.equal(resultat.reclassees.length, 1);
    assert.equal(resultat.reclassees[0].archiveId, archive.id);
    assert.equal(resultat.reclassees[0].documentId, document.id);

    const archiveApres = await prisma.archiveComptable.findUniqueOrThrow({ where: { id: archive.id } });
    assert.equal(archiveApres.origine, "dext_copie");
    assert.equal(archiveApres.documentFournisseurId, document.id);

    const apres = await listerFacturesFournisseursUnifiees(prisma);
    assert.equal(apres.total, 1, "le doublon ne doit plus apparaitre apres reconciliation");
  });

  await t.test("numero identique mais fournisseur different -> jamais reclassee (evite un faux positif)", async () => {
    const fournisseur = await prisma.fournisseur.create({ data: { nom: "Fournisseur A" } });
    const document = await prisma.documentFournisseur.create({
      data: { type: "facture", fichierNom: "fournisseur-a.pdf", numero: "DUP-1", montantTTC: 99, statutDext: "envoye", fournisseurId: fournisseur.id },
    });
    const archive = await prisma.archiveComptable.create({
      data: {
        fichierNom: "fournisseur-b.pdf",
        cheminFichier: "/tmp/inexistant-dup1.pdf",
        mimeType: "application/pdf",
        fournisseurNom: "Un Autre Fournisseur",
        numero: "DUP-1",
        montantTTC: 99,
        statut: "complete",
        origine: null,
      },
    });
    void document;

    const resultat = await reconcilierDoublonsHistoriquesDext(prisma);
    assert.equal(resultat.reclassees.length, 0);

    const archiveApres = await prisma.archiveComptable.findUniqueOrThrow({ where: { id: archive.id } });
    assert.equal(archiveApres.origine, null, "aucune reclassification sans certitude sur le fournisseur");
  });

  await t.test("deux documents candidats pour le meme numero+montant -> ambigu, jamais reclassee", async () => {
    await prisma.documentFournisseur.create({
      data: { type: "facture", fichierNom: "candidat-1.pdf", numero: "DUP-2", montantTTC: 42, statutDext: "envoye" },
    });
    await prisma.documentFournisseur.create({
      data: { type: "facture", fichierNom: "candidat-2.pdf", numero: "DUP-2", montantTTC: 42, statutDext: "archive" },
    });
    const archive = await prisma.archiveComptable.create({
      data: {
        fichierNom: "archive-ambigue.pdf",
        cheminFichier: "/tmp/inexistant-dup2.pdf",
        mimeType: "application/pdf",
        fournisseurNom: null,
        numero: "DUP-2",
        montantTTC: 42,
        statut: "complete",
        origine: null,
      },
    });

    const resultat = await reconcilierDoublonsHistoriquesDext(prisma);
    assert.equal(resultat.reclassees.length, 0);

    const archiveApres = await prisma.archiveComptable.findUniqueOrThrow({ where: { id: archive.id } });
    assert.equal(archiveApres.origine, null, "jamais de choix arbitraire entre plusieurs candidats");
  });

  await t.test("deja rejouee : idempotente, ne touche jamais une archive deja classee", async () => {
    const resultat = await reconcilierDoublonsHistoriquesDext(prisma);
    assert.equal(resultat.reclassees.length, 0, "la seule archive reclassable l'a deja ete au premier sous-test");
  });
});
