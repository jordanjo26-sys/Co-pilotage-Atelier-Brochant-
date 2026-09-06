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

function ilYA(jours: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - jours);
  return d;
}
function dans(jours: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + jours);
  return d;
}

test("moteur de relances : paliers, delai accorde, et anti-doublon", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { listerFacturesARelancer } = await import("../src/services/relances");
  const prisma = new PrismaClient();

  const client = await prisma.client.create({ data: { nom: "Client Test", email: "client@example.com" } });
  const clientSansEmail = await prisma.client.create({ data: { nom: "Client Sans Email" } });

  await t.test("facture en retard de 10 jours, jamais relancee -> palier rappel", async () => {
    const f = await prisma.facture.create({
      data: {
        reference: "F-001",
        clientId: client.id,
        clientNom: client.nom,
        montantTTC: 100,
        statut: "impayee",
        dateEcheance: ilYA(10),
      },
    });
    const liste = await listerFacturesARelancer(prisma);
    const trouvee = liste.find((r) => r.factureId === f.id);
    assert.ok(trouvee, "la facture doit apparaitre");
    assert.equal(trouvee!.palier.id, "rappel");
    assert.equal(trouvee!.clientEmail, "client@example.com");
  });

  await t.test("facture en retard de 3 jours (sous le premier seuil) -> absente", async () => {
    const f = await prisma.facture.create({
      data: { reference: "F-002", clientId: client.id, clientNom: client.nom, montantTTC: 50, statut: "impayee", dateEcheance: ilYA(3) },
    });
    const liste = await listerFacturesARelancer(prisma);
    assert.equal(liste.some((r) => r.factureId === f.id), false);
  });

  await t.test("facture pas encore echue -> absente", async () => {
    const f = await prisma.facture.create({
      data: { reference: "F-003", clientId: client.id, clientNom: client.nom, montantTTC: 50, statut: "impayee", dateEcheance: dans(5) },
    });
    const liste = await listerFacturesARelancer(prisma);
    assert.equal(liste.some((r) => r.factureId === f.id), false);
  });

  await t.test("delai accorde en cours (section 4.3) -> suspend la relance meme tres en retard", async () => {
    const f = await prisma.facture.create({
      data: {
        reference: "F-004",
        clientId: client.id,
        clientNom: client.nom,
        montantTTC: 50,
        statut: "impayee",
        dateEcheance: ilYA(60),
        delaiAccordeJusqua: dans(10),
      },
    });
    const liste = await listerFacturesARelancer(prisma);
    assert.equal(liste.some((r) => r.factureId === f.id), false);
  });

  await t.test("palier deja envoye -> pas de doublon tant qu'aucun nouveau palier n'est atteint", async () => {
    const f = await prisma.facture.create({
      data: { reference: "F-005", clientId: client.id, clientNom: client.nom, montantTTC: 50, statut: "impayee", dateEcheance: ilYA(20) },
    });
    await prisma.relance.create({ data: { factureId: f.id, palier: "relance", destinataire: "client@example.com" } });
    const liste = await listerFacturesARelancer(prisma);
    assert.equal(liste.some((r) => r.factureId === f.id), false, "le palier 'relance' (15j) est deja envoye, 20j n'atteint pas 'mise_en_demeure' (30j)");
  });

  await t.test("nouveau palier atteint malgre un palier anterieur deja envoye", async () => {
    const f = await prisma.facture.create({
      data: { reference: "F-006", clientId: client.id, clientNom: client.nom, montantTTC: 50, statut: "impayee", dateEcheance: ilYA(35) },
    });
    await prisma.relance.create({ data: { factureId: f.id, palier: "rappel", destinataire: "client@example.com" } });
    const liste = await listerFacturesARelancer(prisma);
    const trouvee = liste.find((r) => r.factureId === f.id);
    assert.ok(trouvee);
    assert.equal(trouvee!.palier.id, "mise_en_demeure");
  });

  await t.test("client sans e-mail connu -> apparait quand meme, avec clientEmail null", async () => {
    const f = await prisma.facture.create({
      data: { reference: "F-007", clientId: clientSansEmail.id, clientNom: clientSansEmail.nom, montantTTC: 50, statut: "impayee", dateEcheance: ilYA(10) },
    });
    const liste = await listerFacturesARelancer(prisma);
    const trouvee = liste.find((r) => r.factureId === f.id);
    assert.ok(trouvee);
    assert.equal(trouvee!.clientEmail, null);
  });

  await t.test("facture payee -> jamais relancee", async () => {
    const f = await prisma.facture.create({
      data: { reference: "F-008", clientId: client.id, clientNom: client.nom, montantTTC: 50, montantRegle: 50, statut: "payee", dateEcheance: ilYA(40) },
    });
    const liste = await listerFacturesARelancer(prisma);
    assert.equal(liste.some((r) => r.factureId === f.id), false);
  });

  await prisma.$disconnect();
});
