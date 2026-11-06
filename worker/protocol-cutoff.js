/*
 * Règle unique de format pour PROTOCOL_CUTOFF (correction B4).
 *
 * Utilisée par le Worker au moment de chaque requête (échec fermé si la valeur est invalide) et par le contrôle
 * automatique avant déploiement (worker/scripts/check-deploy.mjs), qui refuse en plus une date déjà passée.
 *
 * Format accepté : uniquement ISO 8601 UTC, exactement "AAAA-MM-JJTHH:MM:SSZ" (sans millisecondes, sans décalage).
 * Refusés : "05/12/2026" (ambigu : 5 décembre ou 12 mai selon le pays), "2026-12-05" (sans heure), "...000Z",
 * "+01:00", date inexistante (2026-02-31), placeholder "REMPLACER_...", chaîne vide.
 */
const STRICT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/**
 * Analyse une date de transition. Retourne { ok: true, ms } ou { ok: false, reason }.
 * reason : "absent" | "placeholder" | "format" | "date_invalide".
 */
export function parseStrictCutoff(raw) {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "absent" };
  if (raw.indexOf("REMPLACER") !== -1) return { ok: false, reason: "placeholder" };
  const m = STRICT.exec(raw);
  if (!m) return { ok: false, reason: "format" };
  const ms = Date.parse(raw);
  // Refuse les dates qui n'existent pas (ex. 31 février) : Date les « corrige » silencieusement.
  if (Number.isNaN(ms) || new Date(ms).toISOString().replace(".000Z", "Z") !== raw) {
    return { ok: false, reason: "date_invalide" };
  }
  return { ok: true, ms };
}

/**
 * Contrôle avant déploiement : format strict, et date encore dans le futur au moment du contrôle.
 * Une date passée réactiverait immédiatement le refus 426 pour tous les navigateurs sans en-tête de protocole.
 */
export function checkCutoffForDeploy(raw, nowMs) {
  const parsed = parseStrictCutoff(raw);
  if (!parsed.ok) return parsed;
  if (parsed.ms <= nowMs) return { ok: false, reason: "date_passee" };
  return { ok: true, ms: parsed.ms };
}
