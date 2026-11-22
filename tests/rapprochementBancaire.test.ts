import { test, before } from "node:test";
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

before(() => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });
});

let compteur = 0;
function ref(prefixe: string): string {
  compteur += 1;
  return `${prefixe}-${compteur}`;
}

test("rapprochement bancaire : correspondance unique, ambiguite, absence, idempotence", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { executerRapprochementBancaire } = await import("../src/services/rapprochementBancaire");
  const prisma = new PrismaClient();

  async function mouvement(date: Date, montant: number) {
    return prisma.mouvementBancaire.create({
      data: { date, libelle: "EVI STRIPE TECHNOLOGY EU", debit: 0, credit: montant, montant, hashLigne: ref("hash") },
    });
  }
  async function payout(date: Date, montantNet: number) {
    return prisma.payout.create({ data: { payoutRef: ref("po"), date, montantNet } });
  }

  await t.test("un seul mouvement candidat -> rapproche automatiquement", async () => {
    const d = new Date("2026-03-10");
    const m = await mouvement(new Date("2026-03-12"), 543.21);
    const p = await payout(d, 543.21);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.details.find((x) => x.payoutRef === p.payoutRef)?.resultat, "rapproche");

    const payoutMaj = await prisma.payout.findUnique({ where: { id: p.id } });
    const mouvementMaj = await prisma.mouvementBancaire.findUnique({ where: { id: m.id } });
    assert.equal(payoutMaj?.mouvementBancaireId, m.id);
    assert.equal(mouvementMaj?.rapprochementStatut, "rapproche");
  });

  await t.test("deux mouvements au meme montant -> ambigu, rien de rapproche", async () => {
    const d = new Date("2026-04-01");
    await mouvement(new Date("2026-04-02"), 200);
    await mouvement(new Date("2026-04-03"), 200);
    const p = await payout(d, 200);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.details.find((x) => x.payoutRef === p.payoutRef)?.resultat, "ambigu");

    const payoutMaj = await prisma.payout.findUnique({ where: { id: p.id } });
    assert.equal(payoutMaj?.mouvementBancaireId, null);
  });

  await t.test("aucun mouvement au bon montant -> sans correspondance", async () => {
    const p = await payout(new Date("2026-05-01"), 999.99);
    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.details.find((x) => x.payoutRef === p.payoutRef)?.resultat, "sans_correspondance");
  });

  await t.test("mouvement hors fenetre de dates (10 jours d'ecart) -> pas de rapprochement", async () => {
    await mouvement(new Date("2026-06-20"), 321.5);
    const p = await payout(new Date("2026-06-01"), 321.5);
    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.details.find((x) => x.payoutRef === p.payoutRef)?.resultat, "sans_correspondance");
  });

  await t.test("idempotent : rejouer ne modifie pas un payout deja rapproche", async () => {
    const d = new Date("2026-07-10");
    const m = await mouvement(new Date("2026-07-11"), 77.7);
    const p = await payout(d, 77.7);

    await executerRapprochementBancaire(prisma);
    const premierRapprochement = (await prisma.payout.findUnique({ where: { id: p.id } }))?.mouvementBancaireId;
    assert.equal(premierRapprochement, m.id);

    // Un second payout du meme montant ne doit pas voler le mouvement deja pris.
    const p2 = await payout(new Date("2026-07-10"), 77.7);
    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.details.find((x) => x.payoutRef === p.payoutRef), undefined, "deja rapproche, plus dans le lot a traiter");
    assert.equal(resultat.details.find((x) => x.payoutRef === p2.payoutRef)?.resultat, "sans_correspondance");
  });

  await prisma.$disconnect();
});

