/**
 * Depose les CSV d'exemple (samples/) dans l'outil, comme le ferait un
 * utilisateur depuis la page web. Pratique pour tester rapidement le
 * pipeline complet sans passer par l'interface.
 *
 * Usage : npm run seed:samples (le serveur doit deja tourner : npm run dev)
 */
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SAMPLES_DIR = path.join(__dirname, "..", "samples");

const FICHIERS = [
  "synec-factures-exemple.csv",
  "stripe-paiements-exemple.csv",
  "stripe-payouts-exemple.csv",
  "banque-releve-exemple.csv",
];

async function importerFichier(nom: string) {
  const buffer = fs.readFileSync(path.join(SAMPLES_DIR, nom));
  const formData = new FormData();
  formData.append("fichier", new Blob([buffer]), nom);

  const res = await fetch(`${BASE_URL}/api/import`, { method: "POST", body: formData });
  const data = await res.json();
  console.log(`${nom} ->`, data);
}

async function main() {
  for (const fichier of FICHIERS) {
    await importerFichier(fichier);
  }
}

main().catch((err) => {
  console.error("Echec du seed :", err.message);
  console.error("Le serveur tourne-t-il bien sur", BASE_URL, "? (npm run dev)");
  process.exit(1);
});
