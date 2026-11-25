/**
 * Test manuel du connecteur pilote CEDEO (BatiPrix IA, Phase 1) : lance une
 * recherche reelle et affiche ce qui a ete trouve, sans toucher a
 * l'interface Copilotage ni a aucune donnee en base au-dela du journal
 * d'evenements. A executer sur le serveur (ou tout environnement disposant
 * des trois variables CEDEO_URL/CEDEO_IDENTIFIANT/CEDEO_MOT_DE_PASSE et de
 * Playwright) :
 *
 *   npx tsx scripts/cedeo-test-recherche.ts "tube multicouche 16"
 *
 * Toujours en lecture seule (voir src/services/cedeoSync.ts) : aucune
 * action panier/commande n'est jamais declenchee par ce script.
 */
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { cedeoEstConfigure, rechercherPrixCedeo, CHEMIN_CAPTURE_ECHEC_CEDEO, CHEMIN_CAPTURE_RESULTAT_CEDEO } from "../src/services/cedeoSync";

dotenv.config();

async function main(): Promise<void> {
  const requete = process.argv.slice(2).join(" ").trim();
  if (!requete) {
    console.log('Usage : npx tsx scripts/cedeo-test-recherche.ts "tube multicouche 16"');
    process.exit(1);
  }

  if (!cedeoEstConfigure()) {
    console.log("CEDEO_URL / CEDEO_IDENTIFIANT / CEDEO_MOT_DE_PASSE ne sont pas tous les trois configures dans .env.");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    console.log(`Recherche CEDEO en cours pour : "${requete}"...`);
    const resultat = await rechercherPrixCedeo(prisma, requete);

    console.log(`\n${resultat.produits.length} produit(s) reconnu(s) automatiquement :`);
    for (const p of resultat.produits) {
      console.log(`- ${p.designation}${p.prix ? ` — ${p.prix}` : ""}`);
    }
    console.log(`\nDiagnostic de la page : ${resultat.diagnostic}`);
    console.log(`Capture d'écran des résultats : ${CHEMIN_CAPTURE_RESULTAT_CEDEO}`);
    if (resultat.produits.length === 0) {
      console.log(
        "\nAucun produit reconnu automatiquement (attendu pour cette première version, voir le commentaire en tête de cedeoSync.ts) : " +
          "regardez la capture d'écran ci-dessus pour voir la vraie page, ça permettra d'affiner l'extraction."
      );
    }
  } catch (err) {
    console.log(`\nÉchec : ${(err as Error).message}`);
    console.log(`Capture d'écran de l'échec : ${CHEMIN_CAPTURE_ECHEC_CEDEO}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