test("rapprochement bancaire : factures fournisseurs (debit)", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { executerRapprochementBancaire } = await import("../src/services/rapprochementBancaire");
  const prisma = new PrismaClient();

  const fournisseur = await prisma.fournisseur.create({ data: { nom: ref("fournisseur") } });

  async function mouvementDebit(date: Date, montant: number) {
    return prisma.mouvementBancaire.create({
      data: { date, libelle: "PRLV FOURNISSEUR", debit: montant, credit: 0, montant: -montant, hashLigne: ref("hash-debit") },
    });
  }
  async function mouvementCredit(date: Date, montant: number) {
    return prisma.mouvementBancaire.create({
      data: { date, libelle: "VIR RECU", debit: 0, credit: montant, montant, hashLigne: ref("hash-credit") },
    });
  }
  async function facture(echeance: Date | null, montant: number) {
    return prisma.factureFournisseur.create({ data: { fournisseurId: fournisseur.id, reference: ref("fact"), echeance, montant } });
  }

  await t.test("un seul mouvement debit candidat -> rapprochee, statut passe a payee", async () => {
    const echeance = new Date("2026-03-10");
    const m = await mouvementDebit(new Date("2026-03-15"), 123.45);
    const f = await facture(echeance, 123.45);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsFournisseurs.find((x) => x.factureId === f.id)?.resultat, "rapproche");

    const factureMaj = await prisma.factureFournisseur.findUnique({ where: { id: f.id } });
    assert.equal(factureMaj?.mouvementBancaireId, m.id);
    assert.equal(factureMaj?.statut, "payee");
  });

  await t.test("deux mouvements debit au meme montant -> ambigu, facture inchangee", async () => {
    const echeance = new Date("2026-04-01");
    await mouvementDebit(new Date("2026-04-05"), 50);
    await mouvementDebit(new Date("2026-04-06"), 50);
    const f = await facture(echeance, 50);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsFournisseurs.find((x) => x.factureId === f.id)?.resultat, "ambigu");

    const factureMaj = await prisma.factureFournisseur.findUnique({ where: { id: f.id } });
    assert.equal(factureMaj?.mouvementBancaireId, null);
    assert.equal(factureMaj?.statut, "a_payer");
  });

  await t.test("aucun mouvement au bon montant -> sans correspondance", async () => {
    const f = await facture(new Date("2026-05-01"), 888.88);
    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsFournisseurs.find((x) => x.factureId === f.id)?.resultat, "sans_correspondance");
  });

  await t.test("mouvement hors fenetre (30 jours d'ecart) -> pas de rapprochement", async () => {
    await mouvementDebit(new Date("2026-06-30"), 42.42);
    const f = await facture(new Date("2026-06-01"), 42.42);
    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsFournisseurs.find((x) => x.factureId === f.id)?.resultat, "sans_correspondance");
  });

  await t.test("facture sans echeance -> jamais rapprochee a l'aveugle", async () => {
    await mouvementDebit(new Date("2026-07-01"), 66.6);
    const f = await facture(null, 66.6);
    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsFournisseurs.find((x) => x.factureId === f.id)?.resultat, "sans_correspondance");
  });

  await t.test("un mouvement credit du meme montant n'est jamais utilise pour une facture fournisseur", async () => {
    await mouvementCredit(new Date("2026-08-02"), 90);
    const f = await facture(new Date("2026-08-01"), 90);
    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsFournisseurs.find((x) => x.factureId === f.id)?.resultat, "sans_correspondance");
  });

  await prisma.$disconnect();
});

