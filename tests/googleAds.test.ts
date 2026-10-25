import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execSync } from "node:child_process";
import dotenv from "dotenv";
import { clauseFenetreDate, googleAdsEstConfigure, extraireExemptionsPolitique } from "../src/services/googleAds";

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

test("clauseFenetreDate : fenetre BETWEEN sur le nombre de jours demande", () => {
  const clause = clauseFenetreDate(30);
  assert.match(clause, /^BETWEEN '\d{4}-\d{2}-\d{2}' AND '\d{4}-\d{2}-\d{2}'$/);
});

test("googleAdsEstConfigure : faux tant qu'une des variables requises manque", () => {
  const sauvegarde = {
    token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    customerId: process.env.GOOGLE_ADS_CUSTOMER_ID,
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  };
  try {
    delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    delete process.env.GOOGLE_ADS_CUSTOMER_ID;
    process.env.GOOGLE_CLIENT_ID = "id-test";
    process.env.GOOGLE_CLIENT_SECRET = "secret-test";
    assert.equal(googleAdsEstConfigure(), false);

    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "jeton-test";
    process.env.GOOGLE_ADS_CUSTOMER_ID = "1234567890";
    assert.equal(googleAdsEstConfigure(), true);
  } finally {
    for (const [cle, valeur] of Object.entries({
      GOOGLE_ADS_DEVELOPER_TOKEN: sauvegarde.token,
      GOOGLE_ADS_CUSTOMER_ID: sauvegarde.customerId,
      GOOGLE_CLIENT_ID: sauvegarde.clientId,
      GOOGLE_CLIENT_SECRET: sauvegarde.clientSecret,
    })) {
      if (valeur === undefined) delete process.env[cle];
      else process.env[cle] = valeur;
    }
  }
});

test("listerCampagnesAds : non configure -> erreur explicite", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const { listerCampagnesAds } = await import("../src/services/googleAds");
  const prisma = new PrismaClient();

  await t.test("rejette avec un message explicite", async () => {
    const sauvegarde = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    try {
      await assert.rejects(listerCampagnesAds(prisma), /Google Ads non configure/);
    } finally {
      if (sauvegarde !== undefined) process.env.GOOGLE_ADS_DEVELOPER_TOKEN = sauvegarde;
    }
  });

  await prisma.$disconnect();
});

// Les trois fonctions suivantes (ciblage geographique, modification de
// budget, ajout de mots-cles positifs) sont les nouveaux modules demandes
// pour rendre Morgane autonome en creation ET en modification de campagne.
// Meme principe que ci-dessus : verifie seulement l'echec propre sans
// configuration, jamais un vrai appel API dans un test automatique.
test("rechercherCiblesGeographiques, changerBudgetCampagne, ajouterMotsClesPositifs : non configure -> erreur explicite", async (t) => {
  const { PrismaClient } = await import("@prisma/client");
  const {
    rechercherCiblesGeographiques,
    changerBudgetCampagne,
    ajouterMotsClesPositifs,
    ajouterExtensionsCampagne,
    changerStrategieEncheres,
    definirHorairesCampagne,
    rechercherAudiences,
    ajouterAudiencesCampagne,
    ajouterAnnonceTest,
    listerPerformanceAnnonces,
  } = await import("../src/services/googleAds");
  const prisma = new PrismaClient();

  const sauvegarde = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  try {
    await t.test("rechercherCiblesGeographiques rejette avec un message explicite", async () => {
      await assert.rejects(rechercherCiblesGeographiques(prisma, ["Île-de-France"]), /Google Ads non configure/);
    });

    await t.test("changerBudgetCampagne rejette avec un message explicite", async () => {
      await assert.rejects(changerBudgetCampagne(prisma, "123456", 40), /Google Ads non configure/);
    });

    await t.test("ajouterMotsClesPositifs rejette avec un message explicite", async () => {
      await assert.rejects(ajouterMotsClesPositifs(prisma, "456", ["serrurier fichet essonne"]), /Google Ads non configure/);
    });

    await t.test("ajouterExtensionsCampagne rejette avec un message explicite", async () => {
      await assert.rejects(ajouterExtensionsCampagne(prisma, "123456", { callouts: ["Intervention rapide"] }), /Google Ads non configure/);
    });

    await t.test("changerStrategieEncheres rejette avec un message explicite", async () => {
      await assert.rejects(changerStrategieEncheres(prisma, "123456", "TARGET_CPA", 40), /Google Ads non configure/);
    });

    await t.test("definirHorairesCampagne rejette avec un message explicite", async () => {
      await assert.rejects(definirHorairesCampagne(prisma, "123456", [{ jour: "MONDAY", heureDebut: 8, heureFin: 19 }]), /Google Ads non configure/);
    });

    await t.test("rechercherAudiences rejette avec un message explicite", async () => {
      await assert.rejects(rechercherAudiences(prisma, ["Propriétaires de maison"]), /Google Ads non configure/);
    });

    await t.test("ajouterAudiencesCampagne rejette avec un message explicite", async () => {
      await assert.rejects(ajouterAudiencesCampagne(prisma, "123456", ["Propriétaires de maison"]), /Google Ads non configure/);
    });

    await t.test("ajouterAnnonceTest rejette avec un message explicite", async () => {
      await assert.rejects(
        ajouterAnnonceTest(prisma, "456", ["Serrurier Fichet", "Intervention Rapide", "Appelez-nous"], ["Serrurier pour serrures Fichet.", "Intervention rapide."], "https://fichet-depannage.fr"),
        /Google Ads non configure/
      );
    });

    await t.test("listerPerformanceAnnonces rejette avec un message explicite", async () => {
      await assert.rejects(listerPerformanceAnnonces(prisma, "456"), /Google Ads non configure/);
    });
  } finally {
    if (sauvegarde !== undefined) process.env.GOOGLE_ADS_DEVELOPER_TOKEN = sauvegarde;
  }

  await prisma.$disconnect();
});

