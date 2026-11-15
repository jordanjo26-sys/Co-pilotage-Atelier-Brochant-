import { PrismaClient } from "@prisma/client";
import { parseCsvBuffer, normalizeHeader } from "../../importers/csvUtils";
import { sha256Hex } from "../hash";
import { logEvenement } from "../journalService";

/**
 * Module de sourcing (section 2.1 du cahier des charges prospection) :
 * import manuel d'un fichier CSV (export d'un annuaire, copie d'une liste
 * existante...) et ajout au coup par coup. La recherche automatisee par API
 * (Google Places, Pages Jaunes, Pappers - section 4) reste a brancher une
 * fois un fournisseur et une cle retenus avec le developpeur (section 7) :
 * voir rechercherEntreprises() plus bas, deja structuree pour ca.
 */

export interface ProspectRowError {
  ligne: number;
  message: string;
}

export interface ImportProspectsSummary {
  fichierNom: string;
  statut: "ok" | "partiel" | "echec" | "doublon_fichier";
  nbLignes: number;
  nbNouveaux: number;
  nbDoublons: number;
  nbErreurs: number;
  erreurs: ProspectRowError[];
  importId: string;
}

// Intitules de colonnes acceptes (normalises : minuscule, sans accent) pour
// chaque champ du CSV de sourcing. Plusieurs alias couvrent les exports
// d'annuaires professionnels les plus courants sans imposer un format unique.
const COLUMN_ALIASES: Record<string, string[]> = {
  type: ["type", "type de prospect", "categorie"],
  entreprise: ["entreprise", "societe", "raison sociale", "nom"],
  contactNom: ["contact", "nom du contact", "contact nom"],
  contactFonction: ["fonction", "poste", "contact fonction"],
  email: ["email", "e mail", "mail", "adresse email"],
  telephone: ["telephone", "tel", "tel fixe", "telephone fixe"],
  siteWeb: ["site web", "site", "site internet", "www"],
  adresse: ["adresse", "adresse postale"],
  codePostal: ["code postal", "cp"],
  ville: ["ville", "commune"],
  marqueProposee: ["marque", "marque proposee"],
  serviceCible: ["service", "service cible"],
  notes: ["notes", "commentaire", "commentaires"],
};

function resolveColumns(normalizedHeaders: string[], headers: string[]): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = normalizedHeaders.findIndex((h) => aliases.includes(h));
    if (idx !== -1) resolved[field] = headers[idx];
  }
  return resolved;
}

function normalizeType(raw: string | undefined): string | null {
  const v = (raw || "").trim().toLowerCase();
  if (!v) return null;
  if (v.startsWith("assur")) return "assurance";
  if (v.startsWith("syndic") || v.startsWith("gestion")) return "syndic";
  return v;
}

function normalizeMarque(raw: string | undefined): string | null {
  const v = (raw || "").trim().toLowerCase();
  if (!v) return null;
  if (v.includes("degorgement")) return "france_degorgement";
  if (v.includes("brochant")) return "atelier_brochant";
  return v;
}

/**
 * Importe un CSV de prospects (section 2.1). Dedoublonnage a deux niveaux,
 * comme le reste de l'application : au niveau du fichier (hash, meme
 * logique que ImportBatch) puis au niveau de chaque ligne (entreprise +
 * email, contrainte unique portee par le modele Prospect).
 */
