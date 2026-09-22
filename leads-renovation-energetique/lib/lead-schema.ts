import { z } from "zod";
import { TYPES_LOGEMENT, STATUTS_OCCUPANT, TRAVAUX, SURFACES, DELAIS } from "./lead-options";

const valuesOf = <T extends readonly { value: string }[]>(options: T) =>
  options.map((o) => o.value) as [T[number]["value"], ...T[number]["value"][]];

// Code postal français : 5 chiffres (DOM inclus, ex. 97400).
const codePostalRegex = /^[0-9]{5}$/;

// Validation volontairement tolérante sur le format du téléphone (mobile ou
// fixe, avec ou sans espaces/points) : on normalise plutôt que de rejeter.
const telephoneRegex = /^(?:\+33|0)[1-9](?:[ .-]?[0-9]{2}){4}$/;

export const leadSchema = z.object({
  typeLogement: z.enum(valuesOf(TYPES_LOGEMENT)),
  statutOccupant: z.enum(valuesOf(STATUTS_OCCUPANT)),
  travaux: z.enum(valuesOf(TRAVAUX)),
  surface: z.enum(valuesOf(SURFACES)),
  codePostal: z.string().regex(codePostalRegex, "Code postal invalide (5 chiffres)"),
  delaiTravaux: z.enum(valuesOf(DELAIS)),

  prenom: z.string().trim().min(1, "Prénom requis").max(80),
  nom: z.string().trim().min(1, "Nom requis").max(80),
  telephone: z
    .string()
    .trim()
    .regex(telephoneRegex, "Numéro de téléphone invalide"),
  email: z.string().trim().email("E-mail invalide"),

  consentement: z.literal(true, {
    error: "Vous devez accepter d'être contacté pour envoyer votre demande",
  }),

  // Traçabilité publicitaire — tous optionnels, absents en accès direct.
  source: z.string().max(100).optional(),
  campagne: z.string().max(200).optional(),
  support: z.string().max(100).optional(),
  contenuAnnonce: z.string().max(200).optional(),
  motCle: z.string().max(200).optional(),
  gclid: z.string().max(300).optional(),
  fbclid: z.string().max(300).optional(),
  pageOrigine: z.string().max(300).optional(),

  // Anti-spam : champ invisible, doit rester vide (voir HoneypotField).
  siteWeb: z.string().max(0, "Requête rejetée").optional().or(z.literal("")),
});

export type LeadInput = z.infer<typeof leadSchema>;

// Étapes du formulaire, utilisées pour valider progressivement côté client
// (un champ manquant à l'étape N ne bloque pas l'affichage de l'étape N).
export const STEP_FIELDS = [
  ["typeLogement"],
  ["statutOccupant"],
  ["travaux"],
  ["surface"],
  ["codePostal"],
  ["delaiTravaux"],
  ["prenom", "nom", "telephone", "email", "consentement"],
] as const;
