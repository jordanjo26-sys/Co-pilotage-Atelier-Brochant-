import type { Metadata } from "next";
import { SolutionLanding } from "@/components/sections/solution-landing";

export const metadata: Metadata = {
  title: "Installation de pompe à chaleur — Étude gratuite",
  description:
    "Remplacez votre chauffage par une pompe à chaleur adaptée à votre logement. Étude gratuite et sans engagement, aides possibles selon votre situation.",
};

export default function PompeAChaleurPage() {
  return (
    <SolutionLanding
      travaux="pompe_a_chaleur"
      heroTitle="Remplacez votre chauffage par une pompe à chaleur"
      heroSubtitle="Réduisez votre consommation d'énergie avec un chauffage plus performant, adapté à votre logement."
      heroBullets={[
        "Étude technique gratuite de votre logement",
        "Sélection d'un modèle adapté à votre surface et votre budget",
        "Pose par des installateurs qualifiés RGE",
      ]}
      benefits={[
        {
          title: "Moins de consommation",
          description: "Une pompe à chaleur consomme généralement moins qu'un chauffage électrique classique.",
        },
        {
          title: "Été comme hiver",
          description: "Certains modèles réversibles chauffent l'hiver et rafraîchissent l'été.",
        },
        {
          title: "Aides possibles",
          description: "Selon votre logement et vos revenus, votre projet peut être éligible à des aides publiques.",
        },
      ]}
    />
  );
}
