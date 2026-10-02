-- AlterTable
ALTER TABLE "Campagne" ADD COLUMN     "automatique" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "EmailTemplate" ADD COLUMN     "pieceJointeChemin" TEXT,
ADD COLUMN     "pieceJointeNom" TEXT,
ADD COLUMN     "pieceJointeType" TEXT;
