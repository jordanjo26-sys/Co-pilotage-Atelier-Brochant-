import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execSync } from "node:child_process";
import dotenv from "dotenv";
import { calculerCreneauxLibres, formaterCreneau, HorairesRendezVous } from "../src/services/agenda";
import { direEtEcouter, echapperXml, signatureTwilio, signatureTwilioValide } from "../src/services/twilio";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const HORAIRES: HorairesRendezVous = {
  lundi: [["08:00", "12:00"]],
  mardi: [["08:00", "10:00"], ["14:00", "16:00"]],
};

test("creneaux : decoupe les plages d'ouverture en heure de Paris", () => {
  // Lundi 5 octobre 2026, 7h00 a Paris (5h00 UTC, heure d'ete).
  const maintenant = new Date("2026-10-05T05:00:00Z");
  const creneaux = calculerCreneauxLibres([], maintenant, {
    horaires: HORAIRES,
    dureeMinutes: 60,
    delaiMinimumHeures: 2,
    joursRecherche: 7,
    maximum: 3,
  });
  // Delai de 2 h -> au plus tot 9h00 a Paris.
  assert.deepEqual(
    creneaux.map((c) => c.debut.toISOString()),
    ["2026-10-05T07:00:00.000Z", "2026-10-05T08:00:00.000Z", "2026-10-05T09:00:00.000Z"]
  );
});

test("creneaux : ecarte les creneaux deja occupes et les jours fermes", () => {
  const maintenant = new Date("2026-10-05T14:00:00Z"); // lundi 16h, plus de creneau ce jour
  const occupes = [{ debut: new Date("2026-10-06T06:30:00Z"), fin: new Date("2026-10-06T07:30:00Z") }]; // mardi 8h30-9h30
  const creneaux = calculerCreneauxLibres(occupes, maintenant, {
    horaires: HORAIRES,
    dureeMinutes: 60,
    delaiMinimumHeures: 2,
    joursRecherche: 3,
    maximum: 5,
  });
  assert.deepEqual(
    creneaux.map((c) => formaterCreneau(c.debut)),
    ["mardi 6 octobre a 14h00", "mardi 6 octobre a 15h00"]
  );
});

test("creneaux : a partir d'un jour souhaite", () => {
  const creneaux = calculerCreneauxLibres([], new Date("2026-10-05T05:00:00Z"), {
    horaires: HORAIRES,
    dureeMinutes: 120,
    delaiMinimumHeures: 2,
    joursRecherche: 7,
    maximum: 1,
    aPartirDu: "2026-10-13",
  });
  assert.equal(formaterCreneau(creneaux[0].debut), "mardi 13 octobre a 08h00");
});

test("creneaux : ouverture 24 h/24 (fermeture a 24:00)", () => {
  // Lundi 5 octobre 2026, 21h30 a Paris : premier creneau a 23h30, puis la nuit.
  const creneaux = calculerCreneauxLibres([], new Date("2026-10-05T19:30:00Z"), {
    horaires: { lundi: [["00:00", "24:00"]], mardi: [["00:00", "24:00"]] },
    dureeMinutes: 60,
    delaiMinimumHeures: 2,
    joursRecherche: 2,
    maximum: 3,
  });
  assert.deepEqual(
    creneaux.map((c) => formaterCreneau(c.debut)),
    ["mardi 6 octobre a 00h00", "mardi 6 octobre a 01h00", "mardi 6 octobre a 02h00"]
  );
});

test("twilio : signature verifiee, toute alteration rejetee", () => {
  const url = "https://copilotage-brochant.fr/telephonie/tour";
  const params = { CallSid: "CA123", SpeechResult: "Bonjour, mon evier est bouche", From: "+33612345678" };
  const signature = signatureTwilio("jeton", url, params);
  assert.ok(signatureTwilioValide("jeton", url, params, signature));
  assert.ok(!signatureTwilioValide("autre-jeton", url, params, signature));
  assert.ok(!signatureTwilioValide("jeton", url, { ...params, From: "+33000000000" }, signature));
  assert.ok(!signatureTwilioValide("jeton", url, params, undefined));
});

test("twilio : le texte prononce est echappe dans le TwiML", () => {
  assert.equal(echapperXml(`<a & "b">`), "&lt;a &amp; &quot;b&quot;&gt;");
  const xml = direEtEcouter("Dupont & fils <test>", "/telephonie/tour");
  assert.ok(xml.includes("Dupont &amp; fils &lt;test&gt;"));
  assert.ok(xml.includes('action="/telephonie/tour"'));
});