// FactureFournisseur (teste au-dessus) n'est alimentee par aucun code
// actif de l'application - les vraies factures fournisseurs (Gmail/Dext)
// vivent dans DocumentFournisseur, d'ou cette deuxieme passe de
// rapprochement distincte (voir rapprochementBancaire.ts).
test("rapprochement bancaire : documents fournisseurs (vraies factures Gmail/Dext, debit)", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { executerRapprochementBancaire } = await import("../src/services/rapprochementBancaire");
  const prisma = new PrismaClient();

  async function mouvementDebit(date: Date, montant: number) {
    return prisma.mouvementBancaire.create({
      data: { date, libelle: "LEROY MERLIN", debit: montant, credit: 0, montant: -montant, hashLigne: ref("hash-doc-debit") },
    });
  }
  async function document(date: Date | null, montantTTC: number) {
    return prisma.documentFournisseur.create({
      data: { type: "facture", fichierNom: ref("facture") + ".pdf", date, montantTTC },
    });
  }

  await t.test("un seul mouvement debit candidat -> rapproche", async () => {
    const m = await mouvementDebit(new Date("2026-09-15"), 48.07);
    const d = await document(new Date("2026-09-10"), 48.07);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsDocuments.find((x) => x.documentId === d.id)?.resultat, "rapproche");

    const documentMaj = await prisma.documentFournisseur.findUnique({ where: { id: d.id } });
    assert.equal(documentMaj?.mouvementBancaireId, m.id);
  });

  await t.test("deux mouvements debit au meme montant -> ambigu, document inchange", async () => {
    await mouvementDebit(new Date("2026-10-05"), 50);
    await mouvementDebit(new Date("2026-10-06"), 50);
    const d = await document(new Date("2026-10-01"), 50);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsDocuments.find((x) => x.documentId === d.id)?.resultat, "ambigu");

    const documentMaj = await prisma.documentFournisseur.findUnique({ where: { id: d.id } });
    assert.equal(documentMaj?.mouvementBancaireId, null);
  });

  await t.test("document sans date (ni date ni dateReceptionMail) -> jamais rapproche a l'aveugle", async () => {
    await mouvementDebit(new Date("2026-11-01"), 66.6);
    const d = await document(null, 66.6);
    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsDocuments.find((x) => x.documentId === d.id)?.resultat, "sans_correspondance");
  });

  await t.test("montant TTC absent (document pas encore exploitable) -> jamais candidat", async () => {
    const d = await prisma.documentFournisseur.create({
      data: { type: "facture", fichierNom: ref("facture-sans-montant") + ".pdf", date: new Date("2026-11-05"), montantTTC: null },
    });
    await mouvementDebit(new Date("2026-11-05"), 123.0);
    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsDocuments.find((x) => x.documentId === d.id), undefined);
  });

  await t.test("un type different de 'facture' (ex. devis) n'est jamais candidat", async () => {
    const d = await prisma.documentFournisseur.create({
      data: { type: "devis", fichierNom: ref("devis") + ".pdf", date: new Date("2026-11-10"), montantTTC: 200 },
    });
    await mouvementDebit(new Date("2026-11-10"), 200);
    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsDocuments.find((x) => x.documentId === d.id), undefined);
  });

  await prisma.$disconnect();
});

