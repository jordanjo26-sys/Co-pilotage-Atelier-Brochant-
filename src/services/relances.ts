import { Facture, PrismaClient } from "@prisma/client";
import MailComposer from "nodemailer/lib/mail-composer";
import { getGmailClient } from "./googleAuth";
import { logEvenement } from "./journalService";

/**
 * Moteur de regles pour les relances de factures impayees (section 4.3 du
 * cahier des charges : "delai accorde => suspension des relances"), Phase 5
 * ("moteur de regles / relances").
 *
 * Choix delibere, dans la continuite de l'incident Dext (section 14 :
 * prudence, jamais d'action a impact externe sans validation) : le moteur
 * DETERMINE qui doit etre relance et a quel palier, mais N'ENVOIE RIEN de
 * lui-meme. Chaque envoi reste un geste humain volontaire (un clic sur une
 * facture precise, ou une demande explicite a Morgane) — contacter un
 * client sur un impaye a un impact sur la relation commerciale bien plus
 * sensible qu'un routage interne de document, ce qui justifie un defaut
 * encore plus prudent que DEXT_AUTO_FORWARD.
 */

export interface Palier {
  id: string;
  libelle: string;
  joursRetard: number;
}

// Ordre croissant : le palier atteint est le dernier dont le seuil est
// depasse. Ajuster les seuils ici seul point a modifier pour changer le
// rythme des relances.
export const PALIERS_RELANCE: Palier[] = [
  { id: "rappel", libelle: "Rappel amical", joursRetard: 7 },
  { id: "relance", libelle: "Relance formelle", joursRetard: 15 },
  { id: "mise_en_demeure", libelle: "Mise en demeure", joursRetard: 30 },
];

export interface FactureARelancer {
  factureId: string;
  reference: string;
  clientNom: string;
  clientEmail: string | null;
  montantTTC: number;
  resteAPercevoir: number;
  dateEcheance: string;
  joursRetard: number;
  palier: Palier;
  objet: string;
  corps: string;
}

