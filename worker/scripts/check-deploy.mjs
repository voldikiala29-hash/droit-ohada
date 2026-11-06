#!/usr/bin/env node
/*
 * Contrôle automatique AVANT déploiement (correction B4). Ne déploie rien, n'appelle aucune API Cloudflare ou Firebase.
 *
 * Usage :
 *   node scripts/check-deploy.mjs production [chemin.toml]
 *   node scripts/check-deploy.mjs test [chemin.toml]
 *
 * Code de sortie : 0 si tout est conforme, 1 sinon (chaque problème est affiché).
 *
 * Ce contrôle lit un sous-ensemble de TOML (les tableaux et clés utilisés par worker/wrangler.toml). Il ne remplace
 * pas wrangler : il vérifie les valeurs qui ont déjà provoqué ou pourraient provoquer une panne ou une fuite.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkCutoffForDeploy } from "../protocol-cutoff.js";

export const PRODUCTION = {
  project: "salledegarde-89dae",
  origin: "https://salledegarde.online",
  workerName: "muddy-shadow-c8d5"
};

const REASONS = {
  absent: "PROTOCOL_CUTOFF est absent ou vide.",
  placeholder: "PROTOCOL_CUTOFF contient encore le placeholder : fixer la date réelle au moment du déploiement.",
  format: "PROTOCOL_CUTOFF doit être au format ISO 8601 UTC strict AAAA-MM-JJTHH:MM:SSZ (ex. 2099-12-31T23:59:59Z).",
  date_invalide: "PROTOCOL_CUTOFF n'est pas une date existante (ex. 31 février refusé).",
  date_passee: "PROTOCOL_CUTOFF est dans le passé : cela refuserait immédiatement (426) tous les navigateurs sans protocole."
};

/** Lecture minimale : tableaux [[...]] et tables [...], clés chaînes, entiers et tableaux de chaînes. */
export function parseToml(text) {
  const cfg = { vars: {}, kv: [], durable: [], migrations: [], ai: [], name: null };
  let section = "root", current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    let m;
    if ((m = /^\[\[(.+)\]\]$/.exec(line))) {
      section = m[1].trim();
      current = {};
      if (section === "kv_namespaces") cfg.kv.push(current);
      else if (section === "durable_objects.bindings") cfg.durable.push(current);
      else if (section === "migrations") cfg.migrations.push(current);
      continue;
    }
    if ((m = /^\[(.+)\]$/.exec(line))) {
      section = m[1].trim();
      current = section === "vars" ? cfg.vars : section === "ai" ? (cfg.ai[0] = {}) : {};
      continue;
    }
    if ((m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"$/.exec(line))) {
      if (section === "root" && m[1] === "name") cfg.name = m[2];
      else if (current) current[m[1]] = m[2];
      continue;
    }
    if ((m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\[(.*)\]$/.exec(line))) {
      const items = [...m[2].matchAll(/"([^"]*)"/g)].map(x => x[1]);
      if (current) current[m[1]] = items;
      continue;
    }
    if ((m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line))) {
      if (current) current[m[1]] = m[2].trim();
    }
  }
  return cfg;
}

const INT_VARS = ["MAX_MESSAGES_PER_CASE", "USER_REQUESTS_PER_MINUTE", "IP_REQUESTS_PER_MINUTE"];

/**
 * Vérifie une configuration pour une cible ("production" ou "test").
 * Retourne { ok, problems: [string] }.
 */
export function checkConfig(text, target, nowMs = Date.now()) {
  const problems = [];
  if (target !== "production" && target !== "test") {
    return { ok: false, problems: ["Cible inconnue : « " + target + " ». Utiliser production ou test."] };
  }
  const cfg = parseToml(text);
  const v = cfg.vars;

  // Date de transition : format strict, placeholder refusé, date future.
  const cut = checkCutoffForDeploy(v.PROTOCOL_CUTOFF, nowMs);
  if (!cut.ok) problems.push(REASONS[cut.reason] || "PROTOCOL_CUTOFF invalide.");

  for (const key of INT_VARS) {
    if (v[key] !== undefined && !/^\d+$/.test(v[key])) problems.push(key + " doit être un entier.");
  }

  if (!v.FIREBASE_PROJECT_ID) problems.push("FIREBASE_PROJECT_ID est absent.");
  if (!v.ALLOWED_ORIGIN) problems.push("ALLOWED_ORIGIN est absent.");
  else if (v.ALLOWED_ORIGIN.split(",").some(o => o.trim() === "*")) problems.push("ALLOWED_ORIGIN ne doit jamais valoir « * ».");

  // Liaisons : aucun identifiant placeholder, Workers AI, Durable Object et migration SQLite.
  for (const kv of cfg.kv) {
    if (!kv.id || kv.id.indexOf("REMPLACER") !== -1) problems.push("L'identifiant du KV « " + (kv.binding || "?") + " » est un placeholder.");
  }
  if (cfg.ai.length === 0 || !cfg.ai[0].binding) problems.push("La liaison Workers AI est absente.");
  const quota = cfg.durable.find(d => d.name === "QUOTA" && d.class_name === "QuotaLimiter");
  if (!quota) problems.push("La liaison Durable Object QUOTA (classe QuotaLimiter) est absente.");
  const migrated = cfg.migrations.some(mg => Array.isArray(mg.new_sqlite_classes) && mg.new_sqlite_classes.indexOf("QuotaLimiter") !== -1);
  if (!migrated) problems.push("QuotaLimiter doit être déclaré dans une migration new_sqlite_classes (backend SQLite).");

  if (target === "production") {
    if (v.FIREBASE_PROJECT_ID && v.FIREBASE_PROJECT_ID !== PRODUCTION.project) {
      problems.push("Cible production : FIREBASE_PROJECT_ID doit être « " + PRODUCTION.project + " ».");
    }
    if (v.ALLOWED_ORIGIN && v.ALLOWED_ORIGIN !== PRODUCTION.origin) {
      problems.push("Cible production : ALLOWED_ORIGIN doit être « " + PRODUCTION.origin + " ».");
    }
  } else {
    // Environnement de test : aucun lien avec la production (projet Firebase, origine, nom du Worker).
    if (v.FIREBASE_PROJECT_ID === PRODUCTION.project) problems.push("Cible test : le projet Firebase de production est interdit.");
    if (v.FIREBASE_PROJECT_ID && !/(test|staging)/i.test(v.FIREBASE_PROJECT_ID)) {
      problems.push("Cible test : FIREBASE_PROJECT_ID doit contenir « test » ou « staging ».");
    }
    if (v.ALLOWED_ORIGIN && v.ALLOWED_ORIGIN.indexOf(PRODUCTION.origin) !== -1) problems.push("Cible test : l'origine de production est interdite.");
    if (cfg.name === PRODUCTION.workerName) problems.push("Cible test : le nom du Worker de production est interdit.");
  }

  return { ok: problems.length === 0, problems };
}

// Exécution en ligne de commande uniquement.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = process.argv[2];
  const path = process.argv[3] || fileURLToPath(new URL("../wrangler.toml", import.meta.url));
  const result = checkConfig(readFileSync(path, "utf8"), target);
  if (result.ok) {
    console.log("OK : configuration conforme pour la cible « " + target + " » (" + path + ").");
  } else {
    console.error("ÉCHEC : configuration non conforme pour la cible « " + target + " » :");
    for (const p of result.problems) console.error(" - " + p);
    process.exitCode = 1;
  }
}