test("extraireExemptionsPolitique", async (t) => {
  await t.test("extrait la cle d'exemption quand toutes les erreurs du lot sont des violations exemptibles", () => {
    const err = {
      errors: [
        {
          location: { field_path_elements: [{ field_name: "operations", index: 0 }, { field_name: "create" }, { field_name: "keyword" }, { field_name: "text" }] },
          details: { policy_violation_details: { is_exemptible: true, key: { policy_name: "LOCAL_SERVICES_POLICY_ABC123", violating_text: "serrurier paris" } } },
        },
      ],
    };
    const exemptions = extraireExemptionsPolitique(err, 5);
    assert.ok(exemptions);
    assert.deepEqual(exemptions!.get(0), { policyName: "LOCAL_SERVICES_POLICY_ABC123", violatingText: "serrurier paris" });
  });

  await t.test("gere plusieurs operations en echec dans le meme lot", () => {
    const erreurPour = (index: number, policyName: string) => ({
      location: { field_path_elements: [{ field_name: "operations", index }] },
      details: { policy_violation_details: { is_exemptible: true, key: { policy_name: policyName } } },
    });
    const err = { errors: [erreurPour(0, "POLICY_A"), erreurPour(3, "POLICY_B")] };
    const exemptions = extraireExemptionsPolitique(err, 5);
    assert.ok(exemptions);
    assert.equal(exemptions!.size, 2);
    assert.equal(exemptions!.get(0)?.policyName, "POLICY_A");
    assert.equal(exemptions!.get(3)?.policyName, "POLICY_B");
  });

  await t.test("retourne null si une seule erreur du lot n'est pas exemptible", () => {
    const err = {
      errors: [
        {
          location: { field_path_elements: [{ field_name: "operations", index: 0 }] },
          details: { policy_violation_details: { is_exemptible: true, key: { policy_name: "POLICY_A" } } },
        },
        {
          location: { field_path_elements: [{ field_name: "operations", index: 1 }] },
          details: { policy_violation_details: { is_exemptible: false, key: { policy_name: "POLICY_B" } } },
        },
      ],
    };
    assert.equal(extraireExemptionsPolitique(err, 5), null);
  });

  await t.test("retourne null pour une erreur qui n'est pas une violation de politique (ex. champ manquant)", () => {
    const err = { errors: [{ message: "The required field was not present.", error_code: { required_error: "REQUIRED" } }] };
    assert.equal(extraireExemptionsPolitique(err, 5), null);
  });

  await t.test("retourne null si l'index d'operation est hors bornes ou absent", () => {
    const err = {
      errors: [{ location: { field_path_elements: [{ field_name: "create" }] }, details: { policy_violation_details: { is_exemptible: true, key: { policy_name: "POLICY_A" } } } }],
    };
    assert.equal(extraireExemptionsPolitique(err, 5), null);
  });

  await t.test("retourne null si err.errors est absent ou vide", () => {
    assert.equal(extraireExemptionsPolitique({}, 5), null);
    assert.equal(extraireExemptionsPolitique({ errors: [] }, 5), null);
    assert.equal(extraireExemptionsPolitique(new Error("autre chose"), 5), null);
  });
});
