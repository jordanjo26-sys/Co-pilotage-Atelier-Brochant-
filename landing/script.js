// ---------------------------------------------------------------------------
// Config a personnaliser avant la mise en ligne des campagnes.
// ---------------------------------------------------------------------------
const CONFIG = {
  // Email qui recevra les demandes via le lien mailto de secours.
  emailContact: "contact@atelier-brochant.fr",

  // TODO : URL d'un endpoint qui reçoit le lead en POST JSON (ex: Formspree,
  // Netlify Forms, Google Apps Script relié a un Google Sheet, ou une route
  // de l'API interne). Laisser vide ("") pour utiliser le mode mailto de secours.
  endpointFormulaire: "",
};

document.getElementById("annee").textContent = new Date().getFullYear();

const form = document.getElementById("form-devis");
const messageEtat = document.getElementById("message-etat");

function afficherMessage(texte, type) {
  messageEtat.textContent = texte;
  messageEtat.className = `message-etat ${type}`;
  messageEtat.hidden = false;
}

function construireCorpsMail(donnees) {
  return [
    `Nouvelle demande de devis - ${donnees.projet}`,
    "",
    `Nom : ${donnees.nom}`,
    `Téléphone : ${donnees.telephone}`,
    `Email : ${donnees.email}`,
    `Code postal : ${donnees.codePostal}`,
    `Projet : ${donnees.projet}`,
    `Message : ${donnees.message || "(aucun)"}`,
  ].join("\n");
}

function enregistrerLeadLocal(donnees) {
  try {
    const cle = "atelier-brochant-leads";
    const existants = JSON.parse(localStorage.getItem(cle) || "[]");
    existants.push({ ...donnees, date: new Date().toISOString() });
    localStorage.setItem(cle, JSON.stringify(existants));
  } catch (erreur) {
    // localStorage indisponible (navigation privée, quota...) : on ignore.
  }
}

async function envoyerLead(donnees) {
  if (CONFIG.endpointFormulaire) {
    const reponse = await fetch(CONFIG.endpointFormulaire, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(donnees),
    });
    if (!reponse.ok) throw new Error("Echec de l'envoi au serveur");
    return;
  }

  // Mode de secours sans backend : ouvre le client mail avec les infos pre-remplies.
  const sujet = encodeURIComponent(`Demande de devis - ${donnees.projet}`);
  const corps = encodeURIComponent(construireCorpsMail(donnees));
  window.location.href = `mailto:${CONFIG.emailContact}?subject=${sujet}&body=${corps}`;
}

form.addEventListener("submit", async (evenement) => {
  evenement.preventDefault();
  messageEtat.hidden = true;

  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const donnees = {
    nom: form.nom.value.trim(),
    telephone: form.telephone.value.trim(),
    email: form.email.value.trim(),
    codePostal: form.codePostal.value.trim(),
    projet: form.projet.value,
    message: form.message.value.trim(),
  };

  const boutonEnvoi = form.querySelector("button[type=submit]");
  boutonEnvoi.disabled = true;

  try {
    enregistrerLeadLocal(donnees);
    await envoyerLead(donnees);

    // TODO CONVERSION : declencher ici les evenements de conversion publicitaires, ex :
    // if (window.fbq) fbq('track', 'Lead');
    // if (window.gtag) gtag('event', 'conversion', { send_to: 'AW-XXXXXXXXX/XXXXXXXX' });

    afficherMessage("Merci ! Votre demande a bien été envoyée, un conseiller vous recontacte sous 24h.", "succes");
    form.reset();
  } catch (erreur) {
    afficherMessage("Une erreur est survenue. Merci de nous appeler directement au 01 00 00 00 00.", "erreur");
  } finally {
    boutonEnvoi.disabled = false;
  }
});
