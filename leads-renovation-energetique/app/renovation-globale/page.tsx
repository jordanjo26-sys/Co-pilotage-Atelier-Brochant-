import type { Metadata } from "next";
import { SolutionLanding } from "@/components/sections/solution-landing";

export const metadata: Metadata = {
  title: "Rénovation énergétique globale — Étude gratuite",
  description:
    "Isolation, chauffage, ventilation : un plan de travaux complet pour transformer durablement votre logement. Étude gratuite et sans engagement.",
};

export default function RenovationGlobalePage() {
  return (
    <SolutionLanding
      travaux="renovation_globale"
      heroTitle="Un plan de rénovation complet pour votre logement"
      heroSubtitle="Isolation, chauffage, ventilation : combinez plusieurs travaux pour un gain énergétique maximal."
      heroBullets={[
        "Étude globale de votre logement, pièce par pièce",
        "Plan de travaux priorisé selon votre budget",
        "Un seul interlocuteur pour coordonner votre projet",
      ]}
      benefits={[
        {
          title: "Gain énergétique maximal",
          description: "Combiner plusieurs travaux permet souvent un gain de performance plus important que des travaux isolés.",
        },
        {
          title: "Un projet coordonné",
          description: "Un plan de travaux cohérent, réalisé dans le bon ordre par des professionnels qualifiés RGE.",
        },
        {
          title: "Aides possibles",
          description: "Une rénovation globale peut ouvrir droit à des aides spécifiques, évaluées après étude de votre dossier.",
        },
      ]}
    />
  );
}
