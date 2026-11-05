# Worker du patient virtuel : configuration, tests, déploiement

Ce Worker appelle Workers AI au nom d'un utilisateur connecté. Il exige un jeton Firebase, applique les quotas
et refuse de répondre si sa configuration est incomplète (échec fermé).

> **Rien n'est déployé par cette branche.** Le fichier `wrangler.toml` décrit la cible ; il contient un identifiant
> de remplacement (`REMPLACER_PAR_ID_KV_STATE`) et ne peut donc pas être déployé tel quel.

## 1. Liaisons Cloudflare

| Nom | Type | Rôle | Obligatoire |
|---|---|---|---|
| `AI` | Workers AI | Génération des réponses du patient | Oui |
| `STATE` | Workers KV | **Lecture seule** : plans Premium (`plan:<uid>`) | Oui |
| `QUOTA` | Durable Object `QuotaLimiter` | Quotas, plafond de messages, limites de débit (atomiques) | Oui |

L'ancienne liaison `RATE` (KV, par IP) n'est plus utilisée : la limite par IP est désormais portée par le Durable Object.

## 2. Variables

| Variable | Défaut | Rôle |
|---|---|---|
| `ALLOWED_ORIGIN` | `https://salledegarde.online` | Origine autorisée (liste séparée par des virgules) |
| `FIREBASE_PROJECT_ID` | `salledegarde-89dae` | Projet dont les jetons sont acceptés |
| `MAX_MESSAGES_PER_CASE` | `40` | Messages IA maximum par cas et par mois |
| `USER_REQUESTS_PER_MINUTE` | `20` | Requêtes IA par minute et par utilisateur |
| `IP_REQUESTS_PER_MINUTE` | `20` | Requêtes par minute et par adresse IP (avant vérification du jeton) |

Une variable présente mais invalide (par exemple `MAX_MESSAGES_PER_CASE=abc`) fait répondre **503** : le Worker ne
retombe pas silencieusement sur une valeur par défaut. Valeurs acceptées : entiers de 1 à 1000.

Quotas commerciaux (dans le code, `patient-worker.js`) : 5 cas distincts par mois en gratuit, 150 en Premium, 40 messages maximum par utilisateur et par cas et par mois.
**Ne pas modifier sans validation.**

## 3. Configuration Durable Objects

- `wrangler.toml` déclare la liaison `QUOTA` et la migration `v1` (`new_sqlite_classes = ["QuotaLimiter"]`).
- La migration crée la classe ; **aucune donnée n'est migrée** (les compteurs démarrent à zéro).
- Les Durable Objects sont disponibles sur les formules Cloudflare courantes, mais vérifier l'accès sur le compte
  avant déploiement.
- Ne jamais retirer la migration `v1` ni renommer la classe : cela supprimerait les compteurs existants.

## 4. Plans Premium (procédure provisoire)

L'identifiant d'un utilisateur est visible dans son profil (champ « Identifiant »).

```bash
# Accorder Premium jusqu'à une date
wrangler kv key put --binding=STATE "plan:<UID>" \
  '{"plan":"premium","until":"2026-12-31T23:59:59Z"}'

# Revenir à la formule gratuite
wrangler kv key delete --binding=STATE "plan:<UID>"
```

Le Worker lit cet enregistrement à chaque requête. Un changement peut mettre environ une minute à être pris en compte
(cohérence finale de KV). Aucune route du Worker, ni le navigateur, ni Firestore ne peut écrire cet enregistrement.

## 5. Ce que fait le Worker, dans l'ordre

1. Origine et méthode (403 / 405).
2. Configuration : liaisons et variables (503 si incomplète).
3. Validation stricte du contenu (400) : `persona` commence par « Tu es », `facts` = lignes « - », `step` parmi les
   quatre étapes, `history` = `d` ou `p`, `cas.id` parmi les **302 identifiants** autorisés, pas de caractères de contrôle.
4. Limite de débit par IP (429), via le Durable Object `ip:<adresse>`.
5. Vérification du jeton Firebase (401) puis de l'email (403).
6. Réservation atomique (`QUOTA`, objet `uid:<uid>`) : débit (429), quota de cas (402), plafond de messages (402).
7. Appel à l'IA. Si l'IA échoue ou répond vide, la réservation est **libérée** (502).

## 6. Codes de réponse

| Code | Erreur | Signification |
|---|---|---|
| 200 | — | Réponse du patient, avec le détail du quota |
| 400 | `message`, `persona`, `facts`, `step`, `history`, `cas`, `json` | Contenu refusé par la validation |
| 401 | `auth` | Jeton absent, invalide, expiré ou d'un autre projet |
| 402 | `quota` / `messages` | Quota de cas ou plafond de messages atteint |
| 403 | `origin` / `email_unverified` | Origine non autorisée ou email non vérifié |
| 405 | `method` | Méthode autre que POST |
| 429 | `rate` | Trop de requêtes (IP ou utilisateur) |
| 502 | `unavailable` | L'IA n'a pas répondu ; réservation libérée |
| 503 | `config` / `unavailable` | Configuration ou stockage indisponible : aucune réponse IA |

