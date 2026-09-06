import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
import { logEvenement } from "./journalService";
import { executerRapprochementBancaire } from "./rapprochementBancaire";

/**
 * Connexion directe a l'API Stripe (Phase 9 esprit "API plutot que CSV",
 * demandee par l'utilisateur une fois l'import CSV manuel en place) :
 * remplace le depot manuel d'exports Stripe par une synchronisation
 * automatique des payouts et des paiements qui les composent.
 *
 * Reprend exactement le modele de donnees et les cles de deduplication
 * deja utilisees par l'import CSV (Payout.payoutRef, Paiement.paymentRef) :
 * les deux voies (fichier ou API) alimentent la meme base sans jamais se
 * dupliquer, et le rapprochement bancaire existant (rapprochementBancaire.ts)
 * fonctionne a l'identique quelle que soit l'origine des payouts.
 *
 * Cle API : une cle **restreinte**, lecture seule sur paiements/payouts
 * (voir docs/mise-en-service.md) — jamais la cle secrete complete du
 * compte (section 17 du cahier des charges : moindre privilege).
 */

export interface ResultatSyncStripe {
  payoutsExamines: number;
  payoutsNouveaux: number;
  paiementsExamines: number;
  paiementsNouveaux: number;
  erreurs: string[];
}

// Types de transaction correspondant a un paiement client reel (par
// opposition aux frais, remboursements, ajustements... qui ne sont pas des
// "paiements" au sens de la Facture qu'ils reglent).
const TYPES_PAIEMENT = new Set(["charge", "payment"]);

function centimesVersUnites(montant: number): number {
  return montant / 100;
}

export function stripeEstConnecte(): boolean {
  return Boolean(process.env.STRIPE_API_KEY);
}

function obtenirClientStripe(): Stripe {
  const cle = process.env.STRIPE_API_KEY;
  if (!cle) throw new Error("Aucune cle API Stripe configuree (STRIPE_API_KEY).");
  return new Stripe(cle);
}

/**
 * Synchronise les payouts recents et les paiements qui les composent.
 * Idempotent (upsert par payoutRef/paymentRef, comme l'import CSV) :
 * peut etre rejouee sans jamais dupliquer une donnee deja connue, y
 * compris si elle a d'abord ete recue via un fichier CSV depose a la main.
 */
export async function synchroniserStripe(prisma: PrismaClient): Promise<ResultatSyncStripe> {
  const stripe = obtenirClientStripe();
  const resultat: ResultatSyncStripe = { payoutsExamines: 0, payoutsNouveaux: 0, paiementsExamines: 0, paiementsNouveaux: 0, erreurs: [] };

  // Fenetre large (comme la synchronisation Gmail) : la deduplication par
  // cle unique rend le re-balayage sans consequence, et evite de manquer
  // un payout en cas d'arret prolonge du service entre deux syncs.
  const depuis = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  const payouts = await stripe.payouts.list({ created: { gte: depuis }, limit: 100, expand: ["data.destination"] });

  for (const payout of payouts.data) {
    resultat.payoutsExamines++;
    try {
      const destination = payout.destination;
      const destinationName =
        destination && typeof destination !== "string" && "bank_name" in destination ? destination.bank_name || null : null;
      const balanceTransactionRef =
        typeof payout.balance_transaction === "string" ? payout.balance_transaction : payout.balance_transaction?.id || null;

      const donneesPayout = {
        date: new Date(payout.arrival_date * 1000),
        montantNet: centimesVersUnites(payout.amount),
        statut: payout.status,
        destinationName,
        balanceTransactionRef,
      };

      const existant = await prisma.payout.findUnique({ where: { payoutRef: payout.id } });
      if (existant) {
        await prisma.payout.update({ where: { payoutRef: payout.id }, data: donneesPayout });
      } else {
        await prisma.payout.create({ data: { payoutRef: payout.id, ...donneesPayout } });
        resultat.payoutsNouveaux++;
      }

      const transactions = await stripe.balanceTransactions.list({ payout: payout.id, limit: 100 });
      for (const bt of transactions.data) {
        if (!TYPES_PAIEMENT.has(bt.type)) continue; // frais, remboursements, ajustements... pas des paiements clients
        resultat.paiementsExamines++;

        // L'adresse e-mail du client n'est pas disponible sur la transaction
        // elle-meme (il faudrait un appel supplementaire par transaction
        // vers l'objet Charge/Customer) : laissee vide plutot que de
        // multiplier les appels API pour un champ purement informatif.
        const donneesPaiement = {
          source: "stripe",
          brut: centimesVersUnites(bt.amount),
          frais: centimesVersUnites(bt.fee),
          net: centimesVersUnites(bt.net),
          devise: (bt.currency || "eur").toUpperCase(),
          date: new Date(bt.created * 1000),
          clientEmail: null,
          payoutRef: payout.id,
        };

        const existantPaiement = await prisma.paiement.findUnique({ where: { paymentRef: bt.id } });
        if (existantPaiement) {
          await prisma.paiement.update({ where: { paymentRef: bt.id }, data: donneesPaiement });
        } else {
          await prisma.paiement.create({ data: { paymentRef: bt.id, ...donneesPaiement } });
          resultat.paiementsNouveaux++;
        }
      }
    } catch (err) {
      resultat.erreurs.push(`Payout ${payout.id} : ${(err as Error).message}`);
    }
  }

  // De nouveaux payouts peuvent completer un rapprochement bancaire en attente.
  await executerRapprochementBancaire(prisma);

  await logEvenement(prisma, {
    evenement: "stripe_sync",
    action: "Synchronisation Stripe (payouts et paiements)",
    resultat:
      `${resultat.payoutsNouveaux} payout(s) nouveau(x) sur ${resultat.payoutsExamines} examine(s), ` +
      `${resultat.paiementsNouveaux} paiement(s) nouveau(x) sur ${resultat.paiementsExamines} examine(s), ` +
      `${resultat.erreurs.length} erreur(s).`,
  });

  return resultat;
}

/** Date de la derniere synchronisation reussie, pour affichage dans l'interface. */
export async function derniereSynchroStripe(prisma: PrismaClient): Promise<Date | null> {
  const dernier = await prisma.journalEvenement.findFirst({
    where: { evenement: "stripe_sync" },
    orderBy: { horodatage: "desc" },
  });
  return dernier?.horodatage || null;
}
