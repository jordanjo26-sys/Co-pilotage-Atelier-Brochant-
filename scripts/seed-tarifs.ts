/**
 * Initialise le tarifier (plomberie / electricite / serrurerie) avec des prix
 * INDICATIFS DE MARCHE (France, ordre de grandeur), pas des tarifs reels
 * fournisseur : Cedeo, La Plateforme du Batiment, Foussier et Richardson sont
 * des enseignes reservees aux professionnels (compte + KBIS), dont les prix
 * sont masques sans connexion et dont les sites bloquent de toute facon
 * l'acces automatise. Chaque ligne est marquee `source: "estimation_marche"`
 * et doit etre verifiee/ajustee avec vos propres comptes fournisseurs avant
 * d'etre utilisee telle quelle pour un devis client (bouton "Modifier" dans
 * la section Tarifier de l'interface, ou re-executer ce script apres avoir
 * ajuste ce fichier).
 *
 * Idempotent : upsert sur (metier, designation), donc rejouable sans creer
 * de doublons apres correction des montants ci-dessous.
 *
 * Usage : npm run seed:tarifs
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface LigneTarif {
  metier: "plomberie" | "electricite" | "serrurerie";
  categorie: string;
  designation: string;
  unite: string;
  prixMateriel: number | null;
  prixMainOeuvre: number | null;
  prixVenteHT: number;
  fournisseurRef: string | null;
  notes?: string;
}

const TARIFS: LigneTarif[] = [
  // --- Plomberie ---------------------------------------------------------
  { metier: "plomberie", categorie: "Depannage", designation: "Deplacement + diagnostic (zone locale)", unite: "forfait", prixMateriel: null, prixMainOeuvre: 45, prixVenteHT: 65, fournisseurRef: null },
  { metier: "plomberie", categorie: "Depannage", designation: "Intervention fuite d'eau simple (raccord, joint)", unite: "forfait", prixMateriel: 15, prixMainOeuvre: 70, prixVenteHT: 110, fournisseurRef: "Cedeo" },
  { metier: "plomberie", categorie: "Depannage", designation: "Debouchage canalisation (furet manuel)", unite: "forfait", prixMateriel: 5, prixMainOeuvre: 75, prixVenteHT: 120, fournisseurRef: null },
  { metier: "plomberie", categorie: "Depannage", designation: "Debouchage canalisation (furet electrique / haute pression)", unite: "forfait", prixMateriel: 10, prixMainOeuvre: 110, prixVenteHT: 180, fournisseurRef: null },
  { metier: "plomberie", categorie: "Robinetterie", designation: "Remplacement mitigeur evier/lavabo (hors fourniture haut de gamme)", unite: "u", prixMateriel: 60, prixMainOeuvre: 60, prixVenteHT: 160, fournisseurRef: "Cedeo" },
  { metier: "plomberie", categorie: "Robinetterie", designation: "Remplacement mitigeur thermostatique douche/baignoire", unite: "u", prixMateriel: 120, prixMainOeuvre: 90, prixVenteHT: 280, fournisseurRef: "Cedeo" },
  { metier: "plomberie", categorie: "Robinetterie", designation: "Remplacement flexible/joint de robinet", unite: "u", prixMateriel: 8, prixMainOeuvre: 30, prixVenteHT: 55, fournisseurRef: "Richardson" },
  { metier: "plomberie", categorie: "Sanitaire", designation: "Remplacement mecanisme chasse d'eau (WC)", unite: "u", prixMateriel: 25, prixMainOeuvre: 45, prixVenteHT: 95, fournisseurRef: "La Plateforme du Batiment" },
  { metier: "plomberie", categorie: "Sanitaire", designation: "Remplacement WC complet (bati apparent)", unite: "u", prixMateriel: 150, prixMainOeuvre: 180, prixVenteHT: 420, fournisseurRef: "La Plateforme du Batiment" },
  { metier: "plomberie", categorie: "Sanitaire", designation: "Pose lavabo/vasque sur meuble existant", unite: "u", prixMateriel: 90, prixMainOeuvre: 120, prixVenteHT: 290, fournisseurRef: "Cedeo" },
  { metier: "plomberie", categorie: "Chauffe-eau", designation: "Remplacement groupe de securite chauffe-eau", unite: "u", prixMateriel: 20, prixMainOeuvre: 60, prixVenteHT: 115, fournisseurRef: "Cedeo" },
  { metier: "plomberie", categorie: "Chauffe-eau", designation: "Remplacement chauffe-eau electrique 200L (hors depose ancien)", unite: "u", prixMateriel: 350, prixMainOeuvre: 220, prixVenteHT: 780, fournisseurRef: "Cedeo" },
  { metier: "plomberie", categorie: "Chauffe-eau", designation: "Detartrage ballon d'eau chaude", unite: "forfait", prixMateriel: 10, prixMainOeuvre: 90, prixVenteHT: 150, fournisseurRef: null },
  { metier: "plomberie", categorie: "Tuyauterie", designation: "Remplacement section de tube cuivre (par metre, fourniture + pose)", unite: "ml", prixMateriel: 12, prixMainOeuvre: 25, prixVenteHT: 48, fournisseurRef: "Foussier" },
  { metier: "plomberie", categorie: "Tuyauterie", designation: "Remplacement section de tube PER (par metre, fourniture + pose)", unite: "ml", prixMateriel: 6, prixMainOeuvre: 20, prixVenteHT: 36, fournisseurRef: "Foussier" },
  { metier: "plomberie", categorie: "Main d'oeuvre", designation: "Heure de main d'oeuvre plombier (hors deplacement)", unite: "heure", prixMateriel: null, prixMainOeuvre: 55, prixVenteHT: 65, fournisseurRef: null },

  // --- Electricite ---------------------------------------------------------
  { metier: "electricite", categorie: "Depannage", designation: "Deplacement + diagnostic panne electrique", unite: "forfait", prixMateriel: null, prixMainOeuvre: 45, prixVenteHT: 65, fournisseurRef: null },
  { metier: "electricite", categorie: "Depannage", designation: "Recherche de panne / court-circuit", unite: "forfait", prixMateriel: null, prixMainOeuvre: 90, prixVenteHT: 140, fournisseurRef: null },
  { metier: "electricite", categorie: "Tableau electrique", designation: "Remplacement disjoncteur divisionnaire", unite: "u", prixMateriel: 15, prixMainOeuvre: 35, prixVenteHT: 70, fournisseurRef: "Cedeo" },
  { metier: "electricite", categorie: "Tableau electrique", designation: "Remplacement interrupteur differentiel", unite: "u", prixMateriel: 45, prixMainOeuvre: 50, prixVenteHT: 130, fournisseurRef: "Cedeo" },
  { metier: "electricite", categorie: "Tableau electrique", designation: "Mise aux normes tableau electrique (logement T2/T3, hors cablage)", unite: "forfait", prixMateriel: 350, prixMainOeuvre: 450, prixVenteHT: 950, fournisseurRef: "Cedeo" },
  { metier: "electricite", categorie: "Prises & interrupteurs", designation: "Remplacement prise de courant simple", unite: "u", prixMateriel: 8, prixMainOeuvre: 30, prixVenteHT: 55, fournisseurRef: "Cedeo" },
  { metier: "electricite", categorie: "Prises & interrupteurs", designation: "Ajout prise de courant (sur circuit existant)", unite: "u", prixMateriel: 15, prixMainOeuvre: 60, prixVenteHT: 110, fournisseurRef: "Cedeo" },
  { metier: "electricite", categorie: "Prises & interrupteurs", designation: "Remplacement interrupteur simple/va-et-vient", unite: "u", prixMateriel: 8, prixMainOeuvre: 30, prixVenteHT: 55, fournisseurRef: "Cedeo" },
  { metier: "electricite", categorie: "Eclairage", designation: "Pose point lumineux plafond (sur circuit existant)", unite: "u", prixMateriel: 20, prixMainOeuvre: 65, prixVenteHT: 130, fournisseurRef: "Cedeo" },
  { metier: "electricite", categorie: "Eclairage", designation: "Remplacement luminaire (fourniture client)", unite: "u", prixMateriel: null, prixMainOeuvre: 40, prixVenteHT: 55, fournisseurRef: null },
  { metier: "electricite", categorie: "Chauffage electrique", designation: "Remplacement convecteur/radiateur electrique", unite: "u", prixMateriel: 130, prixMainOeuvre: 70, prixVenteHT: 260, fournisseurRef: "Cedeo" },
  { metier: "electricite", categorie: "Diagnostics", designation: "Diagnostic electrique reglementaire (logement, avant vente/location)", unite: "forfait", prixMateriel: null, prixMainOeuvre: null, prixVenteHT: 130, fournisseurRef: null, notes: "Realise par un diagnostiqueur certifie, pas par l'electricien lui-meme." },
  { metier: "electricite", categorie: "Main d'oeuvre", designation: "Heure de main d'oeuvre electricien (hors deplacement)", unite: "heure", prixMateriel: null, prixMainOeuvre: 55, prixVenteHT: 65, fournisseurRef: null },

  // --- Serrurerie ------------------------------------------------------------
  { metier: "serrurerie", categorie: "Depannage", designation: "Deplacement + diagnostic (heures ouvrees)", unite: "forfait", prixMateriel: null, prixMainOeuvre: 45, prixVenteHT: 65, fournisseurRef: null },
  { metier: "serrurerie", categorie: "Depannage", designation: "Ouverture de porte claquee (sans degat, heures ouvrees)", unite: "forfait", prixMateriel: null, prixMainOeuvre: 80, prixVenteHT: 130, fournisseurRef: null },
  { metier: "serrurerie", categorie: "Depannage", designation: "Ouverture de porte claquee (nuit / week-end / jour ferie)", unite: "forfait", prixMateriel: null, prixMainOeuvre: 150, prixVenteHT: 220, fournisseurRef: null },
  { metier: "serrurerie", categorie: "Depannage", designation: "Ouverture porte blindee (serrure multipoints)", unite: "forfait", prixMateriel: null, prixMainOeuvre: 180, prixVenteHT: 260, fournisseurRef: null },
  { metier: "serrurerie", categorie: "Serrures", designation: "Remplacement serrure standard 3 points", unite: "u", prixMateriel: 90, prixMainOeuvre: 90, prixVenteHT: 240, fournisseurRef: "Richardson" },
  { metier: "serrurerie", categorie: "Serrures", designation: "Remplacement serrure haute securite (A2P)", unite: "u", prixMateriel: 250, prixMainOeuvre: 120, prixVenteHT: 480, fournisseurRef: "Richardson" },
  { metier: "serrurerie", categorie: "Serrures", designation: "Remplacement cylindre simple", unite: "u", prixMateriel: 25, prixMainOeuvre: 40, prixVenteHT: 85, fournisseurRef: "Richardson" },
  { metier: "serrurerie", categorie: "Serrures", designation: "Reproduction de cle standard", unite: "u", prixMateriel: 3, prixMainOeuvre: 7, prixVenteHT: 12, fournisseurRef: "Richardson" },
  { metier: "serrurerie", categorie: "Serrures", designation: "Reproduction de cle securisee (carte proprietaire)", unite: "u", prixMateriel: 15, prixMainOeuvre: 10, prixVenteHT: 35, fournisseurRef: "Richardson" },
  { metier: "serrurerie", categorie: "Blindage", designation: "Blindage de porte (bloc-porte standard, kit)", unite: "forfait", prixMateriel: 600, prixMainOeuvre: 400, prixVenteHT: 1400, fournisseurRef: "Richardson" },
  { metier: "serrurerie", categorie: "Volets & rideaux", designation: "Reparation volet roulant manuel (sangle/enrouleur)", unite: "forfait", prixMateriel: 25, prixMainOeuvre: 70, prixVenteHT: 140, fournisseurRef: "La Plateforme du Batiment" },
  { metier: "serrurerie", categorie: "Main d'oeuvre", designation: "Heure de main d'oeuvre serrurier (hors deplacement, hors majoration urgence)", unite: "heure", prixMateriel: null, prixMainOeuvre: 60, prixVenteHT: 70, fournisseurRef: null },
];

async function main() {
  for (const ligne of TARIFS) {
    await prisma.tarifPrestation.upsert({
      where: { metier_designation: { metier: ligne.metier, designation: ligne.designation } },
      update: {
        categorie: ligne.categorie,
        unite: ligne.unite,
        prixMateriel: ligne.prixMateriel,
        prixMainOeuvre: ligne.prixMainOeuvre,
        prixVenteHT: ligne.prixVenteHT,
        fournisseurRef: ligne.fournisseurRef,
        notes: ligne.notes ?? null,
      },
      create: {
        metier: ligne.metier,
        categorie: ligne.categorie,
        designation: ligne.designation,
        unite: ligne.unite,
        prixMateriel: ligne.prixMateriel,
        prixMainOeuvre: ligne.prixMainOeuvre,
        prixVenteHT: ligne.prixVenteHT,
        fournisseurRef: ligne.fournisseurRef,
        source: "estimation_marche",
        notes: ligne.notes ?? null,
      },
    });
  }
  console.log(`${TARIFS.length} ligne(s) de tarifier initialisee(s)/mise(s) a jour.`);
}

main()
  .catch((err) => {
    console.error("Echec du seed du tarifier :", err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
