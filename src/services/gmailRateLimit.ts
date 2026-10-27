// Etat partage (en memoire, tout le process) du blocage de quota Gmail
// ("User-rate limit exceeded"). Cause reelle d'un blocage qui a persiste
// plusieurs heures en production (octobre 2026) malgre tous les
// planificateurs backend corriges pour respecter le "Retry after" indique
// par Google : GET /api/gmail/status (interroge par le tableau de bord a
// chaque ouverture de page ET toutes les 2 minutes tant que l'onglet reste
// ouvert, voir public/app.js) faisait lui aussi un appel Gmail reel
// (gmail.users.getProfile) a chaque fois, sans la moindre pause - chaque
// onglet du navigateur ouvert suffisait a lui seul a relancer
// l'interdiction, independamment de tout planificateur backend.
//
// Ce module centralise le garde-fou pour que TOUT appelant (planificateurs
// ET routes HTTP consultees par le frontend) partage le meme etat et ne
// retente jamais en pleine interdiction en cours.
let pauseJusqua: Date | null = null;

/** Extrait l'indication "Retry after <date ISO>" d'un message d'erreur Gmail. */
export function extraireDateReprise(messageErreur: string): Date | null {
  const correspondance = messageErreur.match(/Retry after (\S+)/);
  if (!correspondance) return null;
  const date = new Date(correspondance[1]);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Date de fin de pause en cours, ou null si aucune pause active. */
export function gmailEnPause(): Date | null {
  return pauseJusqua && new Date() < pauseJusqua ? pauseJusqua : null;
}

/** A appeler quand un appel Gmail vient d'echouer avec un quota depasse. */
export function signalerLimiteGmail(messageErreur: string): Date {
  const dateReprise = extraireDateReprise(messageErreur) ?? new Date(Date.now() + 15 * 60 * 1000);
  pauseJusqua = dateReprise;
  return dateReprise;
}

/** A appeler quand un appel Gmail vient de reussir. */
export function reinitialiserLimiteGmail(): void {
  pauseJusqua = null;
}
