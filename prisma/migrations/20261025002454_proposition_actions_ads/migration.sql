-- CreateTable
CREATE TABLE "PropositionAds" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "campagneId" TEXT NOT NULL,
    "campagneNom" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'en_attente',
    "erreur" TEXT,
    "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decideLe" TIMESTAMP(3),

    CONSTRAINT "PropositionAds_pkey" PRIMARY KEY ("id")
);
