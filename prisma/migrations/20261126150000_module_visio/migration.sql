-- CreateTable
CREATE TABLE "SessionVisio" (
    "id" TEXT NOT NULL,
    "clientNom" TEXT NOT NULL,
    "clientTelephone" TEXT,
    "token" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'en_attente',
    "livekitRoom" TEXT NOT NULL,
    "dateDebut" TIMESTAMP(3),
    "dateFin" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionVisio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaptureVisio" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "fichierNom" TEXT NOT NULL,
    "mesures" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaptureVisio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionVisio_token_key" ON "SessionVisio"("token");

-- CreateIndex
CREATE UNIQUE INDEX "SessionVisio_livekitRoom_key" ON "SessionVisio"("livekitRoom");

-- AddForeignKey
ALTER TABLE "CaptureVisio" ADD CONSTRAINT "CaptureVisio_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SessionVisio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

