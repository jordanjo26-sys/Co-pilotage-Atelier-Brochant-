import { PrismaClient } from "@prisma/client";
import { synchroniserGmail, resumerErreurs } from "./gmailSync";
import { envoyerRecapQuotidien } from "./dailyRecap";
import { envoyerAnalyseQuotidienneAds } from "./googleAdsRecap";
import { synchroniserStripe, stripeEstConnecte } from "./stripeSync";
import { synchroniserSynec, synecEstConfigure } from "./synecSync";
import { logEvenement } from "./journalService";
import { detecterReponses, executerEnvoisAutomatiques } from "./prospection/campagnes";
import { recupererMessagesSecours, renvoyerComptesRendusEnAttente } from "./messagerieSecours";
import { verifierMailsImportants } from "./mailsImportants";
import { gmailEnPause, signalerLimiteGmail, reinitialiserLimiteGmail } from "./gmailRateLimit";

const INTERVALLE_PAR_DEFAUT_MS = 5 * 60 * 1000; // 5 minutes
const INTERVALLE_VERIF_RECAP_MS = 5 * 60 * 1000; // 5 minutes
const HEURE_RECAP_PAR_DEFAUT = 19; // 19h, heure locale du serveur
// Matin plutot que soir (contrairement au recapitulatif general) : utile de
// lire les recommandations Google Ads en debut de journee, avant d'eventuellement
// agir dessus avec Morgane dans la journee.
const HEURE_ANALYSE_ADS_PAR_DEFAUT = 8; // 8h, heure locale du serveur
// Les payouts Stripe arrivent typiquement une fois par jour au plus, jamais
// toutes les 5 minutes comme les e-mails : un intervalle plus espace suffit
// largement et menage l'API Stripe.
const INTERVALLE_STRIPE_PAR_DEFAUT_MS = 60 * 60 * 1000; // 1 heure
// Les factures Synec changent au rythme de l'activite de l'atelier, jamais
// en continu : un intervalle large suffit et evite de solliciter un
// navigateur headless complet trop souvent (bien plus couteux qu'un simple
// appel API comme Stripe ou Gmail).
const INTERVALLE_SYNEC_PAR_DEFAUT_MS = 3 * 60 * 60 * 1000; // 3 heures
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
  // Garde-fou contre le chevauchement (bug racine du "jeton qui saute" en
  // production, octobre 2026) : setInterval ne sait pas qu'un callback
  // async est deja en cours. Si une synchronisation prend plus longtemps
  // que l'intervalle (gros volume de pieces jointes), le tic suivant en
  // demarrait une deuxieme en parallele, chacune consommant le quota
  // Gmail par utilisateur en meme temps - un "User-rate limit exceeded"
  // qui ne se resorbait jamais puisque chaque nouveau tic ajoutait encore
  // une synchronisation en plus, au lieu d'attendre que la precedente
  // libere le quota.
  let synchronisationEnCours = false;

  setInterval(async () => {
    if (synchronisationEnCours) return;
    // Pause partagee (voir gmailRateLimit.ts) : respecte aussi bien
    // l'indication "Retry after" de Google que le fait qu'un AUTRE
    // appelant (un autre planificateur, ou GET /api/gmail/status
    // interroge par le tableau de bord) ait deja constate le blocage.
    if (gmailEnPause()) return;
    synchronisationEnCours = true;
    try {
      const connexion = await prisma.gmailConnexion.findFirst({ where: { actif: true } });
      if (!connexion) return; // rien a synchroniser tant que Gmail n'est pas connecte

      const resultat = await synchroniserGmail(prisma);
      reinitialiserLimiteGmail();
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
      const messageErreur = (err as Error).message;
      // eslint-disable-next-line no-console
      console.error("Synchronisation Gmail planifiee en echec :", messageErreur);
      const dateReprise = signalerLimiteGmail(messageErreur);
      // Journalise aussi en base (pas seulement la console du serveur,
      // inaccessible sans acces SSH) : une panne silencieuse et repetee de
      // ce planificateur (ex. jeton Google expire) est passee inapercue en
      // production faute de trace visible depuis l'application elle-meme.
      await logEvenement(prisma, {
        evenement: "gmail_sync_planifiee_erreur",
        action: "Synchronisation automatique Gmail",
        resultat: `Echec : ${messageErreur} (nouvelle tentative apres ${dateReprise.toISOString()})`,
      }).catch(() => {});
    } finally {
      synchronisationEnCours = false;
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

  // Pause partagee (voir gmailRateLimit.ts) : ce planificateur envoie lui
  // aussi via Gmail (envoyerRecapQuotidien -> gmail.users.messages.send),
  // partage donc le meme quota que tout autre appelant Gmail du process -
  // y compris GET /api/gmail/status interroge en continu par le tableau
  // de bord.
  setInterval(async () => {
    try {
      const maintenant = new Date();
      if (maintenant.getHours() !== heure) return;
      if (gmailEnPause()) return;

      const debutJour = new Date(maintenant);
      debutJour.setHours(0, 0, 0, 0);
      const dejaEnvoyeAujourdhui = await prisma.journalEvenement.findFirst({
        where: { evenement: "recap_quotidien_envoye", horodatage: { gte: debutJour } },
      });
      if (dejaEnvoyeAujourdhui) return;

      await envoyerRecapQuotidien(prisma, maintenant);
      reinitialiserLimiteGmail();
    } catch (err) {
      const messageErreur = (err as Error).message;
      // eslint-disable-next-line no-console
      console.error("Envoi du recapitulatif quotidien en echec :", messageErreur);
      const dateReprise = signalerLimiteGmail(messageErreur);
      await logEvenement(prisma, {
        evenement: "recap_quotidien_erreur",
        action: "Envoi du recapitulatif quotidien",
        resultat: `Echec : ${messageErreur} (nouvelle tentative apres ${dateReprise.toISOString()})`,
      }).catch(() => {});
    }
  }, INTERVALLE_VERIF_RECAP_MS);
}

/**
 * Envoie l'analyse quotidienne des campagnes Google Ads (recommandations :
 * mots-cles a exclure/ajouter, points d'amelioration) une fois par jour, a
 * l'heure configuree via ANALYSE_ADS_HOUR (8h par defaut). Meme principe
 * d'idempotence que demarrerRecapQuotidien (verification periodique +
 * journal d'evenements, pas d'etat supplementaire).
 */
export function demarrerAnalyseQuotidienneAds(prisma: PrismaClient): void {
  const heureCible = Number(process.env.ANALYSE_ADS_HOUR);
  const heure = Number.isInteger(heureCible) && heureCible >= 0 && heureCible <= 23 ? heureCible : HEURE_ANALYSE_ADS_PAR_DEFAUT;

  // Pause partagee (voir gmailRateLimit.ts) : ce planificateur verifie
  // toutes les 5 minutes pendant toute l'heure cible (jusqu'a 12
  // tentatives) et partage le meme quota Gmail par utilisateur que tout
  // autre appelant Gmail du process (envoyerAnalyseQuotidienneAds envoie
  // via gmail.users.messages.send).
  setInterval(async () => {
    try {
      const maintenant = new Date();
      if (maintenant.getHours() !== heure) return;
      if (gmailEnPause()) return;

      const debutJour = new Date(maintenant);
      debutJour.setHours(0, 0, 0, 0);
      const dejaEnvoyeeAujourdhui = await prisma.journalEvenement.findFirst({
        where: { evenement: "analyse_ads_envoyee", horodatage: { gte: debutJour } },
      });
      if (dejaEnvoyeeAujourdhui) return;

      await envoyerAnalyseQuotidienneAds(prisma, maintenant);
      reinitialiserLimiteGmail();
    } catch (err) {
      const messageErreur = (err as Error).message;
      // eslint-disable-next-line no-console
      console.error("Analyse quotidienne Google Ads en echec :", messageErreur);
      const dateReprise = signalerLimiteGmail(messageErreur);
      await logEvenement(prisma, {
        evenement: "analyse_ads_erreur",
        action: "Analyse quotidienne Google Ads",
        resultat: `Echec : ${messageErreur} (nouvelle tentative apres ${dateReprise.toISOString()})`,
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
 * Synchronise automatiquement les factures Synec (remplace le depot manuel
 * d'export CSV une fois SYNEC_URL/SYNEC_IDENTIFIANT/SYNEC_MOT_DE_PASSE
 * configures). synchroniserSynec journalise deja elle-meme le detail de
 * l'echec (etape precise : connexion, navigation, export...) - ce
 * planificateur se contente de ne jamais laisser une erreur interrompre le
 * serveur, meme principe que les autres planificateurs.
 */
export function demarrerSurveillanceSynec(prisma: PrismaClient): void {
  if (!synecEstConfigure()) return; // rien a synchroniser sans identifiants

  const intervalle = Number(process.env.SYNEC_POLL_INTERVAL_MS) || INTERVALLE_SYNEC_PAR_DEFAUT_MS;

  setInterval(async () => {
    try {
      await synchroniserSynec(prisma);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Synchronisation Synec planifiee en echec :", (err as Error).message);
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
  // Pause partagee (voir gmailRateLimit.ts) : lit les fils Gmail
  // (getGmailClient + gmail.users.threads.get), partage donc le meme
  // quota que tout autre appelant Gmail du process.
  setInterval(async () => {
    if (gmailEnPause()) return;
    try {
      await detecterReponses(prisma);
      reinitialiserLimiteGmail();
    } catch (err) {
      const messageErreur = (err as Error).message;
      // eslint-disable-next-line no-console
      console.error("Detection des reponses de prospection en echec :", messageErreur);
      const dateReprise = signalerLimiteGmail(messageErreur);
      await logEvenement(prisma, {
        evenement: "prospection_reponses_erreur",
        action: "Detection automatique des reponses",
        resultat: `Echec : ${messageErreur} (nouvelle tentative apres ${dateReprise.toISOString()})`,
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
  // Pause partagee (voir gmailRateLimit.ts) : envoie via
  // gmail.users.messages.send, partage donc le meme quota.
  setInterval(async () => {
    if (gmailEnPause()) return;
    try {
      await executerEnvoisAutomatiques(prisma);
      reinitialiserLimiteGmail();
    } catch (err) {
      const messageErreur = (err as Error).message;
      // eslint-disable-next-line no-console
      console.error("Envoi automatique de campagnes en echec :", messageErreur);
      const dateReprise = signalerLimiteGmail(messageErreur);
      await logEvenement(prisma, {
        evenement: "campagne_envoi_auto_erreur",
        action: "Envoi automatique de campagnes de prospection",
        resultat: `Echec : ${messageErreur} (nouvelle tentative apres ${dateReprise.toISOString()})`,
      }).catch(() => {});
    }
  }, INTERVALLE_ENVOI_AUTO_PROSPECTION_MS);
}

/**
 * Toutes les 5 minutes : recupere les messages vocaux laisses sur la
 * messagerie de secours Twilio (hebergee chez Twilio, utilisee si le
 * serveur ne repondait pas) et les envoie par e-mail. Voir
 * src/services/messagerieSecours.ts.
 */
export function demarrerRecuperationMessagesSecours(prisma: PrismaClient): void {
  // Meme garde-fou anti-chevauchement que demarrerSurveillanceGmail : ces
  // deux fonctions envoient des e-mails via l'API Gmail (meme quota par
  // utilisateur), donc un chevauchement ici aggrave aussi un "User-rate
  // limit exceeded" en cours.
  let enCours = false;
  // + la pause partagee (voir gmailRateLimit.ts) : renvoyerComptesRendusEnAttente
  // envoie via gmail.users.messages.send.
  setInterval(async () => {
    if (enCours) return;
    if (gmailEnPause()) return;
    enCours = true;
    try {
      await recupererMessagesSecours(prisma).catch((err) => {
        console.error("Recuperation des messages de secours en echec :", (err as Error).message);
      });
      await renvoyerComptesRendusEnAttente(prisma).catch((err) => {
        const messageErreur = (err as Error).message;
        console.error("Renvoi des comptes rendus d'appel en echec :", messageErreur);
        signalerLimiteGmail(messageErreur);
      });
    } finally {
      enCours = false;
    }
  }, 5 * 60 * 1000);
}

/**
 * Toutes les heures : repere parmi les mails recus ceux qui ressemblent a
 * une demande d'intervention ou une urgence client (voir
 * src/services/mailsImportants.ts) et envoie un recapitulatif par e-mail
 * uniquement si au moins un a ete trouve.
 */
export function demarrerRecapMailsImportants(prisma: PrismaClient): void {
  let enCours = false;
  // + la pause partagee (voir gmailRateLimit.ts) : verifierMailsImportants
  // lit et envoie via l'API Gmail.
  setInterval(async () => {
    if (enCours) return;
    if (gmailEnPause()) return;
    enCours = true;
    try {
      await verifierMailsImportants(prisma).catch((err) => {
        const messageErreur = (err as Error).message;
        console.error("Verification des mails importants en echec :", messageErreur);
        signalerLimiteGmail(messageErreur);
      });
    } finally {
      enCours = false;
    }
  }, 60 * 60 * 1000);
}