Le navigateur traite **tout code d'erreur** comme un retour au moteur local : la consultation continue sans IA.

## 7. Limites connues

- **Persona et faits** viennent encore du navigateur. La validation réduit la surface (format, taille, caractères) mais
  ne protège pas le patient contre une injection de consigne. La vraie protection demande C1 : le serveur doit
  construire le persona et les faits à partir des cas.
- **Identifiant de cas** : il est vérifié contre la liste des 302 identifiants, mais la liste n'est pas le contenu.
  Ce n'est pas une protection complète de C1.
- **Comptes multiples** : un étudiant peut créer plusieurs comptes pour multiplier les 5 cas gratuits.
- **Moteur local** : après un refus, la simulation continue sans IA et sans quota.

## 8. Tests

```bash
cd worker
npm test                     # 53 tests, Node 22
npm run check:case-ids       # vérifie que case-ids.js correspond à cases_202.js
node scripts/build-case-ids.mjs   # régénère case-ids.js si cases_202.js change
```

| Fichier | Couvre |
|---|---|
| `test/quota-limiter.test.mjs` | Atomicité (100 réservations simultanées), plafonds, libération, changement de mois, débit |
| `test/patient-worker.test.mjs` | Jetons (signature, `alg: none`, émetteur, audience, expiration), email, quotas en concurrence, Premium, plafond de messages, identifiants inventés, échec fermé, origine, débit par IP, rotation des clés |
| `test/validation.test.mjs` | Validation stricte, et acceptation des **302 cas réels** au format du navigateur |
| `test/client-static.test.mjs` | Adresse du Worker figée, mode debug supprimé, jeton envoyé à un seul endroit, syntaxe des scripts |

**Limite des tests** : le stockage et les Durable Objects sont simulés (`test/helpers.mjs`). Le test de concurrence
prouve la logique sérialisée, pas le comportement exact du runtime Cloudflare. Un test de mutation a été fait :
sans la sérialisation du Durable Object, les tests de concurrence échouent.

Tests **non automatisables ici**, à faire sur un environnement de préproduction (voir `docs/securite-phase-1.md`).

## 9. Procédure de déploiement (future, après validation et fusion)

Ne jamais déployer depuis cette branche sans validation. L'ordre compte : le client change dès la fusion sur `main`.

1. Créer l'espace KV de préproduction, puis renseigner son identifiant dans `wrangler.toml` (ou via `--env`).
2. Vérifier la liaison `AI` et la présence du Durable Object sur le compte.
3. `npx wrangler deploy --dry-run` : vérifie la configuration sans rien publier.
4. `npm test` et `npm run check:case-ids` doivent passer.
5. Déployer **le Worker d'abord** : `npx wrangler deploy` (environnement de préproduction).
6. Tests de fumée (voir ci-dessous) sur la préproduction.
7. Déployer le Worker en production.
8. Fusionner la Pull Request. GitHub Pages publie le client, qui envoie maintenant le jeton.

**Pourquoi cet ordre** : l'ancien Worker n'autorise que `Content-Type` dans ses en-têtes CORS. Un client qui envoie
`Authorization` avant que le nouveau Worker soit en place verrait ses requêtes bloquées et basculerait sur le moteur
local pour tous. Inversement, un nouveau Worker avec l'ancien client renvoie 401 et les consultations passent aussi
au moteur local. Une courte coupure de l'IA est donc inévitable à la bascule ; la planifier.

### Tests de fumée après déploiement
- Sans jeton : 401.
- Avec un jeton valide, un cas réel : 200 et `quota.used` = 1.
- Avec un identifiant inventé : 400.
- Depuis une origine autre que `salledegarde.online` : 403.

## 10. Migration des données

- Les anciennes clés KV `usage:<uid>:<mois>` ne sont plus lues. **Elles ne sont pas supprimées** (aucune suppression de données).
- Conséquence au premier déploiement : les quotas du mois en cours repartent à zéro pour tous. C'est un choix à
  valider, sinon il faudrait migrer les compteurs.
- Aucune migration de `plan:<uid>` : le format est inchangé.

## 11. Retour arrière

1. Revenir au Worker précédent : `npx wrangler rollback` (ou redéployer le commit précédent).
2. Si le client pose problème : revenir au commit précédent de `index.html` sur `main` ; le moteur local reste
   disponible dans tous les cas.
3. **Ne pas supprimer** le Durable Object `QuotaLimiter` ni la migration `v1`. Les compteurs restent en place et sont
   ignorés par l'ancien Worker.
4. Les réservations en cours au moment du retour arrière ne sont pas rejouées : au pire, un utilisateur perd une consultation IA du mois.