// Demande explicite de l'utilisateur : des fournisseurs recurrents (EDF,
// Bouygues Telecom...) ne passent jamais par Gmail/Dext - la facture est
// telechargee directement en PDF et vit uniquement dans le module
// Comptabilite (ArchiveComptable, verifie sur les donnees reelles de
// production via /api/archives-comptables : 10 factures Bouygues Telecom
// et 29 factures EDF, 0 cote DocumentFournisseur pour ces deux fournisseurs).
test("rapprochement bancaire : archives comptables hors Dext (EDF, Bouygues Telecom..., debit)", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { executerRapprochementBancaire } = await import("../src/services/rapprochementBancaire");
  const prisma = new PrismaClient();

  async function mouvementDebit(libelle: string, date: Date, montant: number) {
    return prisma.mouvementBancaire.create({
      data: { date, libelle, debit: montant, credit: 0, montant: -montant, hashLigne: ref("hash-archive-debit") },
    });
  }
  async function archive(fournisseurNom: string, dateFacture: Date | null, montantTTC: number | null) {
    return prisma.archiveComptable.create({
      data: {
        fichierNom: ref("archive") + ".pdf",
        cheminFichier: "/tmp/inexistant.pdf",
        mimeType: "application/pdf",
        fournisseurNom,
        dateFacture,
        montantTTC,
      },
    });
  }

  await t.test("facture EDF archivee, un seul mouvement debit candidat -> rapprochee", async () => {
    const m = await mouvementDebit("PRLV SEPA EDF", new Date("2026-09-15"), 31.78);
    const a = await archive("EDF", new Date("2026-09-11"), 31.78);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsArchives.find((x) => x.archiveId === a.id)?.resultat, "rapproche");

    const archiveMaj = await prisma.archiveComptable.findUnique({ where: { id: a.id } });
    assert.equal(archiveMaj?.mouvementBancaireId, m.id);
  });

  await t.test("deux mouvements debit au meme montant -> ambigu, archive inchangee", async () => {
    await mouvementDebit("PRLV SEPA BOUYGUES TELECOM", new Date("2026-10-05"), 54.95);
    await mouvementDebit("PRLV SEPA BOUYGUES TELECOM", new Date("2026-10-06"), 54.95);
    const a = await archive("BOUYGUES TELECOM", new Date("2026-10-01"), 54.95);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsArchives.find((x) => x.archiveId === a.id)?.resultat, "ambigu");

    const archiveMaj = await prisma.archiveComptable.findUnique({ where: { id: a.id } });
    assert.equal(archiveMaj?.mouvementBancaireId, null);
  });

  // Cas reel signale par l'utilisateur (verifie sur ses donnees de
  // production) : une facture Castorama de 9,99€ ne se rapprochait jamais
  // car un prelevement Free Mobile recurrent, egalement a 9,99€, tombait
  // par coincidence dans la meme fenetre de 20 jours - deux candidats au
  // meme montant, jamais departages malgre un nom de commerçant sans
  // ambiguite possible pour un humain (voir departagerParNomFournisseur).
  await t.test("deux mouvements au meme montant mais un seul au libelle correspondant au fournisseur -> departage automatique", async () => {
    const mCastorama = await mouvementDebit("CASTORAMA FR PARIS 1487 (260326 CB****9383)", new Date("2026-03-26"), 9.99);
    await mouvementDebit("PRLV SEPA FREE MOBILE", new Date("2026-03-12"), 9.99);
    const a = await archive("Castorama", new Date("2026-03-26"), 9.99);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsArchives.find((x) => x.archiveId === a.id)?.resultat, "rapproche");

    const archiveMaj = await prisma.archiveComptable.findUnique({ where: { id: a.id } });
    assert.equal(archiveMaj?.mouvementBancaireId, mCastorama.id);
  });

  await t.test("deux mouvements au meme montant, aucun (ou plusieurs) au libelle correspondant -> reste ambigu", async () => {
    await mouvementDebit("PRLV SEPA FREE MOBILE", new Date("2026-04-12"), 19.99);
    await mouvementDebit("PRLV SEPA SFR", new Date("2026-04-14"), 19.99);
    const a = await archive("Un Fournisseur Sans Rapport", new Date("2026-04-15"), 19.99);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsArchives.find((x) => x.archiveId === a.id)?.resultat, "ambigu");

    const archiveMaj = await prisma.archiveComptable.findUnique({ where: { id: a.id } });
    assert.equal(archiveMaj?.mouvementBancaireId, null);
  });

  // Un mouvement deja marque "a_verifier" par une execution anterieure
  // (ambiguite jamais resorbee jusqu'ici, meme une fois le bon fournisseur
  // identifie par la suite) doit pouvoir etre repris par une execution
  // ulterieure - jamais bloque "a verifier" pour toujours (voir
  // STATUTS_CANDIDATS_DEBIT).
  await t.test("mouvement deja 'a_verifier' lors d'une execution precedente -> reconsidere et departage par le nom", async () => {
    const mLeroyMerlin = await mouvementDebit("LEROY MERLIN SCFR COLLEGIEN (070126 CB****9020)", new Date("2026-01-07"), 15.49);
    await prisma.mouvementBancaire.update({ where: { id: mLeroyMerlin.id }, data: { rapprochementStatut: "a_verifier" } });
    await mouvementDebit("PRLV SEPA FREE MOBILE", new Date("2026-01-10"), 15.49);
    const a = await archive("Leroy Merlin", new Date("2026-01-07"), 15.49);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsArchives.find((x) => x.archiveId === a.id)?.resultat, "rapproche");

    const archiveMaj = await prisma.archiveComptable.findUnique({ where: { id: a.id } });
    assert.equal(archiveMaj?.mouvementBancaireId, mLeroyMerlin.id);
  });

  await t.test("archive sans date de facture -> jamais rapprochee a l'aveugle", async () => {
    await mouvementDebit("PRLV SEPA BOUYGUES TELECOM", new Date("2026-11-01"), 94.54);
    const a = await archive("BOUYGUES TELECOM", null, 94.54);
    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsArchives.find((x) => x.archiveId === a.id)?.resultat, "sans_correspondance");
  });

  await t.test("montant TTC absent (archive pas encore exploitable) -> jamais candidate", async () => {
    const a = await archive("BOUYGUES TELECOM", new Date("2026-11-05"), null);
    await mouvementDebit("PRLV SEPA BOUYGUES TELECOM", new Date("2026-11-05"), 116.42);
    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsArchives.find((x) => x.archiveId === a.id), undefined);
  });

  await prisma.$disconnect();
});

