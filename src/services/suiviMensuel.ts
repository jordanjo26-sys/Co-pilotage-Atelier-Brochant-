import { PrismaClient } from "@prisma/client";
import { cleDePeriode } from "./depensesFournisseurs";

/**
 * Suivi mensuel du rapprochement bancaire (demande explicite de
 * l'utilisateur : "consulter chaque mois et son etat de rapprochement
 * bancaire : En cours / A verifier / Termine et valide"). Regroupe en
 * memoire comme depensesFournisseurs.ts (meme volume modeste, meme raison :
 * eviter une requete SQL specifique a un moteur de base de donnees precis).
 *
 * Decision fixee (voir le plan de restructuration, section "Suivi mensuel") :
 * le statut "Termine et valide" exige TOUJOURS un geste manuel explicite de
 * l'utilisateur (validerMoisComptable), jamais deduit automatiquement d'un
 * taux de rapprochement de 100% - memes tous les mouvements du mois
 * rapproches, le mois reste "En cours" tant que ce geste n'a pas eu lieu.
 */

export type StatutMoisBancaire = "en_cours" | "a_verifier" | "termine_valide";

export interface StatutMoisBancaireDetail {
  periode: string; // "AAAA-MM"
  nbMouvements: number;
  nbRapproches: number;
  nbAVerifier: number;
  nbNonRapproches: number;
  statut: StatutMoisBancaire;
  valide: boolean;
  valideLe: Date | null;
  valideParAuteur: string | null;
  // Un releve importe apres-coup sur un mois deja valide peut changer les
  // compteurs sans jamais invalider silencieusement la validation - signale
  // ici, a l'utilisateur de decider (voir invaliderMoisComptable).
  driftDetecte: boolean;
}

async function compterMouvementsParPeriode(prisma: PrismaClient) {
  const mouvements = await prisma.mouvementBancaire.findMany({ select: { date: true, rapprochementStatut: true } });

  const comptes = new Map<string, { nbMouvements: number; nbRapproches: number; nbAVerifier: number; nbNonRapproches: number }>();
  for (const m of mouvements) {
    const periode = cleDePeriode(m.date, "mois");
    if (!comptes.has(periode)) comptes.set(periode, { nbMouvements: 0, nbRapproches: 0, nbAVerifier: 0, nbNonRapproches: 0 });
    const c = comptes.get(periode)!;
    c.nbMouvements++;
    if (m.rapprochementStatut === "rapproche") c.nbRapproches++;
    else if (m.rapprochementStatut === "a_verifier") c.nbAVerifier++;
    else c.nbNonRapproches++;
  }
  return comptes;
}

export async function obtenirStatutMoisBancaire(prisma: PrismaClient): Promise<StatutMoisBancaireDetail[]> {
  const comptes = await compterMouvementsParPeriode(prisma);
  const validations = await prisma.validationMoisComptable.findMany({ where: { periode: { in: [...comptes.keys()] } } });
  const validationParPeriode = new Map(validations.map((v) => [v.periode, v]));

  return [...comptes.entries()]
    .map(([periode, c]) => {
      const validation = validationParPeriode.get(periode);
      const valideActive = !!validation && validation.valide && validation.invalideLe === null;
      const driftDetecte = valideActive && (c.nbMouvements !== validation!.nbMouvementsAuMoment || c.nbRapproches !== validation!.nbRapprochesAuMoment);

      let statut: StatutMoisBancaire;
      if (valideActive) statut = "termine_valide";
      else if (c.nbAVerifier > 0) statut = "a_verifier";
      else statut = "en_cours";

      return {
        periode,
        nbMouvements: c.nbMouvements,
        nbRapproches: c.nbRapproches,
        nbAVerifier: c.nbAVerifier,
        nbNonRapproches: c.nbNonRapproches,
        statut,
        valide: valideActive,
        valideLe: valideActive ? validation!.createdAt : null,
        valideParAuteur: valideActive ? validation!.auteur : null,
        driftDetecte,
      };
    })
    .sort((a, b) => b.periode.localeCompare(a.periode));
}

/**
 * Geste manuel explicite de validation d'un mois (jamais automatique, voir
 * ci-dessus). Si le mois avait ete valide puis invalide (drift detecte), ce
 * geste re-valide la MEME ligne (periode unique) avec les compteurs
 * courants plutot que d'en creer une nouvelle - l'historique des
 * validations/invalidations successives reste neanmoins traceable via
 * invalideLe/invalideMotif, jamais ecrase silencieusement sans y avoir
 * accès avant l'ecriture suivante.
 */
export async function validerMoisComptable(prisma: PrismaClient, periode: string, auteur?: string) {
  const comptes = await compterMouvementsParPeriode(prisma);
  const c = comptes.get(periode) ?? { nbMouvements: 0, nbRapproches: 0, nbAVerifier: 0, nbNonRapproches: 0 };

  return prisma.validationMoisComptable.upsert({
    where: { periode },
    create: {
      periode,
      valide: true,
      auteur: auteur ?? null,
      nbMouvementsAuMoment: c.nbMouvements,
      nbRapprochesAuMoment: c.nbRapproches,
    },
    update: {
      valide: true,
      auteur: auteur ?? null,
      nbMouvementsAuMoment: c.nbMouvements,
      nbRapprochesAuMoment: c.nbRapproches,
      invalideLe: null,
      invalideMotif: null,
    },
  });
}

/**
 * "De-validation" (soft, jamais de DELETE) d'un mois precedemment valide -
 * utilisee quand un drift est detecte et que l'utilisateur decide de
 * reconsiderer ce mois plutot que de l'ignorer.
 */
export async function invaliderMoisComptable(prisma: PrismaClient, periode: string, motif?: string) {
  const validation = await prisma.validationMoisComptable.findUnique({ where: { periode } });
  if (!validation || validation.invalideLe !== null) {
    throw new Error("Ce mois n'est pas (ou plus) validé.");
  }
  return prisma.validationMoisComptable.update({
    where: { periode },
    data: { invalideLe: new Date(), invalideMotif: motif ?? null },
  });
}
