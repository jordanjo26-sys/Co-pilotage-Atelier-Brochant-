import { PrismaClient } from "@prisma/client";
import MailComposer from "nodemailer/lib/mail-composer";
import { getGmailClient } from "./googleAuth";
import { getDashboardSummary } from "./dashboardService";
import { logEvenement } from "./journalService";

const LIBELLES_TYPE: Record<string, string> = {
  facture: "facture(s)",
  avoir: "avoir(s)",
  bon_enlevement: "bon(s) d'enlèvement",
  releve: "relevé(s)",
  devis: "devis / offre(s) de prix",
};

function debutDeJournee(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * Construit le contenu (texte brut) du recapitulatif quotidien (demande
 * initiale de l'utilisateur : "un recapitulatif clair des actions
 * effectuees, des documents traites, des eventuels points en attente et
 * des actions necessitant mon attention"). S'appuie exclusivement sur des
 * donnees deja journalisees par le reste du systeme (aucune nouvelle
 * source de verite) : le tableau de bord (section 9.1), les documents
 * recus par Gmail aujourd'hui, et les anomalies ouvertes.
 */
export async function construireRecapQuotidien(prisma: PrismaClient, maintenant: Date = new Date()): Promise<string> {
  const debutJour = debutDeJournee(maintenant);
  const dashboard = await getDashboardSummary(prisma, maintenant);

  const documentsAujourdhui = await prisma.documentFournisseur.findMany({
    where: { createdAt: { gte: debutJour } },
    select: { type: true, statutDext: true },
  });

  const parType = new Map<string, number>();
  let facturesEnvoyees = 0;
  let facturesEnAttente = 0;
  for (const doc of documentsAujourdhui) {
    parType.set(doc.type, (parType.get(doc.type) || 0) + 1);
    if (doc.type === "facture") {
      if (doc.statutDext === "envoye") facturesEnvoyees++;
      else if (doc.statutDext === "a_valider") facturesEnAttente++;
    }
  }

  const anomaliesAujourdhui = await prisma.anomalie.count({ where: { createdAt: { gte: debutJour } } });
  const anomaliesOuvertesTotal = await prisma.anomalie.count({ where: { statut: "a_valider" } });

  const transfertAutoActif = process.env.DEXT_AUTO_FORWARD !== "false";

  const lignes: string[] = [];
  lignes.push(`Recapitulatif du ${maintenant.toLocaleDateString("fr-FR")} - Copilote Atelier Brochant`);
  lignes.push("");
  lignes.push("== Chiffres du jour ==");
  lignes.push(`CA de la veille (${dashboard.dateVeille}) : ${dashboard.caVeille.toFixed(2)} EUR`);
  lignes.push(`Impayes en cours : ${dashboard.impayes.nombre} facture(s), ${dashboard.impayes.montantTotal.toFixed(2)} EUR`);
  lignes.push("");
  lignes.push("== Documents recus aujourd'hui (Gmail) ==");
  if (documentsAujourdhui.length === 0) {
    lignes.push("Aucun document recu aujourd'hui.");
  } else {
    for (const [type, nombre] of parType) {
      lignes.push(`- ${nombre} ${LIBELLES_TYPE[type] || type}`);
    }
    if (parType.get("facture")) {
      if (transfertAutoActif) {
        lignes.push(`  dont ${facturesEnvoyees} transferee(s) automatiquement vers Dext.`);
      } else {
        lignes.push(
          `  dont ${facturesEnAttente} mise(s) de cote (transfert automatique en pause) : ` +
            "a retrouver dans Gmail sous le libelle \"Copilote/Factures a transferer\", a transmettre vous-meme."
        );
      }
    }
  }
  lignes.push("");
  lignes.push("== Points necessitant votre attention ==");
  if (anomaliesOuvertesTotal === 0) {
    lignes.push("Aucun document en attente de validation.");
  } else {
    lignes.push(
      `${anomaliesOuvertesTotal} document(s) en attente de validation au total` +
        (anomaliesAujourdhui > 0 ? ` (dont ${anomaliesAujourdhui} recu(s) aujourd'hui).` : ".")
    );
    lignes.push("A consulter dans le centre de validation de l'application.");
  }
  if (dashboard.aValiderImports > 0) {
    lignes.push(`${dashboard.aValiderImports} import(s) CSV a verifier (type non reconnu, partiel ou en echec).`);
  }
  lignes.push("");
  lignes.push(
    transfertAutoActif
      ? "Transfert automatique vers Dext : actif."
      : "Transfert automatique vers Dext : en pause (periode d'observation)."
  );

  return lignes.join("\n");
}

/**
 * Envoie le recapitulatif quotidien a la boite Gmail connectee elle-meme
 * (pas de destinataire distinct a configurer : c'est deja l'adresse que
 * l'utilisateur consulte). Ne fait rien si aucune boite n'est connectee.
 */
export async function envoyerRecapQuotidien(prisma: PrismaClient, maintenant: Date = new Date()): Promise<void> {
  const connexionGmail = await getGmailClient(prisma);
  if (!connexionGmail) return; // rien a envoyer tant que Gmail n'est pas connecte

  const { gmail, connexion } = connexionGmail;
  const contenu = await construireRecapQuotidien(prisma, maintenant);

  const composer = new MailComposer({
    to: connexion.compteEmail,
    subject: `Recapitulatif du ${maintenant.toLocaleDateString("fr-FR")} - Copilote Atelier Brochant`,
    text: contenu,
  });
  const message = await composer.compile().build();
  const raw = message.toString("base64url");
  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });

  await logEvenement(prisma, {
    evenement: "recap_quotidien_envoye",
    action: `Recapitulatif quotidien envoye a ${connexion.compteEmail}`,
    resultat: "Envoi reussi.",
  });
}
