import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execSync } from "node:child_process";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ||
  (process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/(\?|$)/, "_test$1") : undefined);

if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL (ou DATABASE_URL) manquante : voir .env.example.");
}
process.env.DATABASE_URL = testDatabaseUrl;

before(() => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });
});

// Ne teste ici QUE le cycle de vie de la proposition en base (creation,
// liste, refus) - jamais accepterPropositionAds/appliquerPropositionAds, qui
// appellent la vraie API Google Ads (changerStatutCampagne). Les appeler
// dans ce test automatique ferait courir le risque reel de modifier un
// compte Google Ads en production si les variables GOOGLE_ADS_* sont
// presentes dans l'environnement d'execution (ex. sur le serveur de
// deploiement) - voir la discussion avec l'utilisateur : une proposition ne
// doit etre appliquee qu'apres une validation explicite sur l'ecran dedie.
test("propositions Google Ads : creation, liste, refus (jamais d'appel API reel ici)", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { creerPropositionAds, listerPropositionsAds, refuserPropositionAds, accepterPropositionAds } = await import(
    "../src/services/googleAdsActions"
  );
  const prisma = new PrismaClient();

  await t.test("aucune proposition -> liste vide", async () => {
    assert.deepEqual(await listerPropositionsAds(prisma), []);
  });

  await t.test("creerPropositionAds -> statut en_attente par defaut", async () => {
    const proposition = await creerPropositionAds(prisma, {
      type: "pause_campagne",
      campagneId: "123456",
      campagneNom: "Dépannage",
      justification: "CPA trois fois plus eleve que les autres campagnes actives sur 30 jours.",
    });
    assert.equal(proposition.statut, "en_attente");
    assert.equal(proposition.campagneNom, "Dépannage");

    const liste = await listerPropositionsAds(prisma);
    assert.equal(liste.length, 1);
    assert.equal(liste[0].id, proposition.id);
  });

  await t.test("listerPropositionsAds filtre par statut", async () => {
    const enAttente = await listerPropositionsAds(prisma, "en_attente");
    assert.equal(enAttente.length, 1);
    const refusees = await listerPropositionsAds(prisma, "refusee");
    assert.equal(refusees.length, 0);
  });

  await t.test("refuserPropositionAds -> statut refusee, decideLe rempli", async () => {
    const [proposition] = await listerPropositionsAds(prisma, "en_attente");
    const refusee = await refuserPropositionAds(prisma, proposition.id);
    assert.equal(refusee.statut, "refusee");
    assert.ok(refusee.decideLe);
  });

  await t.test("refuserPropositionAds sur une proposition deja decidee -> erreur explicite", async () => {
    const [proposition] = await listerPropositionsAds(prisma, "refusee");
    await assert.rejects(refuserPropositionAds(prisma, proposition.id), /en_attente/);
  });

  await t.test("creerPropositionAds (creer_campagne) : rejette une entree qui ne respecte pas les contraintes Google Ads", async () => {
    const base = {
      type: "creer_campagne" as const,
      campagneId: "",
      campagneNom: "Débouchage express",
      justification: "Accord de l'utilisateur pour cibler les recherches de débouchage urgent.",
      budgetQuotidien: 50,
      urlFinale: "https://copilotage-brochant.fr",
      titres: ["Débouchage express", "Intervention 24/7", "Devis gratuit"],
      descriptions: ["Intervention rapide à Paris.", "Devis gratuit, sans engagement."],
      motsCles: ["débouchage urgence"],
      motsClesExclus: [],
    };

    await assert.rejects(creerPropositionAds(prisma, { ...base, budgetQuotidien: 0 }), /budgetQuotidien/);
    await assert.rejects(creerPropositionAds(prisma, { ...base, urlFinale: undefined }), /urlFinale/);
    await assert.rejects(creerPropositionAds(prisma, { ...base, titres: ["Un seul titre"] }), /titres/);
    await assert.rejects(creerPropositionAds(prisma, { ...base, descriptions: ["Une seule description"] }), /descriptions/);
    await assert.rejects(creerPropositionAds(prisma, { ...base, motsCles: [] }), /motsCles/);
  });

  await t.test("creerPropositionAds (creer_campagne) : entree valide -> deposee en_attente avec tous ses details", async () => {
    const proposition = await creerPropositionAds(prisma, {
      type: "creer_campagne",
      campagneId: "",
      campagneNom: "Débouchage express",
      justification: "Accord de l'utilisateur pour cibler les recherches de débouchage urgent.",
      budgetQuotidien: 50,
      urlFinale: "https://copilotage-brochant.fr",
      titres: ["Débouchage express", "Intervention 24/7", "Devis gratuit"],
      descriptions: ["Intervention rapide à Paris.", "Devis gratuit, sans engagement."],
      motsCles: ["débouchage urgence", "plombier débouchage"],
      motsClesExclus: ["formation", "emploi"],
    });
    assert.equal(proposition.statut, "en_attente");
    assert.equal(proposition.campagneId, "");
    assert.equal(proposition.budgetQuotidien, 50);
    assert.deepEqual(proposition.titres, ["Débouchage express", "Intervention 24/7", "Devis gratuit"]);
    assert.deepEqual(proposition.motsClesExclus, ["formation", "emploi"]);

    const refusee = await refuserPropositionAds(prisma, proposition.id);
    assert.equal(refusee.statut, "refusee");
  });

  await t.test("creerPropositionAds (ajouter_mots_cles_exclus) : rejette une entree incomplete", async () => {
    await assert.rejects(
      creerPropositionAds(prisma, {
        type: "ajouter_mots_cles_exclus",
        campagneId: "",
        campagneNom: "Dépannage",
        justification: "Termes hors sujet detectes dans les recherches reelles.",
        motsClesExclus: ["formation plombier"],
      }),
      /campagneId/
    );
    await assert.rejects(
      creerPropositionAds(prisma, {
        type: "ajouter_mots_cles_exclus",
        campagneId: "123456",
        campagneNom: "Dépannage",
        justification: "Termes hors sujet detectes dans les recherches reelles.",
        motsClesExclus: [],
      }),
      /motsClesExclus/
    );
  });

  await t.test("creerPropositionAds (ajouter_mots_cles_exclus) : entree valide -> deposee en_attente", async () => {
    const proposition = await creerPropositionAds(prisma, {
      type: "ajouter_mots_cles_exclus",
      campagneId: "123456",
      campagneNom: "Dépannage",
      justification: "Les termes \"formation plombier\" et \"emploi plombier\" ont coute 45 € sans conversion sur 30 jours, hors sujet (activite = interventions, pas recrutement/formation).",
      motsClesExclus: ["formation plombier", "emploi plombier"],
    });
    assert.equal(proposition.statut, "en_attente");
    assert.equal(proposition.campagneId, "123456");
    assert.deepEqual(proposition.motsClesExclus, ["formation plombier", "emploi plombier"]);

    const refusee = await refuserPropositionAds(prisma, proposition.id);
    assert.equal(refusee.statut, "refusee");
  });

  await t.test("creerPropositionAds (pause_mot_cle/reactiver_mot_cle) : rejette une entree incomplete", async () => {
    const base = {
      type: "pause_mot_cle" as const,
      campagneId: "",
      campagneNom: "Dépannage",
      justification: "212 € dépensés sans aucune conversion sur 30 jours.",
      groupeId: "456",
      criterionId: "789",
      motCleTexte: "serrure Fichet",
    };
    await assert.rejects(creerPropositionAds(prisma, { ...base, groupeId: undefined }), /groupeId/);
    await assert.rejects(creerPropositionAds(prisma, { ...base, criterionId: undefined }), /criterionId/);
    await assert.rejects(creerPropositionAds(prisma, { ...base, motCleTexte: undefined }), /motCleTexte/);
  });

  await t.test("creerPropositionAds (pause_mot_cle) : entree valide -> deposee en_attente, campagneId optionnel", async () => {
    const proposition = await creerPropositionAds(prisma, {
      type: "pause_mot_cle",
      campagneId: "",
      campagneNom: "Dépannage",
      justification: "212 € dépensés sans aucune conversion sur 30 jours.",
      groupeId: "456",
      criterionId: "789",
      motCleTexte: "serrure Fichet",
    });
    assert.equal(proposition.statut, "en_attente");
    assert.equal(proposition.groupeId, "456");
    assert.equal(proposition.criterionId, "789");
    assert.equal(proposition.motCleTexte, "serrure Fichet");

    const refusee = await refuserPropositionAds(prisma, proposition.id);
    assert.equal(refusee.statut, "refusee");
  });

  await t.test("creerPropositionAds (exclure_action_conversion) : rejette une entree sans conversionActionId", async () => {
    await assert.rejects(
      creerPropositionAds(prisma, {
        type: "exclure_action_conversion",
        campagneId: "",
        campagneNom: "Fichet (vue de page)",
        justification: "Cette action compte une simple vue de page comme conversion, ce qui fausse le CPA.",
      }),
      /conversionActionId/
    );
  });

  await t.test("creerPropositionAds (exclure_action_conversion) : entree valide -> deposee en_attente", async () => {
    const proposition = await creerPropositionAds(prisma, {
      type: "exclure_action_conversion",
      campagneId: "",
      campagneNom: "Fichet (vue de page)",
      justification: "Cette action compte une simple vue de page comme conversion, ce qui fausse le CPA.",
      conversionActionId: "987654",
    });
    assert.equal(proposition.statut, "en_attente");
    assert.equal(proposition.conversionActionId, "987654");

    const refusee = await refuserPropositionAds(prisma, proposition.id);
    assert.equal(refusee.statut, "refusee");
  });

  await t.test("creerPropositionAds (creer_action_conversion_site) : rejette une entree sans typeConversionSite valide", async () => {
    await assert.rejects(
      creerPropositionAds(prisma, {
        type: "creer_action_conversion_site",
        campagneId: "",
        campagneNom: "Clic pour appeler - site Fichet",
        justification: "Suivre les clics sur le numéro affiché sur le site.",
      }),
      /typeConversionSite/
    );
  });

  await t.test("creerPropositionAds (creer_action_conversion_site) : entree valide -> deposee en_attente", async () => {
    const proposition = await creerPropositionAds(prisma, {
      type: "creer_action_conversion_site",
      campagneId: "",
      campagneNom: "Clic pour appeler - site Fichet",
      justification: "Suivre les clics sur le numéro affiché sur le site.",
      typeConversionSite: "CLICK_TO_CALL",
    });
    assert.equal(proposition.statut, "en_attente");
    assert.equal(proposition.typeConversionSite, "CLICK_TO_CALL");

    const refusee = await refuserPropositionAds(prisma, proposition.id);
    assert.equal(refusee.statut, "refusee");
  });

  await t.test("accepterPropositionAds sans configuration Google Ads -> proposition marquee echec, jamais d'appel API reel", async () => {
    // Retire deliberement GOOGLE_ADS_* le temps de ce test (meme principe
    // que tests/stripeSync.test.ts pour STRIPE_API_KEY) : garantit que
    // googleAdsEstConfigure() est faux et qu'obtenirClientAds renvoie null
    // QUEL QUE SOIT l'environnement reel d'execution (ex. serveur de
    // deploiement avec de vraies cles) - sans cette precaution, ce test
    // pourrait declencher une vraie mutation sur le compte Google Ads en
    // production.
    const vars = ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CUSTOMER_ID", "GOOGLE_ADS_LOGIN_CUSTOMER_ID", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
    const sauvegarde = Object.fromEntries(vars.map((v) => [v, process.env[v]]));
    vars.forEach((v) => delete process.env[v]);
    try {
      const nouvelle = await creerPropositionAds(prisma, {
        type: "reactiver_campagne",
        campagneId: "789",
        campagneNom: "Sos Express",
        justification: "Accord de l'utilisateur en conversation pour relancer cette campagne.",
      });
      const resultat = await accepterPropositionAds(prisma, nouvelle.id);
      assert.equal(resultat.statut, "echec");
      assert.match(resultat.erreur || "", /non configure/);

      // Meme verification pour creer_campagne : doit echouer proprement
      // (creerCampagne appelle obtenirClientAds en premier, avant tout appel
      // reseau) plutot que de tenter un appel reel.
      const propositionCreation = await creerPropositionAds(prisma, {
        type: "creer_campagne",
        campagneId: "",
        campagneNom: "Débouchage express",
        justification: "Accord de l'utilisateur.",
        budgetQuotidien: 50,
        urlFinale: "https://copilotage-brochant.fr",
        titres: ["Débouchage express", "Intervention 24/7", "Devis gratuit"],
        descriptions: ["Intervention rapide à Paris.", "Devis gratuit, sans engagement."],
        motsCles: ["débouchage urgence"],
        motsClesExclus: [],
      });
      const resultatCreation = await accepterPropositionAds(prisma, propositionCreation.id);
      assert.equal(resultatCreation.statut, "echec");
      assert.match(resultatCreation.erreur || "", /non configure/);
      assert.equal(resultatCreation.campagneId, "", "campagneId ne doit pas changer puisque la creation a echoue avant tout appel API");

      // Meme verification pour ajouter_mots_cles_exclus.
      const propositionExclus = await creerPropositionAds(prisma, {
        type: "ajouter_mots_cles_exclus",
        campagneId: "123456",
        campagneNom: "Dépannage",
        justification: "Termes hors sujet.",
        motsClesExclus: ["formation plombier"],
      });
      const resultatExclus = await accepterPropositionAds(prisma, propositionExclus.id);
      assert.equal(resultatExclus.statut, "echec");
      assert.match(resultatExclus.erreur || "", /non configure/);

      // Meme verification pour pause_mot_cle.
      const propositionMotCle = await creerPropositionAds(prisma, {
        type: "pause_mot_cle",
        campagneId: "",
        campagneNom: "Dépannage",
        justification: "212 € dépensés sans aucune conversion sur 30 jours.",
        groupeId: "456",
        criterionId: "789",
        motCleTexte: "serrure Fichet",
      });
      const resultatMotCle = await accepterPropositionAds(prisma, propositionMotCle.id);
      assert.equal(resultatMotCle.statut, "echec");
      assert.match(resultatMotCle.erreur || "", /non configure/);

      // Meme verification pour exclure_action_conversion.
      const propositionConversion = await creerPropositionAds(prisma, {
        type: "exclure_action_conversion",
        campagneId: "",
        campagneNom: "Fichet (vue de page)",
        justification: "Cette action compte une simple vue de page comme conversion.",
        conversionActionId: "987654",
      });
      const resultatConversion = await accepterPropositionAds(prisma, propositionConversion.id);
      assert.equal(resultatConversion.statut, "echec");
      assert.match(resultatConversion.erreur || "", /non configure/);

      // Meme verification pour creer_action_conversion_site.
      const propositionSite = await creerPropositionAds(prisma, {
        type: "creer_action_conversion_site",
        campagneId: "",
        campagneNom: "Clic pour appeler - site Fichet",
        justification: "Suivre les clics sur le numéro affiché sur le site.",
        typeConversionSite: "CLICK_TO_CALL",
      });
      const resultatSite = await accepterPropositionAds(prisma, propositionSite.id);
      assert.equal(resultatSite.statut, "echec");
      assert.match(resultatSite.erreur || "", /non configure/);
    } finally {
      vars.forEach((v) => {
        if (sauvegarde[v] !== undefined) process.env[v] = sauvegarde[v];
      });
    }
  });

  await prisma.$disconnect();
});
