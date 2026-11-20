-- Rapprochement bancaire des vraies factures fournisseurs (DocumentFournisseur,
-- celles qui arrivent par Gmail/Dext) - FactureFournisseur n'est jamais
-- alimentee par aucun code actif, le rapprochement devait aussi couvrir
-- cette table pour etre utile en pratique.
ALTER TABLE "DocumentFournisseur" ADD COLUMN "mouvementBancaireId" TEXT;