// Demande explicite de l'utilisateur : "quand elle date du 9-10, c'est
// qu'il y a eu des reglements le 8-10 en carte bleue" - une remise carte
// bleue regroupe tous les encaissements Carte d'une journee donnee (voir
// rapprochementBancaire.ts).
test("rapprochement bancaire : remises carte bleue (REMISE CB) <-> encaissements clients Carte", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { executerRapprochementBancaire } = await import("../src/services/rapprochementBancaire");
  const prisma = new PrismaClient();

  async function remiseCb(date: Date, montantNet: number, montantBrut: number) {
    return prisma.mouvementBancaire.create({
      data: {
        date,
        libelle: "REMISE CB 1317821012",
        debit: 0,
        credit: montantNet,
        montant: montantNet,
        montantBrut,
        hashLigne: ref("hash-remise"),
      },
    });
  }
  async function facture() {
    return prisma.facture.create({
      data: { reference: ref("fact"), clientNom: "Client Test", montantTTC: 1000, statut: "payee" },
    });
  }
  async function encaissementCarte(factureId: string, date: Date, montant: number) {
    return prisma.encaissement.create({ data: { factureId, date, montant, mode: "Carte" } });
  }

  await t.test("un seul jour candidat dont la somme egale le BRUT -> rapprochee, tous les encaissements lies", async () => {
    const f1 = await facture();
    const f2 = await facture();
    const e1 = await encaissementCarte(f1.id, new Date("2026-01-01"), 2377.88);
    const r = await remiseCb(new Date("2026-01-02"), 2348.16, 2377.88);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsRemisesCb.find((x) => x.mouvementId === r.id)?.resultat, "rapproche");

    const e1Maj = await prisma.encaissement.findUnique({ where: { id: e1.id } });
    assert.equal(e1Maj?.mouvementBancaireId, r.id);
    const rMaj = await prisma.mouvementBancaire.findUnique({ where: { id: r.id } });
    assert.equal(rMaj?.rapprochementStatut, "rapproche");
    void f2;
  });

  await t.test("plusieurs encaissements du meme jour sommes ensemble -> tous rapproches au meme mouvement", async () => {
    const f1 = await facture();
    const f2 = await facture();
    const e1 = await encaissementCarte(f1.id, new Date("2026-02-01"), 100);
    const e2 = await encaissementCarte(f2.id, new Date("2026-02-01"), 50.5);
    const r = await remiseCb(new Date("2026-02-02"), 145, 150.5);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsRemisesCb.find((x) => x.mouvementId === r.id)?.resultat, "rapproche");

    const e1Maj = await prisma.encaissement.findUnique({ where: { id: e1.id } });
    const e2Maj = await prisma.encaissement.findUnique({ where: { id: e2.id } });
    assert.equal(e1Maj?.mouvementBancaireId, r.id);
    assert.equal(e2Maj?.mouvementBancaireId, r.id);
  });

  await t.test("deux jours candidats a la meme somme -> ambigu, rien de rapproche", async () => {
    const f1 = await facture();
    const f2 = await facture();
    await encaissementCarte(f1.id, new Date("2026-03-01"), 60);
    await encaissementCarte(f2.id, new Date("2026-03-02"), 60);
    const r = await remiseCb(new Date("2026-03-03"), 59, 60);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsRemisesCb.find((x) => x.mouvementId === r.id)?.resultat, "ambigu");

    const rMaj = await prisma.mouvementBancaire.findUnique({ where: { id: r.id } });
    // Restructuration Comptabilite (Phase 3) : une ambiguite est desormais
    // persistee ("a_verifier"), plutot que silencieusement perdue - c'est
    // precisement ce qui permet a l'interface d'afficher "a confirmer"
    // (bordure orange) pour ce mouvement.
    assert.equal(rMaj?.rapprochementStatut, "a_verifier");
  });

  await t.test("aucun jour a la bonne somme -> sans correspondance", async () => {
    const f1 = await facture();
    await encaissementCarte(f1.id, new Date("2026-04-01"), 33.33);
    const r = await remiseCb(new Date("2026-04-02"), 98, 99.99);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsRemisesCb.find((x) => x.mouvementId === r.id)?.resultat, "sans_correspondance");
  });

  await t.test("un encaissement en Cheque (pas Carte) n'est jamais utilise pour une remise CB", async () => {
    const f1 = await facture();
    await prisma.encaissement.create({
      data: { factureId: f1.id, date: new Date("2026-05-01"), montant: 77, mode: "Chèque" },
    });
    const r = await remiseCb(new Date("2026-05-02"), 76, 77);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsRemisesCb.find((x) => x.mouvementId === r.id)?.resultat, "sans_correspondance");
  });

  await t.test("un encaissement trop ancien (hors fenetre) n'est jamais utilise", async () => {
    const f1 = await facture();
    await encaissementCarte(f1.id, new Date("2026-06-01"), 44.44);
    const r = await remiseCb(new Date("2026-06-20"), 43, 44.44);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsRemisesCb.find((x) => x.mouvementId === r.id)?.resultat, "sans_correspondance");
  });

  // Cas reel de production (remise du 2026-10-08, montant brut 433.48€) :
  // l'encaissement correspondant n'a ete saisi dans Synec que le lendemain
  // de la remise bancaire - jamais suppose qu'un encaissement precede
  // toujours sa remise (section 14, verifie via /api/encaissements).
  await t.test("un encaissement saisi un jour APRES la date de la remise est quand meme retenu", async () => {
    const f1 = await facture();
    const e1 = await encaissementCarte(f1.id, new Date("2026-07-02"), 433.48);
    const r = await remiseCb(new Date("2026-07-01"), 420, 433.48);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsRemisesCb.find((x) => x.mouvementId === r.id)?.resultat, "rapproche");

    const e1Maj = await prisma.encaissement.findUnique({ where: { id: e1.id } });
    assert.equal(e1Maj?.mouvementBancaireId, r.id);
  });

  // Cas reel de production (remise du 2026-02-26, montant brut 902€) : la
  // meme journee comporte deux encaissements Carte (450€ et 902€), mais un
  // seul lot correspond a cette remise precise - jamais de regroupement
  // par jour calendaire entier (ce serait deviner), seulement le
  // sous-ensemble dont la somme egale exactement le brut.
  await t.test("un seul encaissement d'une journee qui en compte plusieurs -> rapproche uniquement celui-la", async () => {
    const f1 = await facture();
    const f2 = await facture();
    const e1 = await encaissementCarte(f1.id, new Date("2026-08-01"), 450);
    const e2 = await encaissementCarte(f2.id, new Date("2026-08-01"), 902);
    const r = await remiseCb(new Date("2026-08-02"), 890, 902);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsRemisesCb.find((x) => x.mouvementId === r.id)?.resultat, "rapproche");

    const e1Maj = await prisma.encaissement.findUnique({ where: { id: e1.id } });
    const e2Maj = await prisma.encaissement.findUnique({ where: { id: e2.id } });
    assert.equal(e1Maj?.mouvementBancaireId, null);
    assert.equal(e2Maj?.mouvementBancaireId, r.id);
  });

  await prisma.$disconnect();
});

