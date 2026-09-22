import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Ce projet vit dans un sous-dossier d'un dépôt contenant un autre
  // projet Node (le copilote Atelier Brochant) avec son propre
  // package-lock.json : on fixe explicitement la racine pour éviter que
  // Next.js ne la confonde avec un monorepo.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
