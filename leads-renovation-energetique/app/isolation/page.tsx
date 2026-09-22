import type { Metadata } from "next";
import { SolutionLanding } from "@/components/sections/solution-landing";

export const metadata: Metadata = {
  title: "Isolation thermique — Étude gratuite",
  description:
    "Combles, murs, sols : isolez votre logement pour réduire vos factures d'énergie. Étude gratuite et sans engagement.",
};

export default function IsolationPage() {
  return (
    <SolutionLanding
      travaux="isolation"
      heroTitle="Isolez votre logement pour réduire vos factures d'énergie"
      heroSubtitle="Combles, murs, sols : la première source de déperdition de chaleur d'un logement mal isolé."
      heroBullets={[
        "Diagnostic gratuit des zones à isoler en priorité",
        "Matériaux et techniques adaptés à votre logement",
        "Pose par des artisans qualifiés RGE",
      ]}
      benefits={[
        {
          title: "Moins de pertes de chaleur",
          description: "Jusqu'à 30 % des déperditions de chaleur d'une maison mal isolée passent par la toiture.",
        },
        {
          title: "Plus de confort",
          description: "Une bonne isolation limite aussi les variations de température en été comme en hiver.",
        },
        {
          title: "Aides possibles",
          description: "Selon votre logement et vos revenus, votre projet peut être éligible à des aides publiques.",
        },
      ]}
    />
  );
}