// Une remise de cheques peut regrouper des cheques encaisses sur une
// periode bien plus longue et irreguliere qu'une remise CB (le depot en
// banque n'est pas quotidien) - voir rapprochementBancaire.ts,
// FENETRE_JOURS_REMISE_CHEQUES_*. Pas de commission sur un cheque : la
// cible est le montant du mouvement lui-meme (pas de montantBrut).
test("rapprochement bancaire : remises de cheques (REMISE CHEQUES/REM CHQ) <-> encaissements clients Chèque", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { executerRapprochementBancaire } = await import("../src/services/rapprochementBancaire");
  const prisma = new PrismaClient();

  async function remiseCheques(libelle: string, date: Date, montant: number) {
    return prisma.mouvementBancaire.create({
      data: { date, libelle, debit: 0, credit: montant, montant, hashLigne: ref("hash-remise-cheque") },
    });
  }
  async function facture() {
    return prisma.facture.create({
      data: { reference: ref("fact"), clientNom: "Client Test", montantTTC: 1000, statut: "payee" },
    });
  }
  async function encaissementCheque(factureId: string, date: Date, montant: number) {
    return prisma.encaissement.create({ data: { factureId, date, montant, mode: "Chèque" } });
  }

  await t.test("un seul cheque encaisse plusieurs semaines avant le depot -> rapproche", async () => {
    const f1 = await facture();
    const e1 = await encaissementCheque(f1.id, new Date("2026-01-05"), 4000);
    const r = await remiseCheques("REMISE CHEQUES 12345", new Date("2026-02-20"), 4000);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsRemisesCheques.find((x) => x.mouvementId === r.id)?.resultat, "rapproche");

    const e1Maj = await prisma.encaissement.findUnique({ where: { id: e1.id } });
    assert.equal(e1Maj?.mouvementBancaireId, r.id);
  });

  await t.test("plusieurs cheques de dates differentes regroupes dans un seul depot -> tous rapproches", async () => {
    const f1 = await facture();
    const f2 = await facture();
    const e1 = await encaissementCheque(f1.id, new Date("2026-03-01"), 1000);
    const e2 = await encaissementCheque(f2.id, new Date("2026-03-20"), 2000);
    const r = await remiseCheques("REM CHQ DEPLACE 999", new Date("2026-04-02"), 3000);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsRemisesCheques.find((x) => x.mouvementId === r.id)?.resultat, "rapproche");

    const e1Maj = await prisma.encaissement.findUnique({ where: { id: e1.id } });
    const e2Maj = await prisma.encaissement.findUnique({ where: { id: e2.id } });
    assert.equal(e1Maj?.mouvementBancaireId, r.id);
    assert.equal(e2Maj?.mouvementBancaireId, r.id);
  });

  await t.test("deux cheques isoles au meme montant -> ambigu", async () => {
    const f1 = await facture();
    const f2 = await facture();
    await encaissementCheque(f1.id, new Date("2026-05-01"), 500);
    await encaissementCheque(f2.id, new Date("2026-05-15"), 500);
    const r = await remiseCheques("REMISE CHEQUES 111", new Date("2026-06-01"), 500);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsRemisesCheques.find((x) => x.mouvementId === r.id)?.resultat, "ambigu");
  });

  await t.test("aucun cheque a la bonne somme -> sans correspondance", async () => {
    const f1 = await facture();
    await encaissementCheque(f1.id, new Date("2026-07-01"), 123.45);
    const r = await remiseCheques("REMISE CHEQUES 222", new Date("2026-07-10"), 999.99);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsRemisesCheques.find((x) => x.mouvementId === r.id)?.resultat, "sans_correspondance");
  });

  await t.test("un encaissement en Carte (pas Cheque) n'est jamais utilise pour une remise de cheques", async () => {
    const f1 = await facture();
    await prisma.encaissement.create({
      data: { factureId: f1.id, date: new Date("2026-08-01"), montant: 321, mode: "Carte" },
    });
    const r = await remiseCheques("REMISE CHEQUES 333", new Date("2026-08-10"), 321);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsRemisesCheques.find((x) => x.mouvementId === r.id)?.resultat, "sans_correspondance");
  });

  await prisma.$disconnect();
});

