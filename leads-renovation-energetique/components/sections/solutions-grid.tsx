import Link from "next/link";

const SOLUTIONS = [
  {
    title: "Isolation",
    description: "Combles, murs, sols : réduisez les déperditions de chaleur de votre logement.",
    href: "/isolation",
    icon: "🧱",
  },
  {
    title: "Pompe à chaleur",
    description: "Remplacez une chaudière énergivore par un chauffage plus économe.",
    href: "/pompe-a-chaleur",
    icon: "🔥",
  },
  {
    title: "Chauffage",
    description: "Chaudière, radiateurs, régulation : adaptez votre système de chauffage.",
    href: "#etude",
    icon: "🌡️",
  },
  {
    title: "Fenêtres",
    description: "Le double vitrage limite les pertes de chaleur et les nuisances sonores.",
    href: "#etude",
    icon: "🪟",
  },
  {
    title: "Rénovation globale",
    description: "Un plan de travaux complet pour transformer durablement votre logement.",
    href: "/renovation-globale",
    icon: "🏡",
  },
];

export function SolutionsGrid() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <h2 className="text-2xl font-bold text-ink sm:text-3xl">
        Les solutions de rénovation énergétique
      </h2>
      <p className="mt-2 max-w-2xl text-ink/70">
        Chaque logement est différent : nos conseillers identifient avec vous
        les travaux les plus pertinents pour votre situation.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SOLUTIONS.map((solution) => (
          <Link
            key={solution.title}
            href={solution.href}
            className="group rounded-2xl border border-black/10 bg-white p-5 transition-shadow hover:shadow-md"
          >
            <span className="text-3xl" aria-hidden="true">
              {solution.icon}
            </span>
            <h3 className="mt-3 text-lg font-semibold text-ink">{solution.title}</h3>
            <p className="mt-1 text-sm text-ink/60">{solution.description}</p>
            <span className="mt-3 inline-block text-sm font-semibold text-primary group-hover:underline">
              En savoir plus →
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
