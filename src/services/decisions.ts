import { PrismaClient } from "@prisma/client";
import { logEvenement } from "./journalService";

/**
 * Memoire metier a long terme (section 8 du cahier des charges, Phase 8).
 * S'appuie sur le modele `Decision`, deja prevu dans le schema depuis le
 * debut du projet mais jamais exploite jusqu'ici (voir docs/architecture.md).
 *
 * Choix delibere : une memoire STRUCTUREE et consultable (un carnet de
 * decisions qu'un humain peut aussi relire directement en base), plutot
 * qu'une memoire "floue" de conversation ou une recherche semantique — dans
 * la continuite de la section 14 ("jamais de supposition"), Morgane
 * consulte des faits enregistres explicitement, jamais une reconstruction
 * approximative d'un historique de chat.
 */

export type TypeDecision = "delai_accorde" | "exception" | "financement_oney" | "correction";

export interface DecisionEnregistree {
  type: TypeDecision;
  motif: string | null;
  auteur: string | null;
  objetType: string | null;
  objetId: string | null;
  dateFin: Date | null;
}

export async function enregistrerDecision(prisma: PrismaClient, decision: DecisionEnregistree) {
  const cree = await prisma.decision.create({
    data: {
      type: decision.type,
      motif: decision.motif,
      auteur: decision.auteur,
      objetType: decision.objetType,
      objetId: decision.objetId,
      dateFin: decision.dateFin,
    },
  });
  await logEvenement(prisma, {
    evenement: "decision_memorisee",
    action: `Decision enregistree (${decision.type})${decision.objetType ? ` sur ${decision.objetType}${decision.objetId ? " " + decision.objetId : ""}` : ""}`,
    resultat: decision.motif || "",
  });
  return cree;
}

export interface FiltreDecisions {
  objetType?: string;
  objetId?: string;
  type?: TypeDecision;
  activesSeulement?: boolean;
}

/**
 * Liste les decisions enregistrees, les plus recentes en premier.
 * `activesSeulement` exclut celles pas encore commencees ou deja terminees
 * (dateFin depassee) — c'est le filtre que Morgane doit utiliser avant
 * d'agir ou de repondre, pour ne jamais tenir compte d'une decision perimee.
 */
export async function listerDecisions(prisma: PrismaClient, filtre: FiltreDecisions = {}, maintenant: Date = new Date()) {
  const where: Record<string, unknown> = {};
  if (filtre.objetType) where.objetType = filtre.objetType;
  if (filtre.objetId) where.objetId = filtre.objetId;
  if (filtre.type) where.type = filtre.type;
  if (filtre.activesSeulement) {
    where.dateDebut = { lte: maintenant };
    where.OR = [{ dateFin: null }, { dateFin: { gt: maintenant } }];
  }

  return prisma.decision.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 });
}

/** Met fin des maintenant a une decision (revocation), sans la supprimer : garde la trace. */
export async function terminerDecision(prisma: PrismaClient, id: string, maintenant: Date = new Date()) {
  return prisma.decision.update({ where: { id }, data: { dateFin: maintenant } });
}
