# Fichiers d'exemple

⚠️ **Ces fichiers sont fictifs.** Au moment de la création de cet outil, le
cahier des charges (.docx) a bien été reçu, mais aucun véritable export CSV
(Synec, Stripe, banque) n'a été joint au message malgré la mention dans la
demande. Ces CSV ont donc été construits pour :

1. faire fonctionner et tester le pipeline de réception de bout en bout ;
2. servir de référence de structure (colonnes attendues) le temps de recevoir
   les vrais fichiers.

Ils illustrent volontairement la chaîne de preuves de la section 5 du cahier
des charges : deux règlements Stripe (`stripe-paiements-exemple.csv`) sont
regroupés dans un seul virement (`stripe-payouts-exemple.csv`), qui atterrit
comme une seule ligne sur le compte bancaire
(`banque-releve-exemple.csv`) — exactement le cas "X € client A + Y € client
B, moins les frais" décrit dans le cahier des charges.

## Fichiers

| Fichier | Type détecté | Ce qu'il simule |
|---|---|---|
| `synec-factures-exemple.csv` | `synec_factures` | Export de factures Synec : 2 factures payées hier, 2 factures impayées |
| `stripe-paiements-exemple.csv` | `stripe_paiements` | 2 paiements CB Stripe regroupés dans le même virement |
| `stripe-payouts-exemple.csv` | `stripe_payouts` | Le virement Stripe qui regroupe les 2 paiements ci-dessus |
| `banque-releve-exemple.csv` | `banque_releve` | Le relevé bancaire recevant ce virement, + un prélèvement fournisseur |

## Comment les essayer

```bash
npm run dev
# puis, dans un autre terminal :
curl -F "fichier=@samples/synec-factures-exemple.csv" http://localhost:3000/api/import
curl -F "fichier=@samples/stripe-paiements-exemple.csv" http://localhost:3000/api/import
curl -F "fichier=@samples/stripe-payouts-exemple.csv" http://localhost:3000/api/import
curl -F "fichier=@samples/banque-releve-exemple.csv" http://localhost:3000/api/import
```

Ou plus simplement : ouvrir `http://localhost:3000` et déposer les fichiers un
par un depuis la page.

## Quand les vrais fichiers seront disponibles

Envoyer un export réel de chaque système (Synec, Stripe paiements, Stripe
payouts, relevé Banque Populaire). Il suffira très probablement d'ajuster les
listes d'alias de colonnes dans `src/config/mappings/*.json` — **aucune
modification de code n'est nécessaire** pour ça, voir le README principal,
section "Ajuster le format des CSV".
