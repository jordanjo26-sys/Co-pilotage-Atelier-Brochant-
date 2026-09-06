import { PrismaClient } from "@prisma/client";
import { synchroniserGmail } from "./gmailSync";
import { envoyerRecapQuotidien } from "./dailyRecap";
import { synchroniserStripe, stripeEstConnecte } from "./stripeSync";
import { logEvenement } from "./journalService";

const INTERVALLE_PAR_DEFAUT_MS = 5 * 60 * 1000; // 5 minutes
const INTERVALLE_VERIF_RECAP_MS = 5 * 60 * 1000; // 5 minutes
const HEURE_RECAP_PAR_DEFAUT = 19; // 19h, heure locale du serveur
// Les payouts Stripe arrivent typiquement une fois par jour au plus, jamais
// toutes les 5 minutes comme les e-mails : un intervalle plus espace suffit
// largement et menage l'API Stripe.
const INTERVALLE_STRIPE_PAR_DEFAUT_MS = 60 * 60 * 1000; // 1 heure

/**
 * Demarre la surveillance continue de la boite Gmail connectee (section 3 :
 * "Surveillance continue et traitement evenementiel"). Volontairement un
 * setInterval en processus plutot qu'un cron systeme externe : suffisant
 * pour la charge d'un artisan/TPE et plus simple a exploiter sur un petit
 * serveur (rien a configurer en dehors de l'application elle-meme).
 *
 * Ne fait rien tant qu'aucune boite Gmail n'est connectee ; n'interrompt
 * jamais le serveur en cas d'erreur (reseau, jeton expire...), seulement
 * journalisee pour investigation.
 */
export function demarrerSurveillanceGmail(prisma: PrismaClient): void {
  const intervalle = Number(process.env.GMAIL_POLL_INTERVAL_MS) || INTERVALLE_PAR_DEFAUT_MS;

  setInterval(async () => {
    try {
      const connexion = await prisma.gmailConnexion.findFirst({ where: { actif: true } });
      if (!connexion) return; // rien a synchroniser tant que Gmail n'est pas connecte

      const resultat = await synchroniserGmail(prisma);
      if (resultat.documentsTraites > 0 || resultat.documentsAmbigus > 0 || resultat.erreurs.length > 0) {
        await logEvenement(prisma, {
          evenement: "gmail_sync_planifiee",
          action: `Synchronisation automatique (${resultat.messagesExamines} message(s) examine(s))`,
          resultat: `${resultat.documentsTraites} traite(s), ${resultat.documentsDoublons} doublon(s), ${resultat.documentsAmbigus} ambigu(s), ${resultat.erreurs.length} erreur(s).`,
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Synchronisation Gmail planifiee en echec :", (err as Error).message);
    }
  }, intervalle);
}

/**
 * Envoie le recapitulatif quotidien une fois par jour, a l'heure locale du
 * serveur configuree via DAILY_RECAP_HOUR (19h par defaut). Verification
 * periodique (toutes les 5 minutes) plutot qu'un cron systeme externe,
 * pour rester coherent avec `demarrerSurveillanceGmail` : rien a
 * configurer en dehors de l'application. L'idempotence (un seul envoi par
 * jour meme si le serveur redemarre plusieurs fois dans l'heure cible)
 * s'appuie sur le journal d'evenements existant, sans etat supplementaire
 * a maintenir.
 */
export function demarrerRecapQuotidien(prisma: PrismaClient): void {
  const heureCible = Number(process.env.DAILY_RECAP_HOUR);
  const heure = Number.isInteger(heureCible) && heureCible >= 0 && heureCible <= 23 ? heureCible : HEURE_RECAP_PAR_DEFAUT;

  setInterval(async () => {
    try {
      const maintenant = new Date();
      if (maintenant.getHours() !== heure) return;

      const debutJour = new Date(maintenant);
      debutJour.setHours(0, 0, 0, 0);
      const dejaEnvoyeAujourdhui = await prisma.journalEvenement.findFirst({
        where: { evenement: "recap_quotidien_envoye", horodatage: { gte: debutJour } },
      });
      if (dejaEnvoyeAujourdhui) return;

      await envoyerRecapQuotidien(prisma, maintenant);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Envoi du recapitulatif quotidien en echec :", (err as Error).message);
    }
  }, INTERVALLE_VERIF_RECAP_MS);
}

/**
 * Synchronise automatiquement les payouts/paiements Stripe (remplace le
 * depot manuel d'exports CSV une fois STRIPE_API_KEY configuree). Meme
 * principe de tolerance aux pannes que `demarrerSurveillanceGmail` :
 * n'interrompt jamais le serveur, journalise seulement en cas d'erreur.
 */
export function demarrerSurveillanceStripe(prisma: PrismaClient): void {
  if (!stripeEstConnecte()) return; // rien a synchroniser sans cle API

  const intervalle = Number(process.env.STRIPE_POLL_INTERVAL_MS) || INTERVALLE_STRIPE_PAR_DEFAUT_MS;

  setInterval(async () => {
    try {
      await synchroniserStripe(prisma);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Synchronisation Stripe planifiee en echec :", (err as Error).message);
    }
  }, intervalle);
}