test("standard telephonique : tours de conversation, message et compte rendu", async (t) => {
  const testDatabaseUrl =
    process.env.TEST_DATABASE_URL ||
    (process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/(\?|$)/, "_test$1") : undefined);
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL (ou DATABASE_URL) manquante : voir .env.example.");
  process.env.DATABASE_URL = testDatabaseUrl;
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "pipe",
  });

  const { PrismaClient } = await import("@prisma/client");
  const { demarrerAppel, traiterTour, construireCompteRendu, finaliserAppel } = await import(
    "../src/services/standardTelephonique"
  );
  const prisma = new PrismaClient();

  // Faux client Claude : rejoue des reponses scriptees et garde les requetes.
  function fauxClient(reponses: unknown[]) {
    const requetes: { messages: unknown[] }[] = [];
    const client = {
      beta: {
        messages: {
          create: async (params: { messages: unknown[] }) => {
            requetes.push({ messages: [...params.messages] });
            const r = reponses.shift();
            if (r instanceof Error) throw r;
            return r;
          },
        },
      },
    };
    return { client: client as never, requetes };
  }

  await t.test("appel complet : message note puis fin d'appel", async () => {
    let appel = await demarrerAppel(prisma, "CA-1", "+33611223344");
    const { client, requetes } = fauxClient([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "enregistrer_message",
            input: { nom: "Mme Martin", adresse: "12 rue Brochant, 75017 Paris", motif: "WC bouche", urgence: "urgente" },
          },
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "C'est note, Madame Martin. Autre chose ?" }] },
    ]);
    const tour1 = await traiterTour(prisma, appel, "Mes toilettes sont bouchees, ca deborde", client);
    assert.equal(tour1.reponse, "C'est note, Madame Martin. Autre chose ?");
    assert.equal(tour1.raccrocher, false);
    // Le resultat d'outil est renvoye a Claude dans la meme requete suivante.
    assert.equal(requetes.length, 2);

    appel = await prisma.appel.findUniqueOrThrow({ where: { callSid: "CA-1" } });
    assert.equal(appel.nom, "Mme Martin");
    assert.equal(appel.urgence, "urgente");

    const { client: client2 } = fauxClient([
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t2", name: "terminer_appel", input: { message_final: "Au revoir Madame." } }],
      },
    ]);
    const tour2 = await traiterTour(prisma, appel, "Non merci, au revoir", client2);
    assert.deepEqual(tour2, { reponse: "Au revoir Madame.", raccrocher: true });

    appel = await prisma.appel.findUniqueOrThrow({ where: { callSid: "CA-1" } });
    const { sujet, texte } = construireCompteRendu(appel);
    assert.equal(sujet, "URGENT - Appel de Mme Martin");
    assert.ok(texte.includes("A rappeler au : +33611223344"));
    assert.ok(texte.includes("Appelant : Mes toilettes sont bouchees, ca deborde"));
  });

  await t.test("echec de l'IA : les propos de l'appelant sont gardes pour le tour suivant", async () => {
    let appel = await demarrerAppel(prisma, "CA-2", null);
    const { client } = fauxClient([new Error("delai depasse")]);
    await assert.rejects(traiterTour(prisma, appel, "Je voudrais un devis", client));

    appel = await prisma.appel.findUniqueOrThrow({ where: { callSid: "CA-2" } });
    assert.equal(appel.enAttente, "Je voudrais un devis");
    assert.equal(appel.erreurs, 1);

    const { client: client2, requetes } = fauxClient([
      { stop_reason: "end_turn", content: [{ type: "text", text: "Bien sur, a quel nom ?" }] },
    ]);
    await traiterTour(prisma, appel, "pour un debouchage", client2);
    const derniers = requetes[0].messages as { role: string; content: unknown }[];
    assert.deepEqual(derniers[derniers.length - 1], { role: "user", content: "Je voudrais un devis pour un debouchage" });
    // Historique coherent : accueil, contexte et un seul tour utilisateur ajoute.
    assert.equal(derniers.length, 3);

    appel = await prisma.appel.findUniqueOrThrow({ where: { callSid: "CA-2" } });
    assert.equal(appel.enAttente, null);
  });

  await t.test("fin d'appel sans boite Gmail : compte rendu journalise une seule fois", async () => {
    await finaliserAppel(prisma, "CA-1");
    await finaliserAppel(prisma, "CA-1");
    const evenements = await prisma.journalEvenement.findMany({ where: { evenement: "appel_non_notifie" } });
    assert.equal(evenements.length, 1);
    const appel = await prisma.appel.findUniqueOrThrow({ where: { callSid: "CA-1" } });
    assert.equal(appel.statut, "termine");
  });

  await prisma.$disconnect();
});
