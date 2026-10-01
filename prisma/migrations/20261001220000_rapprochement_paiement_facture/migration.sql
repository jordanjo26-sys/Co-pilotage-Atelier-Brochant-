-- Rattachement exact paiement Stripe <-> facture par identifiant
-- PaymentIntent ("pi_..."), en plus de la correspondance par texte deja
-- en place (reference/bon de commande dans la description) : Synec note
-- deja cette meme reference dans sa colonne "payments" ("Stripe pi_...")
-- quand un reglement vient de Stripe. Demande explicite de l'utilisateur.
ALTER TABLE "Facture" ADD COLUMN "referencesStripe" TEXT;
ALTER TABLE "Paiement" ADD COLUMN "paymentIntentRef" TEXT;
