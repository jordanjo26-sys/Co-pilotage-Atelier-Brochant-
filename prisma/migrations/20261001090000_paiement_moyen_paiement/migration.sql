-- Distinguer dans la liste des reglements Stripe le paiement par carte en
-- ligne ("card") du paiement capte via Tap to Pay / terminal ("card_present"),
-- demande explicite de l'utilisateur.
ALTER TABLE "Paiement" ADD COLUMN "moyenPaiement" TEXT;
