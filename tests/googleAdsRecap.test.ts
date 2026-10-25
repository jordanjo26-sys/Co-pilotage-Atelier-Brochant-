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

// Meme principe que tests/dailyRecap.test.ts : seules les branches "non
// envoyee" sont testables sans mocker l'API Gmail/Anthropic elle-meme -
// couvre la regression a eviter (un echec silencieux de ce planificateur,
// sans aucune trace en base, le rendrait indiagnosticable).
test("analyse quotidienne Google Ads : absence de configuration/connexion journalisee explicitement", async (t) => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });

  const { PrismaClient } = await import("@prisma/client");
  const { envoyerAnalyseQuotidienneAds } = await import("../src/services/googleAdsRecap");
  const prisma = new PrismaClient();

  await t.test("Google Ads non configure -> journalise un evenement explicite, ne leve pas d'erreur", async () => {
    const sauvegarde = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    try {
      await assert.doesNotReject(envoyerAnalyseQuotidienneAds(prisma, new Date()));
      const evenements = await prisma.journalEvenement.findMany({ where: { evenement: "analyse_ads_non_envoyee" } });
      assert.equal(evenements.length, 1);
      assert.match(evenements[0].resultat ?? "", /Google Ads non configure/);
    } finally {
      if (sauvegarde !== undefined) process.env.GOOGLE_ADS_DEVELOPER_TOKEN = sauvegarde;
    }
  });

  await t.test("Google Ads configure mais aucune connexion Gmail active -> journalise un evenement explicite", async () => {
    await prisma.journalEvenement.deleteMany({ where: { evenement: { in: ["analyse_ads_non_envoyee", "analyse_ads_envoyee", "analyse_ads_erreur"] } } });
    const sauvegarde = {
      token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      customerId: process.env.GOOGLE_ADS_CUSTOMER_ID,
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "jeton-test";
    process.env.GOOGLE_ADS_CUSTOMER_ID = "1234567890";
    process.env.GOOGLE_CLIENT_ID = "id-test";
    process.env.GOOGLE_CLIENT_SECRET = "secret-test";
    try {
      await assert.doesNotReject(envoyerAnalyseQuotidienneAds(prisma, new Date()));
      const evenements = await prisma.journalEvenement.findMany({ where: { evenement: "analyse_ads_non_envoyee" } });
      assert.equal(evenements.length, 1);
      assert.match(evenements[0].resultat ?? "", /aucune boite Gmail active/);
    } finally {
      for (const [cle, valeur] of Object.entries({
        GOOGLE_ADS_DEVELOPER_TOKEN: sauvegarde.token,
        GOOGLE_ADS_CUSTOMER_ID: sauvegarde.customerId,
        GOOGLE_CLIENT_ID: sauvegarde.clientId,
        GOOGLE_CLIENT_SECRET: sauvegarde.clientSecret,
      })) {
        if (valeur === undefined) delete process.env[cle];
        else process.env[cle] = valeur;
      }
    }
  });

  await prisma.$disconnect();
});
