-- AlterTable
ALTER TABLE "SessionVisio" ADD COLUMN     "consentAccepte" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "consentCameraMicro" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "consentDate" TIMESTAMP(3),
ADD COLUMN     "consentPhotos" BOOLEAN NOT NULL DEFAULT false;

