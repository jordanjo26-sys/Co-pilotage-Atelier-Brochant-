import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { google } from "googleapis";
import { PrismaClient } from "@prisma/client";
import { buildOAuthClient, CALENDAR_SCOPE } from "./googleAuth";
import { dechiffrer } from "./cipher";

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Agenda Google de l'atelier, utilise par l'agent telephonique pour
 * proposer et reserver des creneaux d'intervention. Reutilise la connexion
 * OAuth Google existante (meme compte que Gmail) : il faut simplement
 * l'avoir (re)connectee apres l'ajout du scope agenda, sinon l'agent se
 * rabat sur une simple prise de message avec le creneau souhaite.
 */

export const FUSEAU = "Europe/Paris";

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"] as const;

export type HorairesRendezVous = Partial<Record<(typeof JOURS)[number], [string, string][]>>;

export interface Intervalle {
  debut: Date;
  fin: Date;
}

export interface OptionsCreneaux {
  horaires: HorairesRendezVous;
  dureeMinutes: number;
  delaiMinimumHeures: number;
  joursRecherche: number;
  maximum: number;
  /** Jour souhaite par l'appelant (AAAA-MM-JJ), sinon a partir de maintenant. */
  aPartirDu?: string;
}

function chevauche(a: Intervalle, b: Intervalle): boolean {
  return a.debut < b.fin && b.debut < a.fin;
}

/**
 * Calcule les prochains creneaux libres (fonction pure, testable sans
 * Google) : decoupe les plages d'ouverture de chaque jour en creneaux de
 * la duree voulue, en heure de Paris quel que soit le fuseau du serveur,
 * et ecarte ceux qui chevauchent un evenement deja present dans l'agenda
 * ou qui tombent trop tot (delai minimum pour se deplacer).
 */
export function calculerCreneauxLibres(occupes: Intervalle[], maintenant: Date, options: OptionsCreneaux): Intervalle[] {
  const auPlusTot = maintenant.getTime() + options.delaiMinimumHeures * 3_600_000;
  const dureeMs = options.dureeMinutes * 60_000;
  // Les jours sont parcourus comme de simples dates calendaires (en UTC pour
  // l'arithmetique), puis chaque heure d'ouverture est convertie en instant
  // reel via le fuseau de Paris : l'arithmetique directe sur un objet
  // dayjs.tz decale les heures (comportement connu du plugin timezone).
  const premierJour = options.aPartirDu ?? dayjs(maintenant).tz(FUSEAU).format("YYYY-MM-DD");
  const resultat: Intervalle[] = [];

  for (let i = 0; i < options.joursRecherche && resultat.length < options.maximum; i++) {
    const jour = dayjs.utc(premierJour).add(i, "day");
    const dateJour = jour.format("YYYY-MM-DD");
    for (const [ouverture, fermeture] of options.horaires[JOURS[jour.day()]] ?? []) {
      let debut = dayjs.tz(`${dateJour} ${ouverture}`, FUSEAU).valueOf();
      const finPlage = dayjs.tz(`${dateJour} ${fermeture}`, FUSEAU).valueOf();
      for (; debut + dureeMs <= finPlage && resultat.length < options.maximum; debut += dureeMs) {
        const creneau = { debut: new Date(debut), fin: new Date(debut + dureeMs) };
        if (debut >= auPlusTot && !occupes.some((o) => chevauche(o, creneau))) resultat.push(creneau);
      }
    }
  }
  return resultat;
}

/** "mardi 7 octobre a 14h00", tel qu'il sera prononce a l'appelant. */
export function formaterCreneau(date: Date): string {
  const d = dayjs(date).tz(FUSEAU);
  return `${JOURS[d.day()]} ${d.date()} ${d.toDate().toLocaleDateString("fr-FR", { month: "long", timeZone: FUSEAU })} a ${d.format("HH")}h${d.format("mm")}`;
}

async function getCalendarClient(prisma: PrismaClient) {
  const connexion = await prisma.gmailConnexion.findFirst({ where: { actif: true } });
  if (!connexion || !connexion.scope?.includes(CALENDAR_SCOPE)) return null;
  const client = buildOAuthClient();
  client.setCredentials({ refresh_token: dechiffrer(connexion.refreshTokenChiffre) });
  return google.calendar({ version: "v3", auth: client });
}

function calendarId(): string {
  return process.env.GOOGLE_CALENDAR_ID || "primary";
}

export class AgendaNonConnecteError extends Error {
  constructor() {
    super(
      "Agenda Google non connecte (reconnecter le compte Google via /auth/google pour autoriser l'acces a l'agenda)."
    );
  }
}

async function listerOccupations(calendar: NonNullable<Awaited<ReturnType<typeof getCalendarClient>>>, debut: Date, fin: Date) {
  const reponse = await calendar.events.list({
    calendarId: calendarId(),
    timeMin: debut.toISOString(),
    timeMax: fin.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 250,
  });
  return (reponse.data.items ?? [])
    .filter((e) => e.status !== "cancelled" && e.transparency !== "transparent")
    .map((e) => ({
      // Evenement "toute la journee" : bloque la journee entiere.
      debut: new Date(e.start?.dateTime ?? `${e.start?.date}T00:00:00`),
      fin: new Date(e.end?.dateTime ?? `${e.end?.date}T00:00:00`),
    }));
}

export async function chercherCreneauxLibres(
  prisma: PrismaClient,
  options: OptionsCreneaux,
  maintenant: Date = new Date()
): Promise<Intervalle[]> {
  const calendar = await getCalendarClient(prisma);
  if (!calendar) throw new AgendaNonConnecteError();
  const debut = options.aPartirDu ? dayjs.tz(options.aPartirDu, FUSEAU).toDate() : maintenant;
  const fin = dayjs(debut).add(options.joursRecherche + 1, "day").toDate();
  const occupes = await listerOccupations(calendar, debut < maintenant ? maintenant : debut, fin);
  return calculerCreneauxLibres(occupes, maintenant, options);
}

export interface Reservation {
  debut: Date;
  fin: Date;
  titre: string;
  description: string;
  lieu?: string | null;
}

/**
 * Cree l'evenement dans l'agenda, apres avoir reverifie que le creneau est
 * toujours libre (il a pu etre pris entre la proposition et la confirmation
 * de l'appelant). Retourne null si le creneau n'est plus disponible.
 */
export async function reserverCreneau(prisma: PrismaClient, reservation: Reservation): Promise<string | null> {
  const calendar = await getCalendarClient(prisma);
  if (!calendar) throw new AgendaNonConnecteError();
  const occupes = await listerOccupations(calendar, reservation.debut, reservation.fin);
  if (occupes.some((o) => chevauche(o, reservation))) return null;

  const evenement = await calendar.events.insert({
    calendarId: calendarId(),
    requestBody: {
      summary: reservation.titre,
      description: reservation.description,
      location: reservation.lieu ?? undefined,
      start: { dateTime: reservation.debut.toISOString(), timeZone: FUSEAU },
      end: { dateTime: reservation.fin.toISOString(), timeZone: FUSEAU },
    },
  });
  return evenement.data.id ?? "";
}
