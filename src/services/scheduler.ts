import { PrismaClient } from "@prisma/client";
import { synchroniserGmail, resumerErreurs } from "./gmailSync";
import { envoyerRecapQuotidien } from "./dailyRecap";
import { synchroniserStripe, stripeEstConnecte } from "./stripeSync";
import { logEvenement } from "./journalService";
import { detecterReponses, executerEnvoisAutomatiques } from "./prospection/campagnes";

const INTERVALLE_PAR_DEFAUT_MS = 5 * 60 * 1000; // 5 minutes
const INTERVALLE_VERIF_RECAP_MS = 5 * 60 * 1000; // 5 minutes
const HEURE_RECAP_PAR_DEFAUT = 19; // 19h, heure locale du serveur
// Les payouts Stripe arrivent typiquement une fois par jour au plus, jamais
// toutes les 5 minutes comme les e-mails : un intervalle plus espace suffit
// largement et menage l'API Stripe.
const INTERVALLE_STRIPE_PAR_DEFAUT_MS = 60 * 60 * 1000; // 1 heure
// Detection de reponse aux campagnes de prospection (section 2.5) : lecture
// seule des fils Gmail, aucun envoi -> peut tourner automatiquement sans
// enfreindre le principe de prudence applique aux envois eux-memes.
const INTERVALLE_REPONSES_PROSPECTION_MS = 15 * 60 * 1000; // 15 minutes
// Envoi automatique des campagnes marquees "automatique" (section 2.4,
// demande explicite de l'exploitant) : un intervalle espace suffit, le
// quota quotidien etant de toute facon partage avec les envois manuels.
const INTERVALLE_ENVOI_AUTO_PROSPECTION_MS = Number(process.env.PROSPECTION_ENVOI_AUTO_INTERVAL_MS) || 60 * 60 * 1000; // 1 heure

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
        // Le detail des erreurs (pas seulement leur nombre) est inclus ici :
        // sans cela, une erreur repetee sur une piece jointe precise (PDF
        // corrompu, message inaccessible...) restait invisible dans le
        // Journal au-dela d'un simple compteur, sans indice pour la
        // diagnostiquer depuis l'application.
        await logEvenement(prisma, {
          evenement: "gmail_sync_planifiee",
          action: `Synchronisation automatique (${resultat.messagesExamines} message(s) examine(s))`,
          resultat:
            `${resultat.documentsTraites} traite(s), ${resultat.documentsDoublons} doublon(s), ${resultat.documentsAmbigus} ambigu(s), ${resultat.erreurs.length} erreur(s).` +
            (resultat.erreurs.length > 0 ? ` Details : ${resumerErreurs(resultat.erreurs)}` : ""),
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Synchronisation Gmail planifiee en echec :", (err as Error).message);
      // Journalise aussi en base (pas seulement la console du serveur,
      // inaccessible sans acces SSH) : une panne silencieuse et repetee de
      // ce planificateur (ex. jeton Google expire) est passee inapercue en
      // production faute de trace visible depuis l'application elle-meme.
      await logEvenement(prisma, {
        evenement: "gmail_sync_planifiee_erreur",
        action: "Synchronisation automatique Gmail",
        resultat: `Echec : ${(err as Error).message}`,
      }).catch(() => {});
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
      await logEvenement(prisma, {
        evenement: "recap_quotidien_erreur",
        action: "Envoi du recapitulatif quotidien",
        resultat: `Echec : ${(err as Error).message}`,
      }).catch(() => {});
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
      await logEvenement(prisma, {
        evenement: "stripe_sync_planifiee_erreur",
        action: "Synchronisation automatique Stripe",
        resultat: `Echec : ${(err as Error).message}`,
      }).catch(() => {});
    }
  }, intervalle);
}

/**
 * Detecte automatiquement les reponses aux campagnes de prospection en
 * cours (section 2.5), pour tenir le statut de chaque envoi a jour sans
 * action manuelle. N'envoie jamais rien elle-meme (voir campagnes.ts) : se
 * contente de lire les fils Gmail concernes.
 */
export function demarrerDetectionReponsesProspection(prisma: PrismaClient): void {
  setInterval(async () => {
    try {
      await detecterReponses(prisma);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Detection des reponses de prospection en echec :", (err as Error).message);
      await logEvenement(prisma, {
        evenement: "prospection_reponses_erreur",
        action: "Detection automatique des reponses",
        resultat: `Echec : ${(err as Error).message}`,
      }).catch(() => {});
    }
  }, INTERVALLE_REPONSES_PROSPECTION_MS);
}

/**
 * Envoie automatiquement les campagnes de prospection marquees
 * "automatique" (section 2.4) : premiers envois puis relances dues, dans
 * la limite du quota quotidien partage avec les envois manuels. Voir
 * l'en-tete de src/services/prospection/campagnes.ts pour le contexte de
 * cette derogation, explicitement demandee, au principe de prudence
 * applique par ailleurs (relances de factures notamment).
 */
export function demarrerEnvoiAutomatiqueCampagnes(prisma: PrismaClient): void {
  setInterval(async () => {
    try {
      await executerEnvoisAutomatiques(prisma);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Envoi automatique de campagnes en echec :", (err as Error).message);
      await logEvenement(prisma, {
        evenement: "campagne_envoi_auto_erreur",
        action: "Envoi automatique de campagnes de prospection",
        resultat: `Echec : ${(err as Error).message}`,
      }).catch(() => {});
    }
  }, INTERVALLE_ENVOI_AUTO_PROSPECTION_MS);
}
