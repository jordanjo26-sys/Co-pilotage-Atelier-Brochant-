-- CreateTable
CREATE TABLE "ActiviteRealisation" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenGalerie" TEXT NOT NULL,
    "derniereDigestEnvoyeeLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActiviteRealisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhotoRealisation" (
    "id" TEXT NOT NULL,
    "activiteId" TEXT NOT NULL,
    "fichierNom" TEXT NOT NULL,
    "chantierNom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhotoRealisation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ActiviteRealisation_nom_key" ON "ActiviteRealisation"("nom");

-- CreateIndex
CREATE UNIQUE INDEX "ActiviteRealisation_tokenGalerie_key" ON "ActiviteRealisation"("tokenGalerie");

-- AddForeignKey
ALTER TABLE "PhotoRealisation" ADD CONSTRAINT "PhotoRealisation_activiteId_fkey" FOREIGN KEY ("activiteId") REFERENCES "ActiviteRealisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
