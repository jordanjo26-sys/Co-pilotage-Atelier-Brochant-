const fmtMontant = (n) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n || 0);

function definirMeta(id, texte) {
  const span = document.getElementById(id);
  if (span) span.textContent = texte;
}

// Chaque pole affiche un vrai chiffre issu des API existantes (jamais une
// valeur inventee) : si un appel echoue, sa carte garde juste sa description
// sans statistique plutot que d'afficher une erreur qui casse les autres.

async function chargerGestion() {
  try {
    const res = await fetch("/api/dashboard/summary");
    if (!res.ok) return;
    const data = await res.json();
    definirMeta(
      "meta-gestion",
      data.impayes.nombre > 0 ? `${data.impayes.nombre} facture(s) impayée(s) · ${fmtMontant(data.impayes.montantTotal)}` : "Aucun impayé en cours"
    );
  } catch {
    // carte conservee sans statistique
  }
}

async function chargerProspection() {
  try {
    const res = await fetch("/api/prospection/relances-dues");
    if (!res.ok) return;
    const relances = await res.json();
    definirMeta("meta-prospection", relances.length > 0 ? `${relances.length} relance(s) due(s)` : "Aucune relance due");
  } catch {
    // carte conservee sans statistique
  }
}

async function chargerDemandes() {
  try {
    const res = await fetch("/api/demandes-intervention?statut=a_saisir");
    if (!res.ok) return;
    const demandes = await res.json();
    definirMeta("meta-demandes", demandes.length > 0 ? `${demandes.length} demande(s) à saisir` : "Rien à saisir");
  } catch {
    // carte conservee sans statistique
  }
}

async function chargerAds() {
  try {
    const res = await fetch("/api/google-ads/dernier-import");
    if (!res.ok) return;
    const dernier = await res.json();
    definirMeta("meta-ads", dernier ? `Dernier import : ${new Date(dernier.importeLe).toLocaleDateString("fr-FR")}` : "Aucun import encore déposé");
  } catch {
    // carte conservee sans statistique
  }
}

async function chargerResultat() {
  try {
    const res = await fetch("/api/dashboard/ca-serie?granularite=mois");
    if (!res.ok) return;
    const serie = await res.json();
    const moisEnCours = serie[serie.length - 1];
    if (moisEnCours) definirMeta("meta-resultat", `CA du mois : ${fmtMontant(moisEnCours.montant)}`);
  } catch {
    // carte conservee sans statistique
  }
}

chargerGestion();
chargerProspection();
chargerDemandes();
chargerAds();
chargerResultat();
