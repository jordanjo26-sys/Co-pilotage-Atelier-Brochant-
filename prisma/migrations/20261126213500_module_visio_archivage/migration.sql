-- AlterTable
ALTER TABLE "SessionVisio" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivee" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notes" TEXT;

