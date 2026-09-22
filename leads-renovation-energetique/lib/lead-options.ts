// Libellés et valeurs des options du questionnaire de qualification.
// Centralisés ici pour rester identiques entre le formulaire (client),
// la validation (serveur) et l'affichage des leads.

export const TYPES_LOGEMENT = [
  { value: "maison", label: "Maison" },
  { value: "appartement", label: "Appartement" },
] as const;

export const STATUTS_OCCUPANT = [
  { value: "proprietaire_occupant", label: "Propriétaire occupant" },
  { value: "bailleur", label: "Bailleur (je loue mon logement)" },
  { value: "autre", label: "Autre situation" },
] as const;

export const TRAVAUX = [
  { value: "isolation", label: "Isolation" },
  { value: "pompe_a_chaleur", label: "Pompe à chaleur" },
  { value: "chauffage", label: "Chauffage" },
  { value: "fenetres", label: "Fenêtres" },
  { value: "renovation_globale", label: "Rénovation globale" },
  { value: "ne_sait_pas", label: "Je ne sais pas encore" },
] as const;

export const SURFACES = [
  { value: "moins_60", label: "Moins de 60 m²" },
  { value: "60_100", label: "60 à 100 m²" },
  { value: "100_150", label: "100 à 150 m²" },
  { value: "plus_150", label: "Plus de 150 m²" },
] as const;

export const DELAIS = [
  { value: "immediat", label: "Le plus vite possible" },
  { value: "3_mois", label: "Dans les 3 mois" },
  { value: "6_mois", label: "Dans les 6 mois" },
  { value: "en_reflexion", label: "Je me renseigne pour l'instant" },
] as const;

export type TravauxValue = (typeof TRAVAUX)[number]["value"];

export function labelFor<T extends { value: string; label: string }>(
  options: readonly T[],
  value: string
): string {
  return options.find((o) => o.value === value)?.label ?? value;
}
