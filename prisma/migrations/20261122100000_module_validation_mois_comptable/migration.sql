-- CreateTable
CREATE TABLE "ValidationMoisComptable" (
    "id" TEXT NOT NULL,
    "periode" TEXT NOT NULL,
    "valide" BOOLEAN NOT NULL DEFAULT true,
    "auteur" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nbMouvementsAuMoment" INTEGER NOT NULL,
    "nbRapprochesAuMoment" INTEGER NOT NULL,
    "invalideLe" TIMESTAMP(3),
    "invalideMotif" TEXT,

    CONSTRAINT "ValidationMoisComptable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ValidationMoisComptable_periode_key" ON "ValidationMoisComptable"("periode");
