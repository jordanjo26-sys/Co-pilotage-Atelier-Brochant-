-- CreateTable
CREATE TABLE "RapprochementLigne" (
    "id" TEXT NOT NULL,
    "mouvementBancaireId" TEXT NOT NULL,
    "cibleType" TEXT NOT NULL,
    "cibleId" TEXT NOT NULL,
    "montantAffecte" DOUBLE PRECISION NOT NULL,
    "origine" TEXT NOT NULL,
    "auteur" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "annuleLe" TIMESTAMP(3),
    "annulePar" TEXT,

    CONSTRAINT "RapprochementLigne_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RapprochementLigne_mouvementBancaireId_idx" ON "RapprochementLigne"("mouvementBancaireId");

-- CreateIndex
CREATE INDEX "RapprochementLigne_cibleType_cibleId_idx" ON "RapprochementLigne"("cibleType", "cibleId");

-- CreateTable
CREATE TABLE "RapprochementHistorique" (
    "id" TEXT NOT NULL,
    "mouvementBancaireId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "ancienStatut" TEXT,
    "nouveauStatut" TEXT NOT NULL,
    "detail" TEXT,
    "auteur" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RapprochementHistorique_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RapprochementHistorique_mouvementBancaireId_idx" ON "RapprochementHistorique"("mouvementBancaireId");
