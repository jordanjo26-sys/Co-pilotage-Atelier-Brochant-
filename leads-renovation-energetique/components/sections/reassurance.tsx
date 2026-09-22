const POINTS = [
  {
    title: "Professionnels qualifiés",
    description: "Mise en relation avec des artisans partenaires labellisés RGE.",
  },
  {
    title: "Étude gratuite et sans engagement",
    description: "Aucun frais pour évaluer votre projet et vos droits aux aides.",
  },
  {
    title: "Réponse rapide",
    description: "Un conseiller vous recontacte sous 48h ouvrées.",
  },
  {
    title: "Données protégées",
    description: "Vos informations ne sont utilisées que pour étudier votre projet.",
  },
];

// Remarque : pas d'avis clients affichés ici tant qu'aucun avis réel et
// vérifiable n'est disponible — mieux vaut ce bandeau de réassurance neutre
// qu'un témoignage fabriqué, qui serait trompeur pour vos prospects.
export function Reassurance() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {POINTS.map((point) => (
          <div key={point.title} className="text-center sm:text-left">
            <h3 className="font-semibold text-ink">{point.title}</h3>
            <p className="mt-1 text-sm text-ink/60">{point.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
