-- AlterTable
ALTER TABLE "DocumentFournisseur" RENAME COLUMN "montant" TO "montantTTC";
ALTER TABLE "DocumentFournisseur" ADD COLUMN     "montantHT" DOUBLE PRECISION;
