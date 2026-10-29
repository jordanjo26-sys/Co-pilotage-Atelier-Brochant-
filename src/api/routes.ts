import { Router, Request } from "express";
import multer from "multer";
import { PrismaClient } from "@prisma/client";
import { receiveCsv } from "../services/importService";
import { getDashboardSummary, getCaSerieTemporelle, GranulariteCa } from "../services/dashboardService";
import {
  synchroniserGmail,
  resumerErreurs,
  envoyerDocumentFournisseurVersDext,
  DocumentFournisseurEnvoiError,
  classerAnomalieCommeFacture,
  AnomalieClassificationError,
} from "../services/gmailSync";
import { envoyerRecapQuotidien, construireRecapQuotidien } from "../services/dailyRecap";
import { envoyerBilanSante, construireBilanSante } from "../services/bilanSante";
import { repondreMorgane, MessageMorgane, PieceJointeMorgane, MIME_PIECES_JOINTES_AUTORISEES } from "../services/morgane";
import { listerFacturesARelancer, envoyerRelance } from "../services/relances";
import { listerFournisseurs, obtenirFournisseur, supprimerFournisseur, FournisseurAvecFacturesError } from "../services/fournisseurs";
import { enregistrerDocumentScanne, DocumentScanneError } from "../services/documentsScannes";
import { cheminDocumentGenere, nomFichierGenereValide } from "../services/documentsGeneres";
import { listerDecisions, terminerDecision } from "../services/decisions";
import { executerRapprochementBancaire } from "../services/rapprochementBancaire";
import { synchroniserStripe, stripeEstConnecte, derniereSynchroStripe, verifierConnexionStripe } from "../services/stripeSync";
import { synchroniserSynec, synecEstConfigure, derniereSynchroSynec, verifierConnexionSynec, CHEMIN_CAPTURE_ECHEC } from "../services/synecSync";
import { existsSync } from "fs";
import fs from "node:fs/promises";
import { getGmailClient } from "../services/googleAuth";
import { gmailEnPause, signalerLimiteGmail, reinitialiserLimiteGmail } from "../services/gmailRateLimit";
import { typeMimePourAffichage } from "../services/fileType";
import { genererPdfFacturesImpayees } from "../services/facturesPdf";
import { genererPdfPaiements } from "../services/paiementsPdf";
import {
  creerDemandeIntervention,
  listerDemandesIntervention,
  marquerDemandeInterventionSaisie,
  modifierDemandeIntervention,
  DemandeInterventionValidationError,
} from "../services/demandesIntervention";
import { envoyerDemandeVersSynec, SynecEcritureError } from "../services/synecEcriture";
import { importerCampagnesAds, dernieresCampagnesImportees } from "../services/googleAdsImport";
import { listerPropositionsAds, accepterPropositionAds, refuserPropositionAds, creerPropositionAds } from "../services/googleAdsActions";
import {
  listerCampagnesAds,
  verifierPolitiqueAnnonces,
  verifierPolitiqueAssets,
  listerActionsConversion,
  diagnosticConfigurationAds,
  diagnosticScopesJeton,
  diagnosticLienGestionnaire,
  listerObjectifsConversionCampagne,
} from "../services/googleAds";
import { diagnostiquerRejetsDext, listerRejetsDext } from "../services/dextDiagnostic";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

