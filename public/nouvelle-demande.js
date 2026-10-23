const echapper = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDateHeure = (iso) => (iso ? new Date(iso).toLocaleString("fr-FR") : "—");
// Fixe sur Europe/Paris (contrairement a fmtDateHeure ci-dessus, qui suit
// le fuseau de l'appareil) : une date souhaitee par un client doit
// toujours s'afficher a l'heure de Paris, meme consultee depuis un
// telephone regle sur un autre fuseau - meme raisonnement que
// versDatetimeLocal plus bas.
const fmtDateHeureParis = (iso) => (iso ? new Date(iso).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }) : "—");

// "YYYY-MM-DDTHH:mm" attendu par <input type="datetime-local"> : construit
// a partir des composantes en heure de PARIS explicitement (jamais
// toISOString, ni les getters locaux de Date qui suivent le fuseau de
// l'appareil) - le serveur lit toujours la date saisie comme une heure de
// Paris (src/services/demandesIntervention.ts), donc la reafficher pour
// modification doit faire le chemin inverse avec le meme fuseau fixe,
// sinon l'heure affichee glisse selon le fuseau du telephone qui la
// consulte (repere en testant : 9h saisies -> 8h reaffichees quand le
// fuseau de l'appareil n'est pas Europe/Paris).
function versDatetimeLocal(iso) {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const valeur = (type) => parts.find((p) => p.type === type)?.value;
  return `${valeur("year")}-${valeur("month")}-${valeur("day")}T${valeur("hour")}:${valeur("minute")}`;
}

const LIBELLE_URGENCE = { faible: "Faible", normale: "Normale", urgente: "Urgente" };
const LIBELLE_SOURCE = { google: "Google", pages_jaunes: "Pages Jaunes", maps: "Maps" };
const LIBELLE_CATEGORIE = { plomberie: "Plomberie", serrurerie: "Serrurerie", electricite: "Électricité", assainissement: "Assainissement" };

async function appelApi(url, options) {
  const res = await fetch(url, options);
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json() : null;
  if (!res.ok) throw new Error(data?.erreur || `Erreur HTTP ${res.status}`);
  return data;
}

