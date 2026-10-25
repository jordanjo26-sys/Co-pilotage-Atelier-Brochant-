-- CreateTable
CREATE TABLE "ConnexionMeta" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "pageNom" TEXT NOT NULL,
    "pageAccessTokenChiffre" TEXT NOT NULL,
    "instagramBusinessAccountId" TEXT,
    "instagramUsername" TEXT,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "connecteLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnexionMeta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropositionPost" (
    "id" TEXT NOT NULL,
    "plateformes" TEXT[],
    "texte" TEXT NOT NULL,
    "cheminMedia" TEXT,
    "justification" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'en_attente',
    "erreur" TEXT,
    "idPublicationFacebook" TEXT,
    "idPublicationInstagram" TEXT,
    "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decideLe" TIMESTAMP(3),

    CONSTRAINT "PropositionPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConnexionMeta_pageId_key" ON "ConnexionMeta"("pageId");
