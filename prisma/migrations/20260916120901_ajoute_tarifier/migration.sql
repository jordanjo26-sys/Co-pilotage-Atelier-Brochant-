-- CreateTable
CREATE TABLE "TarifPrestation" (
    "id" TEXT NOT NULL,
    "metier" TEXT NOT NULL,
    "categorie" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "unite" TEXT NOT NULL,
    "prixMateriel" DOUBLE PRECISION,
    "prixMainOeuvre" DOUBLE PRECISION,
    "prixVenteHT" DOUBLE PRECISION NOT NULL,
    "fournisseurRef" TEXT,
    "source" TEXT,
    "notes" TEXT,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TarifPrestation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TarifPrestation_metier_categorie_idx" ON "TarifPrestation"("metier", "categorie");

-- CreateIndex
CREATE UNIQUE INDEX "TarifPrestation_metier_designation_key" ON "TarifPrestation"("metier", "designation");