function joursDepuis(date: Date, reference: Date): number {
  return Math.floor((reference.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
}

/** Le delai accorde (section 4.3) suspend toute relance tant qu'il court. */
function estSuspendue(facture: Facture, maintenant: Date): boolean {
  return Boolean(facture.delaiAccordeJusqua && facture.delaiAccordeJusqua > maintenant);
}

/** Dernier palier dont le seuil de jours de retard est atteint, ou undefined si aucun. */
function palierAtteint(joursRetard: number): Palier | undefined {
  let resultat: Palier | undefined;
  for (const p of PALIERS_RELANCE) {
    if (joursRetard >= p.joursRetard) resultat = p;
  }
  return resultat;
}

function texteRelance(palier: Palier, facture: Facture, resteAPercevoir: number): { objet: string; corps: string } {
  const montant = `${resteAPercevoir.toFixed(2)} EUR`;
  const echeance = facture.dateEcheance ? facture.dateEcheance.toLocaleDateString("fr-FR") : "non precisee";

  if (palier.id === "rappel") {
    return {
      objet: `Rappel - Facture ${facture.reference}`,
      corps:
        `Bonjour,\n\nSauf erreur de notre part, nous n'avons pas encore recu le reglement de la facture ${facture.reference} ` +
        `(${montant}), echue le ${echeance}.\n\nMerci de bien vouloir regulariser prochainement, ou de nous signaler si un reglement est deja en cours.\n\n` +
        `Cordialement,\nAtelier Brochant`,
    };
  }
  if (palier.id === "relance") {
    return {
      objet: `Relance - Facture ${facture.reference} en retard de reglement`,
      corps:
        `Bonjour,\n\nMalgre notre precedent message, la facture ${facture.reference} (${montant}), echue le ${echeance}, ` +
        `demeure impayee a ce jour.\n\nMerci de proceder au reglement dans les meilleurs delais. N'hesitez pas a nous contacter en cas de difficulte.\n\n` +
        `Cordialement,\nAtelier Brochant`,
    };
  }
  return {
    objet: `Mise en demeure - Facture ${facture.reference}`,
    corps:
      `Bonjour,\n\nMalgre nos precedentes relances, la facture ${facture.reference} (${montant}), echue le ${echeance}, ` +
      `reste impayee a ce jour.\n\nNous vous mettons en demeure de proceder au reglement integral sous 8 jours a compter de ce message, ` +
      `a defaut de quoi nous nous reserverons le droit d'engager les demarches necessaires au recouvrement de cette creance.\n\n` +
      `Cordialement,\nAtelier Brochant`,
  };
}

/**
 * Liste les factures impayees ayant atteint un nouveau palier de retard non
 * encore relance, delai accorde (section 4.3) exclu. Une facture n'apparait
 * qu'une fois par palier franchi : une fois le palier "rappel" envoye, elle
 * ne reste pas indefiniment dans la liste tant que "relance" n'est pas
 * atteint a son tour.
 */
export async function listerFacturesARelancer(prisma: PrismaClient, maintenant: Date = new Date()): Promise<FactureARelancer[]> {
  const factures = await prisma.facture.findMany({
    where: {
      statut: { in: ["impayee", "partiellement_payee"] },
      dateEcheance: { not: null, lt: maintenant },
      clotureSynec: false,
    },
    include: { client: true, relances: true },
  });

  const resultat: FactureARelancer[] = [];
  for (const facture of factures) {
    if (estSuspendue(facture, maintenant)) continue;
    const joursRetard = joursDepuis(facture.dateEcheance!, maintenant);
    const palier = palierAtteint(joursRetard);
    if (!palier) continue;

    const dejaEnvoye = facture.relances.some((r) => r.palier === palier.id);
    if (dejaEnvoye) continue;

    const resteAPercevoir = facture.montantTTC - facture.montantRegle;
    const { objet, corps } = texteRelance(palier, facture, resteAPercevoir);

    resultat.push({
      factureId: facture.id,
      reference: facture.reference,
      clientNom: facture.clientNom,
      clientEmail: facture.client?.email || null,
      montantTTC: facture.montantTTC,
      resteAPercevoir,
      dateEcheance: facture.dateEcheance!.toISOString(),
      joursRetard,
      palier,
      objet,
      corps,
    });
  }

  // Les plus en retard (donc les plus urgentes) en premier.
  resultat.sort((a, b) => b.joursRetard - a.joursRetard);
  return resultat;
}

/**
 * Envoie la relance pour une facture precise, au palier actuellement du
 * (recalcule au moment de l'envoi, jamais fourni par l'appelant : evite
 * d'envoyer un palier perime si la situation a change entre l'affichage et
 * le clic). Geste toujours volontaire — jamais declenche automatiquement
 * par le planificateur (voir l'en-tete du fichier).
 */
export async function envoyerRelance(prisma: PrismaClient, factureId: string, maintenant: Date = new Date()): Promise<FactureARelancer> {
  const aRelancer = await listerFacturesARelancer(prisma, maintenant);
  const cible = aRelancer.find((f) => f.factureId === factureId);
  if (!cible) {
    throw new Error("Cette facture n'est plus a relancer (deja reglee, delai accorde, ou palier deja envoye).");
  }
  if (!cible.clientEmail) {
    throw new Error(`Aucune adresse e-mail connue pour le client "${cible.clientNom}" : relance impossible depuis l'application.`);
  }

  const connexionGmail = await getGmailClient(prisma);
  if (!connexionGmail) throw new Error("Aucune boite Gmail connectee.");
  const { gmail } = connexionGmail;

  const composer = new MailComposer({ to: cible.clientEmail, subject: cible.objet, text: cible.corps });
  const message = await composer.compile().build();
  const raw = message.toString("base64url");
  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });

  await prisma.relance.create({
    data: { factureId: cible.factureId, palier: cible.palier.id, destinataire: cible.clientEmail },
  });
  await logEvenement(prisma, {
    evenement: "relance_envoyee",
    action: `Relance "${cible.palier.libelle}" envoyee pour la facture ${cible.reference} a ${cible.clientEmail}`,
    resultat: `${cible.joursRetard} jour(s) de retard, ${cible.resteAPercevoir.toFixed(2)} EUR restant.`,
  });

  return cible;
}
