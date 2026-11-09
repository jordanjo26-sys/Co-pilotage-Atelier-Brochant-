-- CreateTable
CREATE TABLE "PropositionActualitePagesJaunes" (
    "id" TEXT NOT NULL,
    "etablissement" TEXT NOT NULL,
    "texte" TEXT NOT NULL,
    "cheminMedia" TEXT,
    "justification" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'en_attente',
    "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decideLe" TIMESTAMP(3),
    "publieeLe" TIMESTAMP(3),

    CONSTRAINT "PropositionActualitePagesJaunes_pkey" PRIMARY KEY ("id")
);
