import { PrismaClient } from "@prisma/client";

/**
 * Controle croise releve fournisseur <-> factures detaillees (section 6.3
 * du cahier des charges) — premiere version deliberement simple : sans
 * exemple reel de releve fournisseur, extraire et verifier chaque ligne
 * d'un PDF de mise en page inconnue reviendrait a deviner un format
 * (contraire a la section 14) — voir le meme choix deja fait pour les CSV
 * et le releve bancaire, construits seulement une fois un export reel
 * recu (docs/architecture.md).
 *
 * Ce que cette version verifie, de facon fiable avec les donnees deja en
 * base : un releve n'a de sens que s'il existe deja des factures connues
 * de ce fournisseur. Un releve recu d'un fournisseur dont on ne connait
 * encore AUCUNE facture est le signe qu'on a probablement manque des
 * e-mails de factures (mal classes, jamais recus...) — signale comme
 * anomalie plutot qu'ignore silencieusement.
 */

const TYPE_ANOMALIE = "releve_sans_facture_connue";

/**
 * A appeler juste apres l'enregistrement d'un DocumentFournisseur de type
 * "releve". Idempotent : ne cree pas de second signalement tant que le
 * premier reste "a_valider" pour ce meme fournisseur.
 */
export async function controlerReleveFournisseur(
  prisma: PrismaClient,
  params: { fournisseurId: string | null; fournisseurNom: string; fichierNom: string | null }
): Promise<void> {
  if (!params.fournisseurId) return; // pas de fiche fournisseur resolue, rien a controler

  const nbFactures = await prisma.documentFournisseur.count({
    where: { fournisseurId: params.fournisseurId, type: "facture" },
  });
  if (nbFactures > 0) return; // au moins une facture connue : rien d'anormal

  const dejaSignale = await prisma.anomalie.findMany({ where: { type: TYPE_ANOMALIE, statut: "a_valider" } });
  const dejaPourCeFournisseur = dejaSignale.some((a) => {
    try {
      return JSON.parse(a.preuves || "{}").fournisseurId === params.fournisseurId;
    } catch {
      return false;
    }
  });
  if (dejaPourCeFournisseur) return; // deja signale et toujours en attente : pas de doublon

  await prisma.anomalie.create({
    data: {
      type: TYPE_ANOMALIE,
      gravite: "moyenne",
      preuves: JSON.stringify({
        fournisseurId: params.fournisseurId,
        fournisseurNom: params.fournisseurNom,
        expediteur: params.fournisseurNom,
        fichier: params.fichierNom,
      }),
      actionProposee: `Un relevé a été reçu de "${params.fournisseurNom}" mais aucune facture de ce fournisseur n'est encore connue : vérifier si des factures ont été manquées (mail non reçu, mal classé...).`,
    },
  });
}
