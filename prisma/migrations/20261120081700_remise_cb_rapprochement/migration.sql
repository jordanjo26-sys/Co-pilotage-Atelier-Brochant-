-- Rapprochement des remises carte bleue (MouvementBancaire "REMISE CB")
-- avec les encaissements clients en carte (Encaissement.mode = "Carte").
ALTER TABLE "MouvementBancaire" ADD COLUMN "montantBrut" DOUBLE PRECISION;
ALTER TABLE "Encaissement" ADD COLUMN "mouvementBancaireId" TEXT;
