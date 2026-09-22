import { Hero } from "@/components/sections/hero";
import { HowItWorks } from "@/components/sections/how-it-works";
import { AidesSection } from "@/components/sections/aides-section";
import { Reassurance } from "@/components/sections/reassurance";
import { Faq } from "@/components/sections/faq";
import { LeadForm } from "@/components/lead-form/lead-form";
import type { TravauxValue } from "@/lib/lead-options";

interface SolutionLandingProps {
  travaux: TravauxValue;
  heroTitle: string;
  heroSubtitle: string;
  heroBullets: string[];
  benefits: { title: string; description: string }[];
}

// Gabarit commun aux landing pages publicitaires dédiées (une par type de
// travaux) : même structure de conversion que la page d'accueil, mais un
// message et une question "travaux" pré-répondue en cohérence avec
// l'annonce qui a amené le visiteur ici (cf. cahier des charges).
export function SolutionLanding({
  travaux,
  heroTitle,
  heroSubtitle,
  heroBullets,
  benefits,
}: SolutionLandingProps) {
  return (
    <>
      <Hero title={heroTitle} subtitle={heroSubtitle} bullets={heroBullets} />

      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="grid gap-6 sm:grid-cols-3">
          {benefits.map((benefit) => (
            <div key={benefit.title} className="rounded-2xl border border-black/10 bg-white p-5">
              <h3 className="font-semibold text-ink">{benefit.title}</h3>
              <p className="mt-1 text-sm text-ink/60">{benefit.description}</p>
            </div>
          ))}
        </div>
      </section>

      <HowItWorks />
      <AidesSection />
      <Reassurance />
      <Faq />

      <section className="mx-auto max-w-2xl px-4 pb-16 sm:px-6">
        <h2 className="mb-1 text-center text-2xl font-bold text-ink sm:text-3xl">
          Vérifiez votre projet en 2 minutes
        </h2>
        <p className="mb-6 text-center text-ink/70">
          Répondez à quelques questions, un conseiller vous recontacte
          rapidement.
        </p>
        <LeadForm defaultTravaux={travaux} />
      </section>
    </>
  );
}
