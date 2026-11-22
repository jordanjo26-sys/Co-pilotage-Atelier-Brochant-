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

// Decision fixee par l'utilisateur (voir le plan de restructuration,
// section "Suivi mensuel") : "Termine et valide" exige toujours un geste
// manuel explicite - jamais deduit automatiquement d'un taux de
// rapprochement de 100%. C'est l'assertion la plus importante de ce
// fichier (premiere sous-test ci-dessous).
test("suivi mensuel : statuts en_cours/a_verifier/termine_valide, validation manuelle, detection de drift", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { obtenirStatutMoisBancaire, validerMoisComptable, invaliderMoisComptable } = await import("../src/services/suiviMensuel");
  const prisma = new PrismaClient();

  async function mouvement(date: Date, statut: string) {
    return prisma.mouvementBancaire.create({
      data: { date, libelle: "TEST", debit: 10, credit: 0, montant: -10, hashLigne: ref("hash-suivi"), rapprochementStatut: statut },
    });
  }

  await t.test("mois entierement rapproche mais jamais valide -> reste 'en_cours', PAS 'termine_valide'", async () => {
    await mouvement(new Date("2026-01-05"), "rapproche");
    await mouvement(new Date("2026-01-15"), "rapproche");

    const statuts = await obtenirStatutMoisBancaire(prisma);
    const janvier = statuts.find((s) => s.periode === "2026-01");
    assert.ok(janvier);
    assert.equal(janvier?.nbMouvements, 2);
    assert.equal(janvier?.nbRapproches, 2);
    assert.equal(janvier?.statut, "en_cours");
    assert.equal(janvier?.valide, false);
  });

  await t.test("mois avec au moins un mouvement 'a_verifier' -> statut 'a_verifier'", async () => {
    await mouvement(new Date("2026-02-05"), "rapproche");
    await mouvement(new Date("2026-02-15"), "a_verifier");

    const statuts = await obtenirStatutMoisBancaire(prisma);
    const fevrier = statuts.find((s) => s.periode === "2026-02");
    assert.equal(fevrier?.statut, "a_verifier");
    assert.equal(fevrier?.nbAVerifier, 1);
  });

  await t.test("validerMoisComptable : passe le mois a 'termine_valide', avec l'auteur et les compteurs du moment", async () => {
    await validerMoisComptable(prisma, "2026-01", "Jordan");

    const statuts = await obtenirStatutMoisBancaire(prisma);
    const janvier = statuts.find((s) => s.periode === "2026-01");
    assert.equal(janvier?.statut, "termine_valide");
    assert.equal(janvier?.valide, true);
    assert.equal(janvier?.valideParAuteur, "Jordan");
    assert.equal(janvier?.driftDetecte, false);
  });

  await t.test("un nouveau mouvement sur un mois deja valide -> drift detecte, jamais invalide silencieusement", async () => {
    await mouvement(new Date("2026-01-20"), "non_rapproche");

    const statuts = await obtenirStatutMoisBancaire(prisma);
    const janvier = statuts.find((s) => s.periode === "2026-01");
    // Toujours "termine_valide" (jamais invalide tout seul) mais le drift
    // est signale pour que l'utilisateur decide.
    assert.equal(janvier?.statut, "termine_valide");
    assert.equal(janvier?.driftDetecte, true);
  });

  await t.test("invaliderMoisComptable : repasse le mois a 'en_cours' (soft, jamais de delete)", async () => {
    await invaliderMoisComptable(prisma, "2026-01", "Nouveau relevé importé après coup");

    const statuts = await obtenirStatutMoisBancaire(prisma);
    const janvier = statuts.find((s) => s.periode === "2026-01");
    assert.equal(janvier?.statut, "en_cours");
    assert.equal(janvier?.valide, false);

    const validation = await prisma.validationMoisComptable.findUnique({ where: { periode: "2026-01" } });
    assert.ok(validation, "la ligne de validation reste en base");
    assert.ok(validation?.invalideLe !== null);
    assert.equal(validation?.invalideMotif, "Nouveau relevé importé après coup");
  });

  await t.test("invaliderMoisComptable : refuse sur un mois jamais valide", async () => {
    await assert.rejects(() => invaliderMoisComptable(prisma, "2026-02"), /valid/);
  });

  await t.test("re-validerMoisComptable apres une invalidation : re-active la meme ligne avec les compteurs courants", async () => {
    await validerMoisComptable(prisma, "2026-01", "Jordan");
    const statuts = await obtenirStatutMoisBancaire(prisma);
    const janvier = statuts.find((s) => s.periode === "2026-01");
    assert.equal(janvier?.statut, "termine_valide");
    assert.equal(janvier?.nbMouvements, 3); // les 2 initiaux + celui ajoute plus haut
    assert.equal(janvier?.driftDetecte, false);
  });

  await prisma.$disconnect();
});
