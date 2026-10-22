const echapper = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDateHeure = (iso) => (iso ? new Date(iso).toLocaleString("fr-FR") : "—");

const LIBELLE_URGENCE = { faible: "Faible", normale: "Normale", urgente: "Urgente" };

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
      ${d.motif ? `<div class="historique-ligne">Motif : ${echapper(d.motif)}</div>` : ""}
      <div id="synec-erreur-${d.id}" class="historique-ligne" style="color:var(--critical)" hidden></div>
      <div class="ligne-boutons" style="margin-top:8px">
        <button type="button" data-envoyer-synec="${d.id}">Envoyer vers Synec</button>
        <button type="button" class="ghost" data-marquer-saisie="${d.id}">Marquer comme saisie à la main</button>
      </div>
    </div>`
    )
    .join("");

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

document.getElementById("form-demande").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  Object.keys(data).forEach((cle) => {
    if (data[cle] === "") delete data[cle];
  });
  try {
    await appelApi("/api/demandes-intervention", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    e.target.reset();
    e.target.querySelector('[name="urgence"]').value = "normale";
    await chargerDemandes();
  } catch (err) {
    alert(err.message);
  }
});

chargerDemandes();