function adresseComplete(d) {
  return [d.adresse, [d.codePostal, d.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "—";
}

async function chargerDemandes() {
  const demandes = await appelApi("/api/demandes-intervention?statut=a_saisir");
  const conteneur = document.getElementById("liste-demandes");
  if (demandes.length === 0) {
    conteneur.innerHTML = '<p class="aide">Rien en attente : tout est à jour dans Synec.</p>';
    return;
  }
  conteneur.innerHTML = demandes
    .map(
      (d) => `
    <div class="fiche-prospect">
      <h3>${echapper(d.nom)} <span class="pastille-statut pastille-${echapper(d.urgence || "normale")}">${echapper(LIBELLE_URGENCE[d.urgence] || "Normale")}</span></h3>
      <div class="historique-ligne">Reçu le ${fmtDateHeure(d.createdAt)}</div>
      <div class="historique-ligne">Téléphone : ${echapper(d.telephone || "non donné")}</div>
      ${d.email ? `<div class="historique-ligne">E-mail : ${echapper(d.email)}</div>` : ""}
      <div class="historique-ligne">Adresse : ${echapper(adresseComplete(d))}${d.typeLogement ? ` (${echapper(d.typeLogement)}${d.etage ? ", étage " + echapper(d.etage) : ""}${d.codeAcces ? ", code " + echapper(d.codeAcces) : ""})` : ""}</div>
      ${d.dateSouhaitee ? `<div class="historique-ligne">Date souhaitée : ${fmtDateHeureParis(d.dateSouhaitee)}${d.dateSouhaiteeFin ? ` → ${fmtDateHeureParis(d.dateSouhaiteeFin)}` : ""}</div>` : ""}
      ${d.sourceAcquisition ? `<div class="historique-ligne">Source : ${echapper(LIBELLE_SOURCE[d.sourceAcquisition] || d.sourceAcquisition)}</div>` : ""}
      ${d.categorie ? `<div class="historique-ligne">Catégorie : ${echapper(LIBELLE_CATEGORIE[d.categorie] || d.categorie)}</div>` : ""}
      ${d.motif ? `<div class="historique-ligne">Motif : ${echapper(d.motif)}</div>` : ""}
      <div id="synec-erreur-${d.id}" class="historique-ligne" style="color:var(--critical)" hidden></div>
      <div class="ligne-boutons" style="margin-top:8px">
        <button type="button" data-envoyer-synec="${d.id}">Envoyer vers Synec</button>
        <button type="button" class="ghost" data-modifier="${d.id}">Modifier</button>
        <button type="button" class="ghost" data-marquer-saisie="${d.id}">Marquer comme saisie à la main</button>
      </div>
    </div>`
    )
    .join("");

  conteneur.querySelectorAll("[data-modifier]").forEach((bouton) => {
    bouton.addEventListener("click", () => {
      const demande = demandes.find((d) => d.id === bouton.dataset.modifier);
      if (demande) entrerEnModeModification(demande);
    });
  });

  conteneur.querySelectorAll("[data-marquer-saisie]").forEach((bouton) => {
    bouton.addEventListener("click", async () => {
      try {
        await appelApi(`/api/demandes-intervention/${bouton.dataset.marquerSaisie}/marquer-saisie`, { method: "PATCH" });
        await chargerDemandes();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  // L'automatisation pilote un vrai navigateur (pas d'API Synec) : compter
  // plusieurs dizaines de secondes, d'ou le bouton desactive + libelle
  // "en cours" plutot qu'une simple attente silencieuse.
  conteneur.querySelectorAll("[data-envoyer-synec]").forEach((bouton) => {
    bouton.addEventListener("click", async () => {
      const id = bouton.dataset.envoyerSynec;
      const zoneErreur = document.getElementById(`synec-erreur-${id}`);
      zoneErreur.hidden = true;
      bouton.disabled = true;
      bouton.textContent = "Envoi en cours… (peut prendre une minute)";
      try {
        await appelApi(`/api/demandes-intervention/${id}/envoyer-synec`, { method: "POST" });
        await chargerDemandes();
      } catch (err) {
        bouton.disabled = false;
        bouton.textContent = "Envoyer vers Synec";
        zoneErreur.hidden = false;
        zoneErreur.textContent = `Échec : ${err.message} — capture d'écran du blocage disponible sur /api/synec/capture-echec`;
      }
    });
  });
}

// Autocompletion d'adresse via l'API Adresse du gouvernement francais
// (api-adresse.data.gouv.fr) : gratuite, sans cle a gerer, et taillee pour
// les adresses francaises (le choix naturel ici, Synec/les clients etant
// tous en France) - demande explicite "proposer des adresses... code
// postal et ville se completent automatiquement", le fournisseur exact
// (Google vs. cette API publique) important moins que le resultat.
(function () {
  const champAdresse = document.getElementById("champ-adresse");
  const liste = document.getElementById("suggestions-adresse");
  const champCodePostal = document.querySelector('[name="codePostal"]');
  const champVille = document.querySelector('[name="ville"]');
  if (!champAdresse || !liste) return;

  let delai = null;
  let requeteEnCours = 0;

  function fermerSuggestions() {
    liste.hidden = true;
    liste.innerHTML = "";
  }

  async function chercherAdresses(texte) {
    const idRequete = ++requeteEnCours;
    try {
      const res = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(texte)}&limit=5`);
      if (!res.ok || idRequete !== requeteEnCours) return;
      const data = await res.json();
      const features = data.features || [];
      if (features.length === 0) {
        fermerSuggestions();
        return;
      }
      liste.innerHTML = features
        .map(
          (f, i) =>
            `<li data-index="${i}">${echapper(f.properties.label)}</li>`
        )
        .join("");
      liste.hidden = false;
      liste.querySelectorAll("li").forEach((li) => {
        li.addEventListener("click", () => {
          const props = features[Number(li.dataset.index)].properties;
          champAdresse.value = [props.housenumber, props.street || props.name].filter(Boolean).join(" ");
          if (champCodePostal) champCodePostal.value = props.postcode || "";
          if (champVille) champVille.value = props.city || "";
          fermerSuggestions();
        });
      });
    } catch {
      // Pas de connexion ou service indisponible : l'utilisateur garde la
      // main pour taper l'adresse a la main, comme avant cette fonction.
      fermerSuggestions();
    }
  }

  champAdresse.addEventListener("input", () => {
    clearTimeout(delai);
    const texte = champAdresse.value.trim();
    if (texte.length < 3) {
      fermerSuggestions();
      return;
    }
    delai = setTimeout(() => chercherAdresses(texte), 300);
  });

  champAdresse.addEventListener("blur", () => {
    // Laisse le temps au clic sur une suggestion de se declencher avant de
    // fermer la liste (le blur arrive avant le click sinon).
    setTimeout(fermerSuggestions, 150);
  });
})();

const formulaire = document.getElementById("form-demande");
const boutonSoumettre = document.getElementById("bouton-soumettre-demande");
const boutonAnnulerModification = document.getElementById("bouton-annuler-modification");
let idEnModification = null;

function entrerEnModeModification(demande) {
  idEnModification = demande.id;
  formulaire.querySelector('[name="nom"]').value = demande.nom || "";
  formulaire.querySelector('[name="telephone"]').value = demande.telephone || "";
  formulaire.querySelector('[name="email"]').value = demande.email || "";
  formulaire.querySelector('[name="adresse"]').value = demande.adresse || "";
  formulaire.querySelector('[name="codePostal"]').value = demande.codePostal || "";
  formulaire.querySelector('[name="ville"]').value = demande.ville || "";
  formulaire.querySelector('[name="typeLogement"]').value = demande.typeLogement || "";
  formulaire.querySelector('[name="etage"]').value = demande.etage || "";
  formulaire.querySelector('[name="codeAcces"]').value = demande.codeAcces || "";
  formulaire.querySelector('[name="urgence"]').value = demande.urgence || "normale";
  formulaire.querySelector('[name="dateSouhaitee"]').value = versDatetimeLocal(demande.dateSouhaitee);
  formulaire.querySelector('[name="dateSouhaiteeFin"]').value = versDatetimeLocal(demande.dateSouhaiteeFin);
  formulaire.querySelector('[name="sourceAcquisition"]').value = demande.sourceAcquisition || "";
  formulaire.querySelector('[name="categorie"]').value = demande.categorie || "";
  formulaire.querySelector('[name="motif"]').value = demande.motif || "";
  boutonSoumettre.textContent = "Enregistrer les modifications";
  boutonAnnulerModification.hidden = false;
  formulaire.scrollIntoView({ behavior: "smooth", block: "start" });
}

function sortirDuModeModification() {
  idEnModification = null;
  formulaire.reset();
  formulaire.querySelector('[name="urgence"]').value = "normale";
  boutonSoumettre.textContent = "Enregistrer";
  boutonAnnulerModification.hidden = true;
}

boutonAnnulerModification.addEventListener("click", sortirDuModeModification);

formulaire.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  try {
    if (idEnModification) {
      await appelApi(`/api/demandes-intervention/${idEnModification}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    } else {
      await appelApi("/api/demandes-intervention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    }
    sortirDuModeModification();
    await chargerDemandes();
  } catch (err) {
    alert(err.message);
  }
});

chargerDemandes();
