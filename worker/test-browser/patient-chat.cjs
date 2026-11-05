// Tests navigateur (Chromium via Playwright) du chat patient : refus, pannes, reprises, doubles clics, hors ligne.
// Le Worker est simulé par routage Playwright ; l'application est servie depuis la racine du dépôt.
// Lancement : node worker/test-browser/patient-chat.cjs   (Playwright doit être installé ; code de sortie 1 si échec)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "../..");
const WORKER = /muddy-shadow-c8d5\.voldikiala29\.workers\.dev/;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png",
  ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".css": "text/css", ".webp": "image/webp", ".ico": "image/x-icon" };

function serve() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(server)));
}

/** Worker simulé : chaque appel consomme la prochaine réponse de la file (sinon 200). Tous les appels sont enregistrés. */
function workerMock(context, origin, queue) {
  const calls = [];
  context.route(WORKER, async (route) => {
    const req = route.request();
    const cors = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-SDG-Protocol, X-SDG-Request-Id",
      "Access-Control-Expose-Headers": "Date, X-SDG-Upgrade" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    calls.push({ headers: req.headers(), body: req.postData() });
    const step = queue.length ? queue.shift() : { status: 200, body: { reponse: "Oui docteur, ça fait quatre jours." } };
    if (step.abort) return route.abort("timedout");
    if (step.delayMs) await sleep(step.delayMs);
    const date = new Date(Date.now() + (step.skewMs || 0)).toUTCString();
    return route.fulfill({ status: step.status, headers: { ...cors, "Content-Type": "application/json", Date: date, ...(step.headers || {}) },
      body: JSON.stringify(step.body === undefined ? { error: "x" } : step.body) });
  });
  return calls;
}

async function openChat(context, base) {
  const p = await context.newPage();
  await p.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(400);
  await signIn(p);
  await p.click("text=Recevoir un patient");
  await p.waitForSelector("#chat-in");
  return p;
}
async function signIn(p) {
  await p.evaluate(() => {
    window._fbAuth = { currentUser: { uid: "uid-test", email: "t@example.org", emailVerified: true, displayName: "Test",
      getIdToken: async () => "tok-test" } };
    document.getElementById("landing-root").style.display = "none";
    document.getElementById("auth-root").style.display = "none";
    document.getElementById("main-ui").style.display = "block";
  });
  await p.waitForTimeout(400);
}
async function ask(p, text) {
  await p.fill("#chat-in", text);
  await p.click("#compose button:has-text('Envoyer')");
}
async function settle(p) {
  await p.waitForTimeout(150);
  await p.waitForFunction(() => !document.querySelector("#main-ui .chat .bubble.typing"), null, { timeout: 15000 });
  await p.waitForTimeout(100);
}
// Sélecteurs limités à l'application (#main-ui) : la page d'accueil contient aussi des démonstrations animées.
const patientBubbles = (p) => p.locator("#main-ui .chat .bubble.p:not(.typing)").count();
const studentBubbles = (p) => p.locator("#main-ui .chat .bubble.d").count();
const notice = (p) => p.locator("#main-ui p[role=status]").first().textContent().then(t => t || "", () => "");
const retryVisible = (p) => p.locator("#compose button:has-text('Réessayer')").count().then(n => n > 0);

