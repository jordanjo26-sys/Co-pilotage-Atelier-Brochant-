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
    assert.equal(rMaj?.rapprochementStatut, "non_rapproche");
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
    const m = await prisma.mouvementBancaire.create({
      data: {
        date: new Date("2026-04-02"),
        libelle: "REMISE CB 999",
        debit: 0,
        credit: 200,
        montant: 200,
        montantBrut: 200,
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
