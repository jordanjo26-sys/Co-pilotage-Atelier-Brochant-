import { PrismaClient } from "@prisma/client";
import MailComposer from "nodemailer/lib/mail-composer";
import { getGmailClient } from "./googleAuth";
import { logEvenement } from "./journalService";

/**
 * Bilan de sante de l'entreprise (section du cahier des charges demandant
 * une note de synthese sur l'etat general de l'activite, distincte du
 * recapitulatif quotidien de `dailyRecap.ts` qui ne couvre que les
 * evenements du jour). Volontairement une synthese de chiffres deja connus
 * du systeme (jamais d'interpretation ou de prevision inventee : section
 * 14, "les regles metier deterministes priment sur une interpretation
 * libre de l'IA") plutot qu'un texte genere par un modele de langage.
 */

function joursDepuis(date: Date, reference: Date): number {
  return Math.floor((reference.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
}

interface TrancheRetard {
  libelle: string;
  nombre: number;
  montant: number;
}

/**
 * Construit le contenu (texte brut) du bilan de sante. `maintenant` est
 * injectable pour les tests, comme le reste des services de synthese.
 */
export async function construireBilanSante(prisma: PrismaClient, maintenant: Date = new Date()): Promise<string> {
  const il7Jours = new Date(maintenant);
  il7Jours.setDate(il7Jours.getDate() - 7);
  const il14Jours = new Date(maintenant);
  il14Jours.setDate(il14Jours.getDate() - 14);
  const il30Jours = new Date(maintenant);
  il30Jours.setDate(il30Jours.getDate() - 30);

  // --- Chiffre d'affaires : 7 derniers jours vs 7 jours precedents --------
  const [facturesSemaine, facturesSemainePrecedente, facturesMois] = await Promise.all([
    prisma.facture.findMany({ where: { dateEmission: { gte: il7Jours, lt: maintenant } }, select: { montantTTC: true } }),
    prisma.facture.findMany({ where: { dateEmission: { gte: il14Jours, lt: il7Jours } }, select: { montantTTC: true } }),
    prisma.facture.findMany({ where: { dateEmission: { gte: il30Jours, lt: maintenant } }, select: { montantTTC: true } }),
  ]);
  const caSemaine = facturesSemaine.reduce((s, f) => s + f.montantTTC, 0);
  const caSemainePrecedente = facturesSemainePrecedente.reduce((s, f) => s + f.montantTTC, 0);
  const caMois = facturesMois.reduce((s, f) => s + f.montantTTC, 0);
  const evolution =
    caSemainePrecedente > 0 ? Math.round(((caSemaine - caSemainePrecedente) / caSemainePrecedente) * 1000) / 10 : null;

  // --- Impayes, avec repartition par anciennete d'echeance -----------------
  const impayees = await prisma.facture.findMany({
    where: { statut: { in: ["impayee", "partiellement_payee"] } },
    select: { montantTTC: true, montantRegle: true, dateEcheance: true },
  });
  const resteAPercevoir = impayees.reduce((s, f) => s + (f.montantTTC - f.montantRegle), 0);

  const tranches: TrancheRetard[] = [
    { libelle: "pas encore echu", nombre: 0, montant: 0 },
    { libelle: "retard < 30 jours", nombre: 0, montant: 0 },
    { libelle: "retard 30 a 60 jours", nombre: 0, montant: 0 },
    { libelle: "retard 60 a 90 jours", nombre: 0, montant: 0 },
    { libelle: "retard > 90 jours", nombre: 0, montant: 0 },
  ];
  for (const f of impayees) {
    const reste = f.montantTTC - f.montantRegle;
    const retard = f.dateEcheance ? joursDepuis(f.dateEcheance, maintenant) : -1;
    const idx = retard < 0 ? 0 : retard < 30 ? 1 : retard < 60 ? 2 : retard < 90 ? 3 : 4;
    tranches[idx].nombre++;
    tranches[idx].montant += reste;
  }

  // --- Documents fournisseurs (Gmail -> Dext) -------------------------------
  const [facturesEnAttenteEnvoi, ambigusEnAttente, devisRecus30j] = await Promise.all([
    prisma.documentFournisseur.count({ where: { type: "facture", statutDext: "a_valider" } }),
    prisma.documentFournisseur.count({ where: { type: "ambigu", statutDext: "a_valider" } }),
    prisma.documentFournisseur.count({ where: { type: "devis", createdAt: { gte: il30Jours } } }),
  ]);

  // --- Anomalies et imports --------------------------------------------------
  const anomaliesOuvertes = await prisma.anomalie.count({ where: { statut: "a_valider" } });
  const importsAVerifier = await prisma.importBatch.count({ where: { statut: { in: ["type_inconnu", "partiel", "echec"] } } });

  const transfertAutoActif = process.env.DEXT_AUTO_FORWARD !== "false";
  const fmt = (n: number) => `${n.toFixed(2)} EUR`;

  const lignes: string[] = [];
  lignes.push(`Bilan de sante - Atelier Brochant - ${maintenant.toLocaleDateString("fr-FR")}`);
  lignes.push("");

  lignes.push("== Activite ==");
  lignes.push(`CA des 7 derniers jours : ${fmt(caSemaine)}` + (evolution !== null ? ` (${evolution >= 0 ? "+" : ""}${evolution}% vs semaine precedente)` : ""));
  lignes.push(`CA des 30 derniers jours : ${fmt(caMois)}`);
  lignes.push("");

  lignes.push("== Tresorerie (impayes) ==");
  lignes.push(`${impayees.length} facture(s) impayee(s) ou partiellement reglee(s), ${fmt(resteAPercevoir)} restant a percevoir.`);
  for (const t of tranches) {
    if (t.nombre > 0) lignes.push(`  - ${t.libelle} : ${t.nombre} facture(s), ${fmt(t.montant)}`);
  }
  if (tranches[3].nombre + tranches[4].nombre > 0) {
    lignes.push(`  ATTENTION : ${tranches[3].nombre + tranches[4].nombre} facture(s) en retard de plus de 60 jours.`);
  }
  lignes.push("");

  lignes.push("== Documents fournisseurs (Gmail -> Dext) ==");
  lignes.push(`Transfert automatique vers Dext : ${transfertAutoActif ? "actif" : "en pause (periode d'observation)"}.`);
  if (!transfertAutoActif && facturesEnAttenteEnvoi > 0) {
    lignes.push(`${facturesEnAttenteEnvoi} facture(s) mise(s) de cote en attente de transfert manuel.`);
  }
  if (ambigusEnAttente > 0) {
    lignes.push(`${ambigusEnAttente} document(s) non reconnu(s) en attente de classification manuelle.`);
  }
  if (devisRecus30j > 0) {
    lignes.push(`${devisRecus30j} devis / offre(s) de prix recu(s) sur les 30 derniers jours.`);
  }
  lignes.push("");

  lignes.push("== Points de vigilance ==");
  const points: string[] = [];
  if (anomaliesOuvertes > 0) points.push(`${anomaliesOuvertes} anomalie(s) ouverte(s) a traiter dans le centre de validation.`);
  if (importsAVerifier > 0) points.push(`${importsAVerifier} import(s) CSV a verifier.`);
  if (points.length === 0) points.push("Rien a signaler.");
  for (const p of points) lignes.push(`- ${p}`);

  return lignes.join("\n");
}

/** Envoie le bilan de sante a la boite Gmail connectee, sur demande. */
export async function envoyerBilanSante(prisma: PrismaClient, maintenant: Date = new Date()): Promise<void> {
  const connexionGmail = await getGmailClient(prisma);
  if (!connexionGmail) throw new Error("Aucune boite Gmail connectee.");

  const { gmail, connexion } = connexionGmail;
  const contenu = await construireBilanSante(prisma, maintenant);

  const composer = new MailComposer({
    to: connexion.compteEmail,
    subject: `Bilan de sante - ${maintenant.toLocaleDateString("fr-FR")} - Atelier Brochant`,
    text: contenu,
  });
  const message = await composer.compile().build();
  const raw = message.toString("base64url");
  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });

  await logEvenement(prisma, {
    evenement: "bilan_sante_envoye",
    action: `Bilan de sante envoye a ${connexion.compteEmail}`,
    resultat: "Envoi reussi.",
  });
}
