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

async function reinitialiser(prisma: import("@prisma/client").PrismaClient) {
  await prisma.envoiCampagne.deleteMany();
  await prisma.campagne.deleteMany();
  await prisma.emailTemplate.deleteMany();
  await prisma.prospectStatutChangement.deleteMany();
  await prisma.prospect.deleteMany();
}

test("listerProspectsDus : respecte le segment (code postal, desabonnement, email connu)", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const { listerProspectsDus } = await import("../src/services/prospection/campagnes");
  const prisma = new PrismaClient();
  await reinitialiser(prisma);

  const template = await prisma.emailTemplate.create({
    data: { nom: "Test", objet: "Bonjour {{entreprise}}", corpsHtml: "<p>Bonjour {{contact}}</p>" },
  });
  const campagne = await prisma.campagne.create({
    data: { nom: "Campagne 77", templateId: template.id, segmentFiltre: JSON.stringify({ codePostal: "77" }) },
  });

  await prisma.prospect.create({ data: { type: "syndic", entreprise: "Dans le 77", email: "a@test.fr", codePostal: "77000" } });
  await prisma.prospect.create({ data: { type: "syndic", entreprise: "Hors zone", email: "b@test.fr", codePostal: "94000" } });
  await prisma.prospect.create({ data: { type: "syndic", entreprise: "Sans email", codePostal: "77100" } });
  await prisma.prospect.create({
    data: { type: "syndic", entreprise: "Desinscrit", email: "d@test.fr", codePostal: "77200", desinscrit: true },
  });

  const dus = await listerProspectsDus(prisma, campagne.id);
  assert.deepEqual(
    dus.map((p) => p.entreprise).sort(),
    ["Dans le 77"]
  );

  await prisma.$disconnect();
});

test("listerRelancesDues : due seulement apres le delai, jamais si deja repondu", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const { listerRelancesDues } = await import("../src/services/prospection/campagnes");
  const prisma = new PrismaClient();
  await reinitialiser(prisma);

  const template = await prisma.emailTemplate.create({
    data: { nom: "Test", objet: "Bonjour", corpsHtml: "<p>Bonjour</p>" },
  });
  const campagne = await prisma.campagne.create({
    data: { nom: "Campagne relance", templateId: template.id, segmentFiltre: "{}", statut: "en_cours", relanceApresJours: 7 },
  });

  const ilYA = (jours: number) => new Date(Date.now() - jours * 24 * 60 * 60 * 1000);

  const prospectTropRecent = await prisma.prospect.create({ data: { type: "syndic", entreprise: "Trop recent", email: "a@test.fr" } });
  await prisma.envoiCampagne.create({ data: { campagneId: campagne.id, prospectId: prospectTropRecent.id, dateEnvoi: ilYA(2) } });

  const prospectDu = await prisma.prospect.create({ data: { type: "syndic", entreprise: "Relance due", email: "b@test.fr" } });
  await prisma.envoiCampagne.create({ data: { campagneId: campagne.id, prospectId: prospectDu.id, dateEnvoi: ilYA(10) } });

  const prospectRepondu = await prisma.prospect.create({ data: { type: "syndic", entreprise: "A repondu", email: "c@test.fr" } });
  await prisma.envoiCampagne.create({
    data: { campagneId: campagne.id, prospectId: prospectRepondu.id, dateEnvoi: ilYA(10), statut: "repondu" },
  });

  const dues = await listerRelancesDues(prisma);
  assert.deepEqual(
    dues.map((d) => d.entreprise),
    ["Relance due"]
  );

  await prisma.$disconnect();
});