export async function importerProspectsCsv(
  prisma: PrismaClient,
  fichierNom: string,
  buffer: Buffer
): Promise<ImportProspectsSummary> {
  const hashFichier = sha256Hex(buffer);

  const dejaImporte = await prisma.prospectionImport.findUnique({ where: { hashFichier } });
  if (dejaImporte) {
    return {
      fichierNom,
      statut: "doublon_fichier",
      nbLignes: dejaImporte.nbLignes,
      nbNouveaux: 0,
      nbDoublons: dejaImporte.nbLignes,
      nbErreurs: 0,
      erreurs: [],
      importId: dejaImporte.id,
    };
  }

  const { headers, normalizedHeaders, rows } = parseCsvBuffer(buffer);

  if (headers.length === 0) {
    const importBatch = await prisma.prospectionImport.create({
      data: { fichierNom, hashFichier, nbLignes: 0 },
    });
    return {
      fichierNom,
      statut: "echec",
      nbLignes: 0,
      nbNouveaux: 0,
      nbDoublons: 0,
      nbErreurs: 1,
      erreurs: [{ ligne: 0, message: "Fichier vide ou illisible." }],
      importId: importBatch.id,
    };
  }

  const columns = resolveColumns(normalizedHeaders, headers);
  if (!columns.entreprise) {
    const importBatch = await prisma.prospectionImport.create({
      data: { fichierNom, hashFichier, nbLignes: rows.length, details: JSON.stringify({ headers }) },
    });
    return {
      fichierNom,
      statut: "echec",
      nbLignes: rows.length,
      nbNouveaux: 0,
      nbDoublons: 0,
      nbErreurs: 1,
      erreurs: [{ ligne: 0, message: `Colonne "entreprise" introuvable. Colonnes disponibles : ${headers.join(", ")}.` }],
      importId: importBatch.id,
    };
  }

  const importBatch = await prisma.prospectionImport.create({
    data: { fichierNom, hashFichier, nbLignes: rows.length },
  });

  let nbNouveaux = 0;
  let nbDoublons = 0;
  const erreurs: ProspectRowError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const ligne = i + 2;
    try {
      const entreprise = columns.entreprise ? row[columns.entreprise]?.trim() : "";
      if (!entreprise) {
        erreurs.push({ ligne, message: "Nom d'entreprise manquant." });
        continue;
      }
      const email = columns.email ? row[columns.email]?.trim() || null : null;

      // Postgres traite NULL comme distinct de tout autre NULL : la
      // contrainte unique (entreprise, email) ne bloque donc pas deux
      // lignes "meme entreprise, pas d'email" importees separement. On
      // cherche explicitement ce cas en plus du findUnique standard.
      const doublon = email
        ? await prisma.prospect.findUnique({ where: { entreprise_email: { entreprise, email } } })
        : await prisma.prospect.findFirst({ where: { entreprise, email: null } });

      if (doublon) {
        nbDoublons++;
        continue;
      }

      await prisma.prospect.create({
        data: {
          type: normalizeType(columns.type ? row[columns.type] : undefined) || "syndic",
          entreprise,
          contactNom: columns.contactNom ? row[columns.contactNom]?.trim() || null : null,
          contactFonction: columns.contactFonction ? row[columns.contactFonction]?.trim() || null : null,
          email,
          emailSource: email ? "import" : null,
          telephone: columns.telephone ? row[columns.telephone]?.trim() || null : null,
          siteWeb: columns.siteWeb ? row[columns.siteWeb]?.trim() || null : null,
          adresse: columns.adresse ? row[columns.adresse]?.trim() || null : null,
          codePostal: columns.codePostal ? row[columns.codePostal]?.trim() || null : null,
          ville: columns.ville ? row[columns.ville]?.trim() || null : null,
          marqueProposee: normalizeMarque(columns.marqueProposee ? row[columns.marqueProposee] : undefined),
          serviceCible: columns.serviceCible ? row[columns.serviceCible]?.trim() || null : null,
          notes: columns.notes ? row[columns.notes]?.trim() || null : null,
          source: "import_csv",
          sourceImportId: importBatch.id,
          historiqueStatuts: { create: { nouveauStatut: "a_contacter" } },
        },
      });
      nbNouveaux++;
    } catch (err) {
      erreurs.push({ ligne, message: (err as Error).message });
    }
  }

  const statut: ImportProspectsSummary["statut"] =
    erreurs.length === 0 ? "ok" : nbNouveaux + nbDoublons > 0 ? "partiel" : "echec";

  await prisma.prospectionImport.update({
    where: { id: importBatch.id },
    data: {
      nbNouveaux,
      nbDoublons,
      nbErreurs: erreurs.length,
      details: erreurs.length > 0 ? JSON.stringify(erreurs) : null,
    },
  });

  await logEvenement(prisma, {
    evenement: "import_prospects",
    action: `Depot de ${fichierNom} (sourcing prospection)`,
    resultat: `${nbNouveaux} nouveau(x), ${nbDoublons} doublon(s), ${erreurs.length} erreur(s).`,
  });

  return { fichierNom, statut, nbLignes: rows.length, nbNouveaux, nbDoublons, nbErreurs: erreurs.length, erreurs, importId: importBatch.id };
}

export interface AjoutProspectManuel {
  type: string;
  entreprise: string;
  contactNom?: string;
  contactFonction?: string;
  email?: string;
  telephone?: string;
  siteWeb?: string;
  adresse?: string;
  codePostal?: string;
  ville?: string;
  marqueProposee?: string;
  serviceCible?: string;
  notes?: string;
}

/** Ajout manuel d'une fiche (section 2.1 : "import manuel possible (ajout a la main...)"). */
export async function ajouterProspectManuel(prisma: PrismaClient, data: AjoutProspectManuel) {
  if (!data.entreprise?.trim()) throw new Error("Le nom de l'entreprise est obligatoire.");

  return prisma.prospect.create({
    data: {
      type: data.type || "syndic",
      entreprise: data.entreprise.trim(),
      contactNom: data.contactNom?.trim() || null,
      contactFonction: data.contactFonction?.trim() || null,
      email: data.email?.trim() || null,
      emailSource: data.email?.trim() ? "manuel" : null,
      telephone: data.telephone?.trim() || null,
      siteWeb: data.siteWeb?.trim() || null,
      adresse: data.adresse?.trim() || null,
      codePostal: data.codePostal?.trim() || null,
      ville: data.ville?.trim() || null,
      marqueProposee: data.marqueProposee || null,
      serviceCible: data.serviceCible?.trim() || null,
      notes: data.notes?.trim() || null,
      source: "manuel",
      historiqueStatuts: { create: { nouveauStatut: "a_contacter" } },
    },
  });
}

