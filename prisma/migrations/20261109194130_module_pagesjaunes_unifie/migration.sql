/*
  Warnings:

  - You are about to drop the `PropositionActualitePagesJaunes` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "PropositionActualitePagesJaunes";

-- CreateTable
CREATE TABLE "PropositionPagesJaunes" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "etablissement" TEXT NOT NULL DEFAULT 'A.B Atelier Brochant - 117 avenue du Général Leclerc, 77400 Lagny-sur-Marne',
    "texte" TEXT NOT NULL,
    "cheminMedia" TEXT,
    "champFiche" TEXT,
    "avisClientNom" TEXT,
    "avisNote" INTEGER,
    "avisTexte" TEXT,
    "justification" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'en_attente',
    "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decideLe" TIMESTAMP(3),
    "publieeLe" TIMESTAMP(3),

    CONSTRAINT "PropositionPagesJaunes_pkey" PRIMARY KEY ("id")
);