const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push(["ok", name]); console.log("ok   -", name); }
  catch (e) { results.push(["fail", name, e.message]); console.log("FAIL -", name, "\n       ", e.message.split("\n")[0]); }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const server = await serve();
  const base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch();
  const newCtx = async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    // Hors bac à sable : Firebase, polices et publicité ne sont pas joignables. Le simulateur est piloté sans eux.
    await ctx.route(/gstatic|googleapis|firebase|adsbygoogle|googletagmanager|google-analytics/, r => r.abort());
    return ctx;
  };

  await scenario("réponse normale : une requête, en-têtes corrects, réponse affichée, rien en attente", async () => {
    const ctx = await newCtx(); const q = []; const calls = workerMock(ctx, base, q);
    const p = await openChat(ctx, base);
    const before = await patientBubbles(p);
    await ask(p, "Depuis quand ?"); await settle(p);
    expect(calls.length === 1, "une requête, reçu " + calls.length);
    const h = calls[0].headers;
    expect(h["x-sdg-protocol"] === "2", "X-SDG-Protocol");
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(h["x-sdg-request-id"] || ""), "identifiant UUID v7");
    expect(h["authorization"] === "Bearer tok-test", "jeton Firebase");
    expect(await patientBubbles(p) === before + 1, "réponse du patient affichée");
    expect(await retryVisible(p) === false, "rien en attente");
    await ctx.close();
  });

  for (const [status, body, expected] of [
    [401, { error: "auth" }, "Connecte-toi"],
    [402, { error: "quota" }, "quota de cas"],
    [409, { error: "messages", quota: { msgCap: 40 } }, "plafond de 40 messages"],
    [429, { error: "rate" }, "Trop de demandes"]
  ]) {
    await scenario(`refus ${status} : aucune réponse du patient, question restituée, pas de reprise automatique`, async () => {
      const ctx = await newCtx(); const calls = workerMock(ctx, base, [{ status, body }]);
      const p = await openChat(ctx, base);
      const before = await patientBubbles(p), sBefore = await studentBubbles(p);
      await ask(p, "Avez-vous de la fièvre ?"); await settle(p);
      expect(calls.length === 1, "une seule requête, reçu " + calls.length);
      expect(await patientBubbles(p) === before, "aucune réponse locale ni distante");
      expect(await studentBubbles(p) === sBefore, "question retirée du journal");
      expect((await p.inputValue("#chat-in")) === "Avez-vous de la fièvre ?", "question restituée dans la saisie");
      expect((await notice(p)).includes(expected), "message pour " + status + " : " + (await notice(p)));
      expect(await retryVisible(p) === false, "pas de bouton Réessayer après un refus");
      await ctx.close();
    });
  }

  await scenario("panne 503 : question conservée, aucune réponse locale, Réessayer renvoie le même identifiant et le même contenu", async () => {
    const ctx = await newCtx(); const calls = workerMock(ctx, base, [{ status: 503, body: { error: "unavailable" } }]);
    const p = await openChat(ctx, base);
    const before = await patientBubbles(p), sBefore = await studentBubbles(p);
    await ask(p, "Où avez-vous mal ?"); await settle(p);
    expect(await patientBubbles(p) === before, "aucune réponse locale après une panne");
    expect(await studentBubbles(p) === sBefore + 1, "la question reste dans le journal");
    expect(await retryVisible(p) === true, "bouton Réessayer");
    expect((await notice(p)).includes("n'a pas répondu"), "message de panne");
    await p.click("#compose button:has-text('Réessayer')"); await settle(p);
    expect(calls.length === 2, "deux requêtes, reçu " + calls.length);
    expect(calls[0].headers["x-sdg-request-id"] === calls[1].headers["x-sdg-request-id"], "même identifiant");
    expect(calls[0].body === calls[1].body, "même contenu, octet pour octet");
    expect(await patientBubbles(p) === before + 1, "la réponse arrive après la reprise");
    expect(await retryVisible(p) === false, "plus rien en attente");
    await ctx.close();
  });

  await scenario("délai réseau (requête interrompue) : aucune réponse locale, reprise possible", async () => {
    const ctx = await newCtx(); const calls = workerMock(ctx, base, [{ abort: true }]);
    const p = await openChat(ctx, base);
    const before = await patientBubbles(p);
    await ask(p, "Quels médicaments avez-vous pris ?"); await settle(p);
    expect(await patientBubbles(p) === before, "aucune réponse locale");
    expect(await retryVisible(p) === true, "Réessayer proposé");
    expect(calls.length === 1, "une tentative automatique seulement");
    await ctx.close();
  });

  await scenario("double clic sur Envoyer : une seule requête", async () => {
    const ctx = await newCtx(); const calls = workerMock(ctx, base, [{ delayMs: 700 }]);
    const p = await openChat(ctx, base);
    await p.fill("#chat-in", "Avez-vous vomi ?");
    const btn = p.locator("#compose button:has-text('Envoyer')");
    await Promise.all([btn.click({ force: true }), btn.click({ force: true }).catch(() => {})]);
    await p.keyboard.press("Control+Enter").catch(() => {});
    await settle(p);
    expect(calls.length === 1, "une seule requête, reçu " + calls.length);
    await ctx.close();
  });

  await scenario("réponse 409 in_progress : question conservée, message d'attente, reprise possible", async () => {
    const ctx = await newCtx(); const calls = workerMock(ctx, base, [{ status: 409, body: { error: "in_progress" } }]);
    const p = await openChat(ctx, base);
    await ask(p, "Avez-vous des allergies ?"); await settle(p);
    expect((await notice(p)).includes("répond encore"), "message d'attente : " + (await notice(p)));
    expect(await retryVisible(p) === true, "Réessayer");
    await p.click("#compose button:has-text('Réessayer')"); await settle(p);
    expect(calls[0].headers["x-sdg-request-id"] === calls[1].headers["x-sdg-request-id"], "même identifiant à la reprise");
    await ctx.close();
  });

  await scenario("hors ligne : aucune requête ; reprise en ligne avec le même identifiant", async () => {
    const ctx = await newCtx(); const calls = workerMock(ctx, base, []);
    const p = await openChat(ctx, base);
    await ctx.setOffline(true);
    await p.waitForTimeout(200);
    await ask(p, "Depuis quand ?"); await settle(p);
    expect(calls.length === 0, "aucune requête hors ligne, reçu " + calls.length);
    expect(await retryVisible(p) === true, "question conservée");
    await ctx.setOffline(false);
    await p.waitForTimeout(200);
    await p.click("#compose button:has-text('Réessayer')"); await settle(p);
    expect(calls.length === 1, "une requête au retour en ligne");
    await ctx.close();
  });

  await scenario("rechargement pendant une question en attente : Réessayer réapparaît, sans nouvelle question", async () => {
    const ctx = await newCtx(); const calls = workerMock(ctx, base, [{ status: 502, body: { error: "unavailable" } }]);
    const p = await openChat(ctx, base);
    await ask(p, "Avez-vous de la fièvre ?"); await settle(p);
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForTimeout(400);
    await signIn(p);
    await p.click("text=Recevoir un patient").catch(() => {});
    await p.waitForSelector("#compose", { timeout: 5000 });
    expect(await retryVisible(p) === true, "Réessayer après rechargement");
    await p.click("#compose button:has-text('Réessayer')"); await settle(p);
    expect(calls.length === 2 && calls[0].headers["x-sdg-request-id"] === calls[1].headers["x-sdg-request-id"], "même identifiant après rechargement");
    await ctx.close();
  });

  await scenario("426 (version trop ancienne) : mise à jour demandée, question restituée", async () => {
    const ctx = await newCtx(); const calls = workerMock(ctx, base, [{ status: 426, body: { error: "upgrade_required" } }]);
    const p = await openChat(ctx, base);
    await ask(p, "Depuis quand ?"); await settle(p);
    expect(calls.length === 1, "une requête");
    expect((await notice(p)).includes("Mets l'application à jour"), "message de mise à jour");
    expect((await p.inputValue("#chat-in")) === "Depuis quand ?", "question restituée");
    await ctx.close();
  });

  await scenario("en-tête X-SDG-Upgrade sur une réponse 200 : réponse affichée et avertissement", async () => {
    const ctx = await newCtx(); workerMock(ctx, base, [{ status: 200, body: { reponse: "Depuis trois jours." }, headers: { "X-SDG-Upgrade": "requis" } }]);
    const p = await openChat(ctx, base);
    const before = await patientBubbles(p);
    await ask(p, "Depuis quand ?"); await settle(p);
    expect(await patientBubbles(p) === before + 1, "réponse affichée");
    expect((await notice(p)).includes("nouvelle version"), "avertissement de mise à jour");
    await ctx.close();
  });

  await scenario("requête rejouée par le Worker (replay) : une seule bulle de réponse, pas de doublon", async () => {
    const ctx = await newCtx(); const calls = workerMock(ctx, base, [{ status: 503, body: {} }, { status: 200, body: { reponse: "Depuis trois jours.", replay: true } }]);
    const p = await openChat(ctx, base);
    const before = await patientBubbles(p), sBefore = await studentBubbles(p);
    await ask(p, "Depuis quand ?"); await settle(p);
    await p.click("#compose button:has-text('Réessayer')"); await settle(p);
    expect(await patientBubbles(p) === before + 1, "une seule réponse");
    expect(await studentBubbles(p) === sBefore + 1, "une seule question dans le journal");
    expect(calls.length === 2, "deux requêtes, même question");
    await ctx.close();
  });

  await scenario("horloge de l'appareil en retard : 410 sur une demande neuve, recréée une fois, réponse affichée", async () => {
    const ctx = await newCtx();
    const calls = workerMock(ctx, base, [{ status: 410, body: { error: "request_expired" }, skewMs: 3 * 3600e3 }, { status: 200, body: { reponse: "Oui." }, skewMs: 3 * 3600e3 }]);
    const p = await openChat(ctx, base);
    const before = await patientBubbles(p);
    await ask(p, "Depuis quand ?"); await settle(p);
    expect(calls.length === 2, "deux requêtes, reçu " + calls.length);
    expect(calls[0].headers["x-sdg-request-id"] !== calls[1].headers["x-sdg-request-id"], "nouvel identifiant");
    expect(calls[0].body === calls[1].body, "même question");
    expect(await patientBubbles(p) === before + 1, "réponse affichée");
    await ctx.close();
  });

  await browser.close();
  server.close();
  const failed = results.filter(r => r[0] === "fail");
  console.log(`\n${results.length - failed.length}/${results.length} scénarios réussis`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