// Demande explicite de l'utilisateur : le nom affiche sur le releve
// ("Ethan Zerbib") ne correspond pas toujours au nom du client/fournisseur
// dans nos donnees ("LM Débouchage") - jamais de recherche par nom, donc,
// uniquement montant + fenetre de dates (voir rapprochementBancaire.ts).
test("rapprochement bancaire : virements clients directs (VIR INST/EVI, un seul encaissement par mouvement)", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { executerRapprochementBancaire } = await import("../src/services/rapprochementBancaire");
  const prisma = new PrismaClient();

  async function virementRecu(libelle: string, date: Date, montant: number) {
    return prisma.mouvementBancaire.create({
      data: { date, libelle, debit: 0, credit: montant, montant, hashLigne: ref("hash-vir") },
    });
  }
  async function facture() {
    return prisma.facture.create({
      data: { reference: ref("fact"), clientNom: "Client Test", montantTTC: 1000, statut: "payee" },
    });
  }
  async function encaissementVirement(factureId: string, date: Date, montant: number) {
    return prisma.encaissement.create({ data: { factureId, date, montant, mode: "Virement" } });
  }

  await t.test("montant unique dans la fenetre -> rapproche, meme si le nom affiche ne correspond a rien cote client", async () => {
    const f = await facture();
    const e = await encaissementVirement(f.id, new Date("2026-01-01"), 1080);
    const m = await virementRecu("VIR INST ethan zerbib", new Date("2026-01-02"), 1080);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsVirementsClients.find((x) => x.mouvementId === m.id)?.resultat, "rapproche");

    const eMaj = await prisma.encaissement.findUnique({ where: { id: e.id } });
    assert.equal(eMaj?.mouvementBancaireId, m.id);
  });

  await t.test("deux encaissements au meme montant dans la fenetre -> ambigu", async () => {
    const f1 = await facture();
    const f2 = await facture();
    await encaissementVirement(f1.id, new Date("2026-02-01"), 300);
    await encaissementVirement(f2.id, new Date("2026-02-02"), 300);
    const m = await virementRecu("EVI MME TEST", new Date("2026-02-03"), 300);

    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsVirementsClients.find((x) => x.mouvementId === m.id)?.resultat, "ambigu");
  });

  await t.test("aucun encaissement au bon montant -> sans correspondance", async () => {
    const m = await virementRecu("VIR INST inconnu", new Date("2026-03-01"), 777.77);
    const resultat = await executerRapprochementBancaire(prisma);
    assert.equal(resultat.detailsVirementsClients.find((x) => x.mouvementId === m.id)?.resultat, "sans_correspondance");
  });

  await t.test("une REMISE CB n'est jamais traitee par cette passe (lot, pas un virement individuel)", async () => {
    const f = await facture();
    await encaissementVirement(f.id, new Date("2026-04-01"), 200);
    // Montant volontairement distinct de tout autre montant de ce fichier
    // (ex. le payout "200" du tout premier test, ambigu et donc jamais
    // consomme) : un montant deja utilise ailleurs dans ce fichier peut
    // coincidentally matcher un mouvement cree bien plus tot et encore non
    // resolu, ce qui n'a rien a voir avec ce que ce test verifie.
    const m = await prisma.mouvementBancaire.create({
      data: {
        date: new Date("2026-04-02"),
        libelle: "REMISE CB 999",
        debit: 0,
        credit: 234.07,
        montant: 234.07,
        montantBrut: 234.07,
        hashLigne: ref("hash-remise-exclue"),
      },
    });
    await executerRapprochementBancaire(prisma);
    const mApres = await prisma.mouvementBancaire.findUnique({ where: { id: m.id } });
    // La remise CB est traitee par sa propre passe (ici sans correspondance
    // Carte, donc restee non_rapproche), jamais par celle des virements.
    assert.equal(mApres?.rapprochementStatut, "non_rapproche");
  });

  await prisma.$disconnect();
});