export function buildRouter(prisma: PrismaClient): Router {
  const router = Router();

  // --- Reception des CSV ------------------------------------------------

  router.post("/import", upload.single("fichier"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ erreur: "Aucun fichier recu (champ attendu : 'fichier')." });
    }
    try {
      const summary = await receiveCsv(prisma, req.file.originalname, req.file.buffer);
      res.status(200).json(summary);
    } catch (err) {
      res.status(500).json({ erreur: (err as Error).message });
    }
  });

  router.get("/imports", async (_req, res) => {
    const imports = await prisma.importBatch.findMany({ orderBy: { dateImport: "desc" }, take: 100 });
    res.json(imports);
  });

  // --- Consultation des donnees normalisees ------------------------------

  router.get("/clients", async (_req, res) => {
    const clients = await prisma.client.findMany({ orderBy: { nom: "asc" }, take: 1000 });
    res.json(clients);
  });

  router.get("/factures", async (req, res) => {
    const statut = typeof req.query.statut === "string" ? req.query.statut : undefined;
    const factures = await prisma.facture.findMany({
      where: statut ? { statut } : undefined,
      orderBy: { dateEcheance: "asc" },
      take: 500,
    });
    res.json(factures);
  });

  // Export PDF des factures impayees (demande explicite de l'utilisateur,
  // apres avoir constate que Morgane ne peut pas generer de document - son
  // jeu d'outils est volontairement limite a des actions/requetes precises).
  // Par defaut "impayee" seule (pas "partiellement_payee" ni "cloturee") :
  // c'est la demande initiale ("toutes les factures impayees"), le parametre
  // reste ajustable si besoin plus tard sans changer la route.
  router.get("/factures/export-pdf", async (req, res) => {
    const statut = typeof req.query.statut === "string" ? req.query.statut : "impayee";
    const factures = await prisma.facture.findMany({
      where: { statut },
      orderBy: { dateEcheance: "asc" },
      take: 500,
    });
    const pdf = await genererPdfFacturesImpayees(factures);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="factures-impayees-${new Date().toISOString().slice(0, 10)}.pdf"`);
    res.send(pdf);
  });

  router.get("/paiements", async (_req, res) => {
    const paiements = await prisma.paiement.findMany({ orderBy: { date: "desc" }, take: 500 });
    res.json(paiements);
  });

  router.get("/payouts", async (_req, res) => {
    const payouts = await prisma.payout.findMany({ orderBy: { date: "desc" }, take: 500 });
    res.json(payouts);
  });

  // Ventilation d'un payout : quelles factures / paiements le composent.
  router.get("/payouts/:payoutRef/ventilation", async (req, res) => {
    const { payoutRef } = req.params;
    const payout = await prisma.payout.findUnique({ where: { payoutRef } });
    if (!payout) return res.status(404).json({ erreur: "Payout introuvable." });

    const paiements = await prisma.paiement.findMany({ where: { payoutRef } });
    const brutTotal = paiements.reduce((s, p) => s + p.brut, 0);
    const fraisTotal = paiements.reduce((s, p) => s + p.frais, 0);
    const mouvementBancaire = payout.mouvementBancaireId
      ? await prisma.mouvementBancaire.findUnique({ where: { id: payout.mouvementBancaireId } })
      : null;

    res.json({ payout, paiements, brutTotal, fraisTotal, netTotal: brutTotal - fraisTotal, mouvementBancaire });
  });

  // Relance manuelle du rapprochement (section 5) : utile apres correction
  // d'une donnee (ex. date de payout ajustee) sans avoir a redeposer un
  // fichier pour redeclencher le calcul.
  router.post("/rapprochement-bancaire/executer", async (_req, res) => {
    res.json(await executerRapprochementBancaire(prisma));
  });

  // --- Stripe : synchronisation directe par API (remplace l'import CSV) ---

  router.get("/stripe/status", async (_req, res) => {
    const verification = await verifierConnexionStripe();
    res.json(
      verification.ok
        ? { connecte: true, derniereSynchro: await derniereSynchroStripe(prisma) }
        : { connecte: false, motif: verification.motif }
    );
  });

  // Corps optionnel {"depuis": "AAAA-MM-JJ"} : synchronisation historique
  // ponctuelle au-dela de la fenetre glissante habituelle de 30 jours
  // (voir synchroniserStripe) - trouve en diagnostiquant un export
  // incomplet signale par l'utilisateur, la base ne contenant aucun
  // paiement avant la date de premiere connexion de l'API Stripe.
  router.post("/stripe/sync", async (req, res) => {
    try {
      const brutDepuis = typeof req.body?.depuis === "string" ? req.body.depuis : "";
      const depuisDate = brutDepuis ? new Date(`${brutDepuis}T00:00:00`) : null;
      if (brutDepuis && (!depuisDate || Number.isNaN(depuisDate.getTime()))) {
        return res.status(400).json({ erreur: `Date "depuis" invalide : "${brutDepuis}".` });
      }
      const depuisUnix = depuisDate ? Math.floor(depuisDate.getTime() / 1000) : undefined;
      res.json(await synchroniserStripe(prisma, depuisUnix));
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  // Detail des paiements/payouts effectivement captes par la synchronisation
  // (par API ou par depot CSV, les deux alimentant les memes tables) :
  // jusqu'ici seuls des compteurs agreges etaient visibles au moment d'un
  // clic sur "Synchroniser maintenant", sans aucune liste consultable
  // ensuite - impossible de verifier si un paiement precis a bien ete recu
  // ou non (signale par l'utilisateur en production). Rappel important :
  // ces tables alimentent le rapprochement bancaire (Payout <-> releve),
  // jamais directement le statut payee/impayee d'une Facture client - celui-ci
  // vient exclusivement du champ reglements de l'export Synec (section 4.4).
  // Periode optionnelle (?depuis=AAAA-MM-JJ&jusqua=AAAA-MM-JJ) : demande
  // explicite de l'utilisateur, qui n'avait jusqu'ici aucun moyen de
  // filtrer/exporter les paiements captes sur une plage de dates precise
  // (ex. "du 1er janvier au 30 octobre 2026"). jusqua est inclusif
  // (23:59:59) pour couvrir toute la journee choisie, pas seulement minuit.
  function periodePaiementsDepuisRequete(req: Request): { depuis?: Date; jusqua?: Date } {
    const brutDepuis = typeof req.query.depuis === "string" ? req.query.depuis : "";
    const brutJusqua = typeof req.query.jusqua === "string" ? req.query.jusqua : "";
    const depuis = brutDepuis ? new Date(`${brutDepuis}T00:00:00`) : undefined;
    const jusqua = brutJusqua ? new Date(`${brutJusqua}T23:59:59.999`) : undefined;
    return {
      depuis: depuis && !Number.isNaN(depuis.getTime()) ? depuis : undefined,
      jusqua: jusqua && !Number.isNaN(jusqua.getTime()) ? jusqua : undefined,
    };
  }

  router.get("/stripe/paiements", async (req, res) => {
    const { depuis, jusqua } = periodePaiementsDepuisRequete(req);
    const filtrePeriode = depuis || jusqua ? { date: { ...(depuis ? { gte: depuis } : {}), ...(jusqua ? { lte: jusqua } : {}) } } : {};
    const paiements = await prisma.paiement.findMany({
      where: filtrePeriode,
      orderBy: { date: "desc" },
      // Sans periode : apercu rapide des plus recents (comportement
      // d'origine). Avec periode : l'utilisateur veut TOUT ce qui est
      // dans la plage choisie, pas seulement les 100 plus recents.
      take: depuis || jusqua ? 5000 : 100,
      include: { facture: { select: { reference: true, clientNom: true } } },
    });
    res.json(paiements);
  });

  // Export PDF des paiements captés (demande explicite de l'utilisateur,
  // même logique que l'export PDF des factures impayées), avec la même
  // période optionnelle que /stripe/paiements ci-dessus.
  router.get("/stripe/paiements/export-pdf", async (req, res) => {
    const { depuis, jusqua } = periodePaiementsDepuisRequete(req);
    const filtrePeriode = depuis || jusqua ? { date: { ...(depuis ? { gte: depuis } : {}), ...(jusqua ? { lte: jusqua } : {}) } } : {};
    const paiements = await prisma.paiement.findMany({
      where: filtrePeriode,
      orderBy: { date: "asc" },
      take: 5000,
      include: { facture: { select: { reference: true, clientNom: true } } },
    });
    const pdf = await genererPdfPaiements(paiements, { depuis, jusqua });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="paiements-${new Date().toISOString().slice(0, 10)}.pdf"`);
    res.send(pdf);
  });

  // Diagnostic ponctuel (demande explicite de l'utilisateur, plusieurs
  // notifications Dext "Telechargement de documents rejete" recues en
  // vidant le backlog de factures en attente) : lit les notifications de
  // rejet directement dans Gmail et croise chaque document cite avec notre
  // base, pour distinguer un vrai doublon de notre cote d'un document deja
  // present sur Dext par un autre canal. Lecture seule.
  router.get("/dext/rejets", async (req, res) => {
    try {
      const jours = req.query.jours ? Number(req.query.jours) : undefined;
      const q = typeof req.query.q === "string" ? req.query.q : undefined;
      // ?brut=true : tous les e-mails Dext trouves (sujet inclus), sans le
      // filtre "rejet" - utile pour diagnostiquer la bonne requete Gmail
      // avant de se fier au filtrage normal.
      if (req.query.brut === "true") {
        return res.json(await listerRejetsDext(prisma, jours, q));
      }
      res.json(await diagnostiquerRejetsDext(prisma, jours, q));
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  // --- Synec : recuperation automatique des factures (aucune API chez
  // Synec - automatisation par navigateur headless, voir synecSync.ts) ---

  router.get("/synec/status", async (_req, res) => {
    if (!synecEstConfigure()) return res.json({ connecte: false });
    const verification = await verifierConnexionSynec(prisma);
    res.json(
      verification.ok
        ? { connecte: true, derniereSynchro: await derniereSynchroSynec(prisma) }
        : { connecte: false, motif: verification.motif }
    );
  });

  router.post("/synec/sync", async (_req, res) => {
    try {
      res.json(await synchroniserSynec(prisma));
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  // Capture d'ecran du dernier echec de synchroniserSynec (voir
  // synecSync.ts) : un diagnostic textuel seul (URL/titre/texte visible)
  // a montre ses limites apres plusieurs essais infructueux a deviner la
  // structure HTML reelle de Synec sans jamais la voir. Protegee par la
  // meme authentification globale (HTTP Basic Auth nginx) que le reste du
  // site, pas d'authentification applicative supplementaire necessaire.
  router.get("/synec/capture-echec", (_req, res) => {
    if (!existsSync(CHEMIN_CAPTURE_ECHEC)) {
      return res.status(404).send("Aucune capture d'echec disponible pour le moment.");
    }
    res.sendFile(CHEMIN_CAPTURE_ECHEC);
  });

  router.get("/recapitulatifs-solde", async (_req, res) => {
    const recap = await prisma.recapitulatifSolde.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    res.json(recap);
  });

  router.get("/mouvements-bancaires", async (_req, res) => {
    const mouvements = await prisma.mouvementBancaire.findMany({ orderBy: { date: "desc" }, take: 500 });
    res.json(mouvements);
  });

  router.get("/journal", async (_req, res) => {
    const journal = await prisma.journalEvenement.findMany({ orderBy: { horodatage: "desc" }, take: 200 });
    res.json(journal);
  });

  router.get("/dashboard/summary", async (_req, res) => {
    res.json(await getDashboardSummary(prisma));
  });

  // Serie temporelle du CA pour le graphique du tableau de bord (demande
  // explicite : "pouvoir regarder mon chiffre d'affaires par jour ou par
  // mois ou par annee").
  const GRANULARITES_CA_VALIDES: GranulariteCa[] = ["jour", "mois", "annee"];
  router.get("/dashboard/ca-serie", async (req, res) => {
    const granularite = req.query.granularite;
    if (typeof granularite !== "string" || !GRANULARITES_CA_VALIDES.includes(granularite as GranulariteCa)) {
      return res.status(400).json({ erreur: `granularite invalide, attendu l'un de : ${GRANULARITES_CA_VALIDES.join(", ")}` });
    }
    res.json(await getCaSerieTemporelle(prisma, granularite as GranulariteCa));
  });

  // --- Gmail -> Dext (section 7) ------------------------------------------

  // Verifie reellement la validite du jeton (pas seulement la presence
  // d'une ligne "active" en base) : sans cela, le statut affichait
  // "Connecté" indefiniment meme apres expiration du jeton Google (motif
  // reel d'une panne silencieuse constatee en production - voir le
  // commentaire de getGmailClient/buildOAuthClient et la section 3 de
  // docs/mise-en-service.md : tant que l'ecran de consentement OAuth reste
  // en statut "Testing" cote Google Cloud, le refresh_token expire au bout
  // de 7 jours quelle que soit l'activite, sans e-mail d'alerte de Google).
  // Un appel Gmail minimal (getProfile) suffit a distinguer un jeton mort
  // d'une vraie connexion active.
  router.get("/gmail/status", async (_req, res) => {
    const connexion = await prisma.gmailConnexion.findFirst({ where: { actif: true } });
    if (!connexion) return res.json({ connecte: false });

    // Cause reelle (trouvee en production, octobre 2026) d'un blocage de
    // quota Gmail qui a persiste plusieurs heures malgre tous les
    // planificateurs backend corriges pour respecter le "Retry after" de
    // Google : cette route fait un appel Gmail reel (getProfile) a CHAQUE
    // requete, et le tableau de bord l'interroge a chaque ouverture de
    // page ET toutes les 2 minutes tant qu'un onglet reste ouvert (voir
    // public/app.js) - chaque onglet ouvert suffisait a lui seul a
    // relancer l'interdiction, independamment de tout planificateur. Tant
    // qu'une pause partagee est active (voir gmailRateLimit.ts), on
    // repond depuis l'etat connu SANS appeler Gmail.
    const pause = gmailEnPause();
    if (pause) {
      return res.json({
        connecte: false,
        motif: `Google a temporairement limite ce compte ("User-rate limit exceeded"). Nouvelle tentative automatique apres ${pause.toISOString()}. Aucune action a faire - les planificateurs reprendront seuls.`,
      });
    }

    try {
      const client = await getGmailClient(prisma);
      await client!.gmail.users.getProfile({ userId: "me" });
      reinitialiserLimiteGmail();
      res.json({ connecte: true, compteEmail: connexion.compteEmail, derniereSynchro: connexion.derniereSynchro });
    } catch (err) {
      const messageErreur = (err as Error).message;
      if (/User-rate limit exceeded|Quota exceeded/i.test(messageErreur)) signalerLimiteGmail(messageErreur);
      res.json({
        connecte: false,
        motif:
          `Jeton Google invalide ou expire (${messageErreur}). Reconnexion necessaire via le bouton ci-dessous. ` +
          "Cause frequente : ecran de consentement OAuth encore en statut \"Testing\" cote Google Cloud (le refresh_token expire alors automatiquement au bout de 7 jours) - voir docs/mise-en-service.md section 3.",
      });
    }
  });

  // Synchronisation manuelle, en attendant la planification automatique
  // (cron) sur le serveur de production (section 16).
  // Corps optionnel {"depuis": "AAAA-MM-JJ"} : synchronisation historique
  // ponctuelle au-dela de la fenetre glissante habituelle de 14 jours (voir
  // synchroniserGmail) - demande explicite de l'utilisateur.
  router.post("/gmail/sync", async (req, res) => {
    // Meme pause partagee que les planificateurs (voir gmailRateLimit.ts) :
    // un declenchement manuel repete (bouton "Synchroniser") pendant une
    // interdiction Google en cours relancerait lui aussi le quota.
    const pause = gmailEnPause();
    if (pause) {
      return res.status(400).json({ erreur: `Google a temporairement limite ce compte. Nouvelle tentative possible apres ${pause.toISOString()}.` });
    }
    try {
      const brutDepuis = typeof req.body?.depuis === "string" ? req.body.depuis : "";
      const depuisDate = brutDepuis ? new Date(`${brutDepuis}T00:00:00`) : undefined;
      if (brutDepuis && (!depuisDate || Number.isNaN(depuisDate.getTime()))) {
        return res.status(400).json({ erreur: `Date "depuis" invalide : "${brutDepuis}".` });
      }
      const resultat = await synchroniserGmail(prisma, depuisDate);
      reinitialiserLimiteGmail();
      // resumeErreurs : version groupee/lisible de "erreurs" pour
      // l'affichage direct dans l'interface (une meme panne affectant de
      // nombreux messages a la fois, ex. quota Gmail depasse, produisait
      // sinon un mur de texte quasi identique repete ligne par ligne).
      res.json({ ...resultat, resumeErreurs: resumerErreurs(resultat.erreurs) });
    } catch (err) {
      const messageErreur = (err as Error).message;
      if (/User-rate limit exceeded|Quota exceeded/i.test(messageErreur)) signalerLimiteGmail(messageErreur);
      res.status(400).json({ erreur: messageErreur });
    }
  });

  // Apercu du contenu sans envoyer d'e-mail (verification manuelle).
  router.get("/recap/apercu", async (_req, res) => {
    const contenu = await construireRecapQuotidien(prisma);
    res.type("text/plain").send(contenu);
  });

  // Declenchement manuel de l'envoi (test, ou rattrapage si le serveur
  // etait indisponible a l'heure prevue) : en plus de l'envoi automatique
  // quotidien planifie (voir scheduler.ts).
  router.post("/recap/envoyer", async (_req, res) => {
    try {
      await envoyerRecapQuotidien(prisma);
      res.json({ envoye: true });
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  // Note de synthese sur l'etat general de l'activite (CA, tresorerie,
  // documents fournisseurs en attente, points de vigilance) — distincte du
  // recapitulatif quotidien ci-dessus qui ne couvre que les evenements du
  // jour meme.
  router.get("/bilan-sante/apercu", async (_req, res) => {
    const contenu = await construireBilanSante(prisma);
    res.type("text/plain").send(contenu);
  });

  router.post("/bilan-sante/envoyer", async (_req, res) => {
    try {
      await envoyerBilanSante(prisma);
      res.json({ envoye: true });
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  // --- Relances (section 4.3, Phase 5 "moteur de regles") -----------------
  // Le moteur determine QUI relancer et A QUEL PALIER ; l'envoi reste un
  // geste humain volontaire (voir src/services/relances.ts), jamais
  // declenche automatiquement par le planificateur.

  router.get("/relances", async (_req, res) => {
    res.json(await listerFacturesARelancer(prisma));
  });

  router.post("/relances/:factureId/envoyer", async (req, res) => {
    try {
      const envoyee = await envoyerRelance(prisma, req.params.factureId);
      res.json({ envoyee: true, ...envoyee });
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  // --- Fournisseurs (section 6, Phase 4) -----------------------------------
  // Aucun import dedie (contrairement aux clients) : les fiches sont
  // derivees automatiquement de l'expediteur des documents recus par Gmail
  // (voir src/services/fournisseurs.ts).

  router.get("/fournisseurs", async (_req, res) => {
    res.json(await listerFournisseurs(prisma));
  });

  router.get("/fournisseurs/:id", async (req, res) => {
    const fournisseur = await obtenirFournisseur(prisma, req.params.id);
    if (!fournisseur) return res.status(404).json({ erreur: "Fournisseur introuvable." });
    res.json(fournisseur);
  });

  // Nettoyage manuel des fiches creees a tort (expediteur qui n'est pas un
  // vrai fournisseur, ou backlog issu d'avant le correctif de classification
  // par contenu PDF) : jamais de suppression automatique, seulement a la
  // demande explicite de l'utilisateur depuis l'interface.
  router.delete("/fournisseurs/:id", async (req, res) => {
    try {
      await supprimerFournisseur(prisma, req.params.id);
      res.status(204).end();
    } catch (err) {
      if (err instanceof FournisseurAvecFacturesError) {
        return res.status(409).json({ erreur: err.message });
      }
      res.status(404).json({ erreur: (err as Error).message });
    }
  });

  router.get("/documents-fournisseurs", async (req, res) => {
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    const statutDext = typeof req.query.statutDext === "string" ? req.query.statutDext : undefined;
    const documents = await prisma.documentFournisseur.findMany({
      where: { ...(type ? { type } : {}), ...(statutDext ? { statutDext } : {}) },
      include: { fournisseur: { select: { nom: true } } },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    res.json(documents);
  });

  // Previsualisation d'une facture fournisseur reconnue mais pas encore
  // envoyee a Dext (meme principe que /anomalies/:id/document : le fichier
  // n'est pas stocke en base, seulement sa reference Gmail).
  router.get("/documents-fournisseurs/:id/document", async (req, res) => {
    const document = await prisma.documentFournisseur.findUnique({ where: { id: req.params.id } });
    if (!document) return res.status(404).json({ erreur: "Document introuvable." });
    // Document papier numerise (cheminFichier, voir documentsScannes.ts) :
    // servi directement depuis le disque, pas de message Gmail a redemander.
    if (document.cheminFichier) {
      try {
        const donnees = await fs.readFile(document.cheminFichier);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(document.fichierNom || "document")}"`);
        return res.send(donnees);
      } catch {
        return res.status(404).json({ erreur: "Fichier numerise introuvable sur le serveur." });
      }
    }
    if (!document.gmailMessageId || !document.gmailAttachmentId) {
      return res.status(404).json({ erreur: "Document non disponible (piece jointe plus ancienne, reference Gmail non enregistree)." });
    }
    try {
      const connexionGmail = await getGmailClient(prisma);
      if (!connexionGmail) return res.status(400).json({ erreur: "Gmail non connecte." });
      const { gmail } = connexionGmail;
      const attachment = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: document.gmailMessageId,
        id: document.gmailAttachmentId,
      });
      const donnees = Buffer.from(attachment.data.data || "", "base64url");
      res.setHeader("Content-Type", typeMimePourAffichage(document.fichierNom, document.mimeType));
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(document.fichierNom || "document")}"`);
      res.send(donnees);
    } catch (err) {
      res.status(502).json({ erreur: `Impossible de recuperer le document depuis Gmail : ${(err as Error).message}` });
    }
  });

  // Envoi manuel vers Dext d'une facture fournisseur en attente (transfert
  // automatique en pause, ou correction manuelle depuis les anomalies) :
  // toujours a la demande explicite de l'utilisateur (section 14).
  router.post("/documents-fournisseurs/:id/envoyer", async (req, res) => {
    try {
      await envoyerDocumentFournisseurVersDext(prisma, req.params.id);
      res.status(204).end();
    } catch (err) {
      if (err instanceof DocumentFournisseurEnvoiError) {
        return res.status(409).json({ erreur: err.message });
      }
      res.status(500).json({ erreur: (err as Error).message });
    }
  });

  // Numerisation d'un document papier (facture, avoir, bon d'enlevement,
  // releve, devis) depuis l'appareil photo (demande explicite de
  // l'utilisateur : "je dois les scanner, mais ça sort mal"). L'image
  // envoyee est deja recadree/mise en contraste cote frontend (voir
  // app.js) ; cette route se contente de la mettre en PDF et de creer le
  // document comme s'il venait de Gmail (voir documentsScannes.ts).
  router.post("/documents-fournisseurs/scan", upload.single("image"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ erreur: "Aucune image recue (champ attendu : 'image')." });
    }
    try {
      const document = await enregistrerDocumentScanne(prisma, {
        image: req.file.buffer,
        type: typeof req.body?.type === "string" ? req.body.type : "",
        fournisseurNom: typeof req.body?.fournisseurNom === "string" ? req.body.fournisseurNom : "",
        numero: typeof req.body?.numero === "string" ? req.body.numero : null,
      });
      res.status(201).json({ id: document.id, type: document.type, statutDext: document.statutDext });
    } catch (err) {
      if (err instanceof DocumentScanneError) {
        return res.status(400).json({ erreur: err.message });
      }
      res.status(500).json({ erreur: (err as Error).message });
    }
  });

  router.get("/anomalies", async (req, res) => {
    const statut = typeof req.query.statut === "string" ? req.query.statut : undefined;
    const anomalies = await prisma.anomalie.findMany({
      where: statut ? { statut } : undefined,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json(anomalies);
  });

  // Previsualisation rapide d'une piece jointe ambigue (bouton "Voir" du
  // centre de validation) : le fichier n'est pas stocke en base (seul son
  // empreinte l'est, pour la deduplication), il est redemande a Gmail a la
  // demande via les references conservees dans les preuves de l'anomalie.
  router.get("/anomalies/:id/document", async (req, res) => {
    const anomalie = await prisma.anomalie.findUnique({ where: { id: req.params.id } });
    if (!anomalie) return res.status(404).json({ erreur: "Anomalie introuvable." });

    let preuves: Record<string, string> = {};
    try {
      preuves = JSON.parse(anomalie.preuves || "{}");
    } catch {
      // preuves illisibles : traite comme absentes ci-dessous
    }
    if (!preuves.messageId || !preuves.attachmentId) {
      return res.status(404).json({ erreur: "Document non disponible pour cette anomalie (pieces jointes plus anciennes)." });
    }

    try {
      const connexionGmail = await getGmailClient(prisma);
      if (!connexionGmail) return res.status(400).json({ erreur: "Gmail non connecte." });
      const { gmail } = connexionGmail;
      const attachment = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: preuves.messageId,
        id: preuves.attachmentId,
      });
      const donnees = Buffer.from(attachment.data.data || "", "base64url");
      res.setHeader("Content-Type", typeMimePourAffichage(preuves.fichier, preuves.mimeType));
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(preuves.fichier || "document")}"`);
      res.send(donnees);
    } catch (err) {
      res.status(502).json({ erreur: `Impossible de recuperer le document depuis Gmail : ${(err as Error).message}` });
    }
  });

  const STATUTS_ANOMALIE_VALIDES = ["a_valider", "validee", "ignoree"];

  // Traitement manuel d'une anomalie (section 7.2 : le centre de validation
  // sert justement a decider a la main des cas non reconnus automatiquement).
  // Jamais de suppression : le statut "ignoree" garde une trace, contrairement
  // a une suppression silencieuse.
  router.patch("/anomalies/:id", async (req, res) => {
    const { statut } = req.body || {};
    if (typeof statut !== "string" || !STATUTS_ANOMALIE_VALIDES.includes(statut)) {
      return res.status(400).json({ erreur: `statut invalide, attendu l'un de : ${STATUTS_ANOMALIE_VALIDES.join(", ")}` });
    }
    try {
      const anomalie = await prisma.anomalie.update({ where: { id: req.params.id }, data: { statut } });
      res.json(anomalie);
    } catch (err) {
      res.status(404).json({ erreur: "Anomalie introuvable." });
    }
  });

  // Classification manuelle d'un document ambigu en facture fournisseur
  // (demande explicite de l'utilisateur : pouvoir faire apparaitre dans
  // l'onglet Factures un document que le pipeline automatique n'a pas su
  // reconnaitre). Rejoint ensuite "Factures fournisseurs reçues", au meme
  // titre qu'une facture reconnue automatiquement.
  router.post("/anomalies/:id/classer-facture", async (req, res) => {
    try {
      await classerAnomalieCommeFacture(prisma, req.params.id);
      res.status(204).end();
    } catch (err) {
      if (err instanceof AnomalieClassificationError) {
        return res.status(409).json({ erreur: err.message });
      }
      res.status(500).json({ erreur: (err as Error).message });
    }
  });

  // Traitement en masse : soit une selection precise (ids, ex. cases cochees
  // dans l'interface), soit un filtre par type (ex. nettoyer un lot genere
  // par un bug de classification desormais corrige). Ne touche que les
  // anomalies actuellement "a_valider".
  router.post("/anomalies/ignorer-en-masse", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => typeof id === "string") : undefined;
    const type = typeof req.body?.type === "string" ? req.body.type : undefined;
    if (!ids && !type) {
      return res.status(400).json({ erreur: "Fournir soit 'ids' (tableau), soit 'type'." });
    }
    const resultat = await prisma.anomalie.updateMany({
      where: { statut: "a_valider", ...(ids ? { id: { in: ids } } : {}), ...(type ? { type } : {}) },
      data: { statut: "ignoree" },
    });
    res.json({ nombreIgnore: resultat.count });
  });

  // --- Memoire a long terme (section 8, Phase 8) ---------------------------
  // Consultable directement (audit humain), en plus de l'usage par Morgane
  // (src/services/morgane.ts).

  router.get("/decisions", async (req, res) => {
    const activesSeulement = req.query.actives !== "false";
    res.json(await listerDecisions(prisma, { activesSeulement }));
  });

  // Revocation : fixe la fin de validite a maintenant plutot que de
  // supprimer, pour garder une trace (meme principe que "ignoree" sur une
  // anomalie).
  router.patch("/decisions/:id/terminer", async (req, res) => {
    try {
      res.json(await terminerDecision(prisma, req.params.id));
    } catch {
      res.status(404).json({ erreur: "Decision introuvable." });
    }
  });

  // --- Demandes d'intervention (saisie rapide apres un appel client) ------
  //
  // Demande utilisateur : remplace la prise de note papier puis la double
  // saisie dans Synec (qui n'a pas d'API) par une fiche structuree depuis
  // le telephone. File d'attente "a saisir" tant que Synec lui-meme n'est
  // pas automatise cote ecriture - voir docs/prospection.md pour le
  // parallele avec Synec cote lecture (export factures).

  router.post("/demandes-intervention", async (req, res) => {
    try {
      const demande = await creerDemandeIntervention(prisma, req.body || {});
      res.status(201).json(demande);
    } catch (err) {
      if (err instanceof DemandeInterventionValidationError) return res.status(400).json({ erreur: err.message });
      throw err;
    }
  });

  router.get("/demandes-intervention", async (req, res) => {
    const statut = typeof req.query.statut === "string" ? req.query.statut : "a_saisir";
    res.json(await listerDemandesIntervention(prisma, statut));
  });

  router.patch("/demandes-intervention/:id", async (req, res) => {
    try {
      res.json(await modifierDemandeIntervention(prisma, req.params.id, req.body || {}));
    } catch (err) {
      if (err instanceof DemandeInterventionValidationError) return res.status(400).json({ erreur: err.message });
      res.status(404).json({ erreur: "Demande introuvable." });
    }
  });

  router.patch("/demandes-intervention/:id/marquer-saisie", async (req, res) => {
    try {
      res.json(await marquerDemandeInterventionSaisie(prisma, req.params.id));
    } catch {
      res.status(404).json({ erreur: "Demande introuvable." });
    }
  });

  // Ecriture automatique dans Synec (client + planning), voir
  // src/services/synecEcriture.ts - declenchee uniquement par ce clic
  // explicite sur UNE demande precise, jamais automatique.
  router.post("/demandes-intervention/:id/envoyer-synec", async (req, res) => {
    try {
      res.json(await envoyerDemandeVersSynec(prisma, req.params.id));
    } catch (err) {
      if (err instanceof SynecEcritureError) return res.status(400).json({ erreur: err.message });
      res.status(500).json({ erreur: (err as Error).message });
    }
  });

  // --- Google Ads : import manuel (palliatif en attendant l'acces API) ----
  //
  // Demande utilisateur : analyser les campagnes avec Morgane des
  // maintenant, sans attendre que Google valide l'acces API ("Acces
  // Explorer" en attente, voir src/services/googleAds.ts). Chaque depot
  // remplace la photographie precedente - voir src/services/googleAdsImport.ts.

  router.post("/google-ads/import", upload.single("fichier"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ erreur: "Aucun fichier recu (champ attendu : 'fichier')." });
    }
    try {
      const resultat = await importerCampagnesAds(prisma, req.file.originalname, req.file.buffer);
      res.status(200).json(resultat);
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.get("/google-ads/dernier-import", async (_req, res) => {
    const resultat = await dernieresCampagnesImportees(prisma);
    res.json(resultat);
  });

  // --- Google Ads : propositions d'action de Morgane (ecran de validation) -
  //
  // Demande explicite de l'utilisateur : Morgane ne modifie jamais une
  // campagne directement depuis la conversation - elle depose une
  // proposition (voir /morgane/message, outil proposer_action_ads), que
  // l'utilisateur accepte ou refuse ici, hors conversation. Voir
  // src/services/googleAdsActions.ts.

  // Liste en direct les campagnes Google Ads existantes (lecture seule) :
  // manquait jusqu'ici pour tout diagnostic/nettoyage manuel (ex. retrouver
  // l'identifiant d'une campagne pour la supprimer via une proposition),
  // le reste de l'application n'ayant jamais eu besoin que de la liste des
  // propositions elles-memes, pas des campagnes reelles.
  router.get("/google-ads/campagnes", async (req, res) => {
    try {
      const jours = req.query.jours ? Number(req.query.jours) : undefined;
      res.json(await listerCampagnesAds(prisma, jours));
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  // Controle de sante du compte Google Ads, independant de Morgane/Claude
  // (lecture seule, directement sur l'API Google Ads) - utile quand
  // Morgane elle-meme est indisponible (ex. plafond d'usage de l'API
  // Claude atteint) mais qu'un diagnostic est quand meme necessaire :
  // annonces/extensions refusees par une politique, actions de conversion
  // configurees, et etat des scopes/de la liaison du jeton.
  router.get("/google-ads/diagnostic", async (req, res) => {
    try {
      const campagneId = typeof req.query.campagneId === "string" ? req.query.campagneId : undefined;
      const [politiqueAnnonces, politiqueAssets, actionsConversion, objectifsConversionCampagne, scopesJeton, lienGestionnaire] = await Promise.all([
        verifierPolitiqueAnnonces(prisma, campagneId).catch((e) => ({ erreur: (e as Error).message })),
        verifierPolitiqueAssets(prisma).catch((e) => ({ erreur: (e as Error).message })),
        listerActionsConversion(prisma).catch((e) => ({ erreur: (e as Error).message })),
        listerObjectifsConversionCampagne(prisma, campagneId).catch((e) => ({ erreur: (e as Error).message })),
        diagnosticScopesJeton(prisma).catch((e) => (e as Error).message),
        diagnosticLienGestionnaire(prisma).catch((e) => (e as Error).message),
      ]);
      res.json({
        configuration: diagnosticConfigurationAds(),
        scopesJeton,
        lienGestionnaire,
        politiqueAnnonces,
        politiqueAssets,
        actionsConversion,
        objectifsConversionCampagne,
      });
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  // Depot direct d'une proposition (hors conversation avec Morgane, qui
  // passe par l'outil proposer_action_ads de /morgane/message) : utile pour
  // une action ponctuelle demandee explicitement par l'utilisateur en
  // dehors du chat (ex. nettoyage de campagnes en double). Rejoint ensuite
  // le meme ecran de validation/refus que toute autre proposition - rien
  // n'est applique ici, uniquement deposee en attente.
  router.post("/google-ads/propositions", async (req, res) => {
    try {
      const proposition = await creerPropositionAds(prisma, req.body);
      res.status(201).json(proposition);
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.get("/google-ads/propositions", async (req, res) => {
    const statut = typeof req.query.statut === "string" ? req.query.statut : undefined;
    res.json(await listerPropositionsAds(prisma, statut));
  });

  router.post("/google-ads/propositions/:id/accepter", async (req, res) => {
    try {
      res.json(await accepterPropositionAds(prisma, req.params.id));
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  router.post("/google-ads/propositions/:id/refuser", async (req, res) => {
    try {
      res.json(await refuserPropositionAds(prisma, req.params.id));
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  // --- Morgane, assistante IA (Phase 7 du cahier des charges) -------------

  // Telechargement d'un document PDF genere par Morgane a la demande
  // (outil generer_document_pdf/generer_dossier_comptable, voir
  // documentsGeneres.ts) - nom de fichier toujours genere cote serveur
  // (slug + uuid), jamais fourni par l'utilisateur : la validation du
  // format ci-dessous est une defense en profondeur, pas la seule barriere.
  router.get("/documents-generes/:fichier", async (req, res) => {
    const { fichier } = req.params;
    if (!nomFichierGenereValide(fichier)) {
      return res.status(400).json({ erreur: "Nom de fichier invalide." });
    }
    try {
      const chemin = cheminDocumentGenere(fichier);
      const contenu = await fs.readFile(chemin);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${fichier}"`);
      res.send(contenu);
    } catch {
      res.status(404).json({ erreur: "Document introuvable (peut-etre deja supprime)." });
    }
  });

  router.post("/morgane/message", async (req, res) => {
    const historique = req.body?.historique;
    if (!Array.isArray(historique) || historique.length === 0) {
      return res.status(400).json({ erreur: "Fournir 'historique' (tableau de {role, content})." });
    }
    const valide = historique.every(
      (m: unknown): m is MessageMorgane =>
        !!m &&
        typeof m === "object" &&
        ((m as MessageMorgane).role === "user" || (m as MessageMorgane).role === "assistant") &&
        typeof (m as MessageMorgane).content === "string"
    );
    if (!valide) {
      return res.status(400).json({ erreur: "Chaque message doit avoir 'role' (user|assistant) et 'content' (texte)." });
    }

    // Piece jointe optionnelle (photo/fichier) pour CE tour uniquement -
    // jamais stockee dans l'historique renvoye par le client (section
    // "assistante administrative" : les octets ne doivent pas etre
    // re-envoyes a chaque message suivant, voir morgane.ts).
    let pieceJointe: PieceJointeMorgane | undefined;
    const brut = req.body?.pieceJointe;
    if (brut !== undefined && brut !== null) {
      if (
        !brut ||
        typeof brut !== "object" ||
        typeof brut.nomFichier !== "string" ||
        typeof brut.mimeType !== "string" ||
        typeof brut.donneesBase64 !== "string" ||
        !MIME_PIECES_JOINTES_AUTORISEES.includes(brut.mimeType)
      ) {
        return res
          .status(400)
          .json({ erreur: `Piece jointe invalide (type accepte : ${MIME_PIECES_JOINTES_AUTORISEES.join(", ")}).` });
      }
      pieceJointe = { nomFichier: brut.nomFichier, mimeType: brut.mimeType, donneesBase64: brut.donneesBase64 };
    }

    try {
      const reponse = await repondreMorgane(prisma, historique, pieceJointe);
      res.json({ reponse });
    } catch (err) {
      res.status(400).json({ erreur: (err as Error).message });
    }
  });

  return router;
}