export interface EntrepriseTrouvee {
  entreprise: string;
  adresse?: string;
  telephone?: string;
  siteWeb?: string;
  codePostal?: string;
  ville?: string;
}

/**
 * Recherche automatisee par mot-cle + zone (section 2.1 et section 4 :
 * "API Google Places, ou annuaires professionnels"). Aucune cle retenue a
 * ce stade (point a arbitrer avec le developpeur - section 7) : cette
 * fonction reste desactivee tant que GOOGLE_PLACES_API_KEY est absente,
 * plutot que de simuler des resultats. Une fois une cle fournie, brancher
 * ici l'appel a l'API Places "Text Search" (googleapis n'est pas necessaire,
 * un simple fetch vers l'endpoint REST suffit) et mapper sa reponse vers
 * EntrepriseTrouvee.
 */
export async function rechercherEntreprises(motCle: string, zone: string): Promise<EntrepriseTrouvee[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GOOGLE_PLACES_API_KEY absente : la recherche automatisee de prospects n'est pas encore activee " +
        "(point 7 du cahier des charges, a arbitrer avec le developpeur). Utiliser l'import CSV ou l'ajout manuel en attendant."
    );
  }

  const query = encodeURIComponent(`${motCle} ${zone}`);
  const url = `https://places.googleapis.com/v1/places:searchText`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri",
    },
    body: JSON.stringify({ textQuery: `${motCle} ${zone}` }),
  });

  if (!response.ok) {
    throw new Error(`Recherche Google Places echouee (HTTP ${response.status}) pour la requete "${motCle} ${zone}" (${query}).`);
  }

  const data = (await response.json()) as {
    places?: { displayName?: { text?: string }; formattedAddress?: string; nationalPhoneNumber?: string; websiteUri?: string }[];
  };

  return (data.places || []).map((p) => ({
    entreprise: p.displayName?.text || "",
    adresse: p.formattedAddress,
    telephone: p.nationalPhoneNumber,
    siteWeb: p.websiteUri,
  }));
}

export interface AvisGooglePlace {
  auteur: string | null;
  note: number | null;
  texte: string | null;
  datePublication: string | null;
}

export interface FicheGooglePlace {
  nom: string;
  adresse: string | null;
  note: number | null;
  nombreAvisTotal: number | null;
  avis: AvisGooglePlace[];
}

/**
 * Recupere la fiche Google (note globale + jusqu'a 5 avis, limite connue et
 * documentee de l'API Places "Place Details") pour une entreprise, via
 * GOOGLE_PLACES_API_KEY (meme cle que rechercherEntreprises ci-dessus,
 * reutilisee ici pour une demande distincte de l'utilisateur : remplacer
 * les avis d'exemple du site par de vrais avis Google plutot que d'en
 * afficher de faux, ce qui est illegal - voir docs/architecture.md).
 * Jamais plus de 5 avis : limite imposee par Google lui-meme, pas une
 * restriction de ce code.
 */
export async function obtenirFicheGooglePlace(nomEntreprise: string, zone?: string): Promise<FicheGooglePlace> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_PLACES_API_KEY absente : impossible de recuperer la fiche Google.");
  }

  const texteRecherche = zone ? `${nomEntreprise} ${zone}` : nomEntreprise;
  const rechercheReponse = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress",
    },
    body: JSON.stringify({ textQuery: texteRecherche }),
  });
  if (!rechercheReponse.ok) {
    throw new Error(`Recherche Google Places echouee (HTTP ${rechercheReponse.status}) pour "${texteRecherche}".`);
  }
  const rechercheDonnees = (await rechercheReponse.json()) as {
    places?: { id?: string; displayName?: { text?: string }; formattedAddress?: string }[];
  };
  const lieu = (rechercheDonnees.places || [])[0];
  if (!lieu?.id) {
    throw new Error(`Aucun etablissement Google trouve pour "${texteRecherche}".`);
  }

  const detailsReponse = await fetch(`https://places.googleapis.com/v1/places/${lieu.id}`, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "displayName,formattedAddress,rating,userRatingCount,reviews",
    },
  });
  if (!detailsReponse.ok) {
    throw new Error(`Lecture de la fiche Google Places echouee (HTTP ${detailsReponse.status}) pour "${lieu.displayName?.text}".`);
  }
  const details = (await detailsReponse.json()) as {
    displayName?: { text?: string };
    formattedAddress?: string;
    rating?: number;
    userRatingCount?: number;
    reviews?: { authorAttribution?: { displayName?: string }; rating?: number; text?: { text?: string }; publishTime?: string }[];
  };

  return {
    nom: details.displayName?.text || lieu.displayName?.text || nomEntreprise,
    adresse: details.formattedAddress || lieu.formattedAddress || null,
    note: details.rating ?? null,
    nombreAvisTotal: details.userRatingCount ?? null,
    avis: (details.reviews || []).map((r) => ({
      auteur: r.authorAttribution?.displayName ?? null,
      note: r.rating ?? null,
      texte: r.text?.text ?? null,
      datePublication: r.publishTime ?? null,
    })),
  };
}
