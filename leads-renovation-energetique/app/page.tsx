import { Hero } from "@/components/sections/hero";
import { SolutionsGrid } from "@/components/sections/solutions-grid";
import { HowItWorks } from "@/components/sections/how-it-works";
import { AidesSection } from "@/components/sections/aides-section";
import { Reassurance } from "@/components/sections/reassurance";
import { Faq } from "@/components/sections/faq";
import { LeadForm } from "@/components/lead-form/lead-form";

export default function Home() {
  return (
    <>
      <Hero
        title="Réduisez vos factures d'énergie grâce à la rénovation énergétique de votre logement"
        subtitle="Isolation, pompe à chaleur, chauffage, rénovation globale..."
        bullets={[
          "Étude personnalisée et gratuite de votre logement",
          "Solutions adaptées à votre budget et à vos besoins",
          "Mise en relation avec des professionnels qualifiés RGE",
        ]}
      />

      <SolutionsGrid />
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
        <LeadForm />
      </section>
    </>
  );
}
