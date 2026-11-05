# Sécurité, Phase 1 : état après correction

Branche : `securite/phase-1-cases-worker-scores`. Aucune fusion, aucun déploiement, `main` non modifiée.

## Périmètre de cette étape

Six corrections demandées sur le Worker IA (C2). **C1 (cas et corrigés côté serveur) et C3 (scores côté serveur)
ne sont pas commencés.**

## 1. Corrections réalisées

### 1.1 Quotas atomiques (Durable Objects)
- Le quota, le plafond de messages et la limite de débit sont portés par un Durable Object `QuotaLimiter`
  (un objet par utilisateur, un par IP).
- Les opérations sont exécutées l'une après l'autre : deux requêtes simultanées ne peuvent plus écraser le même compteur.
- La réservation est faite **avant** l'appel à l'IA et libérée si l'IA échoue. Un échec ne consomme donc rien.
- Workers KV n'est plus utilisé pour les compteurs ; il reste en lecture seule pour les plans Premium.

### 1.2 Plafond de messages par cas
- 40 messages IA maximum par cas et par mois (`MAX_MESSAGES_PER_CASE`, configurable, valeur invalide = 503).
- Le plafond est appliqué côté serveur.
- Choix : le plafond porte sur le couple (utilisateur, cas, mois), et non sur une « consultation » identifiée par le
  client. Un identifiant de consultation fourni par le navigateur pourrait être renouvelé à volonté et rendrait le coût
  à nouveau illimité. **À valider.**

### 1.3 Identifiants de cas contre une liste autorisée
- `worker/case-ids.js` contient les 302 identifiants, générés depuis `cases_202.js` par `scripts/build-case-ids.mjs`.
  Aucun contenu médical n'est copié.
- Un identifiant inconnu est refusé (400) avant tout appel à l'IA.
- **Ce n'est pas une protection complète de C1** : la liste ne contient pas le contenu, et le persona et les faits
  viennent encore du navigateur.

### 1.4 Renouvellement du cache JWKS
- Un `kid` inconnu (rotation des clés Google) déclenche un rechargement.
- Délai de carence de 5 minutes entre deux rechargements, pour qu'un attaquant ne puisse pas faire interroger Google
  en boucle.

### 1.5 Adresse du Worker figée ; mode debug supprimé
- `LLM_URL` est une constante (`WORKER_URL`). La variable `window.SDG_LLM_URL` n'est plus lue : le jeton Firebase ne peut
  pas être envoyé à une autre adresse.
- Le point d'accès `window._sdgDbg` (activé par `?debug=1`) est supprimé. Il exposait tous les cas et l'état de la
  consultation, sans contrôle.

### 1.6 Validation stricte du contenu
Selon le format réel produit par le navigateur :
- `message` : 1 à 600 caractères, sans caractères de contrôle.
- `persona` : commence par « Tu es », une seule ligne, 600 caractères au plus.
- `facts` : lignes commençant par « - », 60 lignes au plus, 400 caractères par ligne.
- `step` : une des quatre étapes exactes.
- `history` : rôle `d` ou `p`, 50 éléments au plus ; les textes trop longs sont tronqués, pas refusés.
- `cas.id` : un des 302 identifiants.

Les 302 cas réels, mis au format du navigateur, sont tous acceptés (test automatisé).

## 2. Changements de comportement

| Situation | Avant | Maintenant |
|---|---|---|
| Visiteur non connecté | Refusé (401) | Refusé (401), moteur local |
| Quota de cas atteint | Refusé (402), moteur local | Idem, avec `reason` |
| Plafond de messages atteint | Pas de plafond | 402, moteur local |
| IA en panne | Moteur local | Idem, réservation libérée |
| Identifiant de cas inconnu | Accepté | 400, moteur local |
| Contenu hors format | Accepté | 400, moteur local |
| Mode `?debug=1` | Disponible | Supprimé |

Aucune fonctionnalité visible n'a été retirée. La consultation continue dans tous les cas grâce au moteur local.

## 3. Tests

Commande : `cd worker && npm test` — **53 tests, tous passent** (Node 22).

| Garantie | Test |
|---|---|
| 100 requêtes simultanées, compte gratuit : exactement 5 réussies, 5 appels IA | `patient-worker.test.mjs` |
| Avec la limite par défaut (20/min) : jamais plus de 5 réussites | idem |
| 100 réservations simultanées, cas distincts : exactement 5 | `quota-limiter.test.mjs` |
| 100 réservations simultanées, même cas : exactement 40 | idem |
| 50 requêtes de débit simultanées : exactement 20 | idem |
| 41e message refusé ; cap configurable ; échec IA sans consommation | `patient-worker.test.mjs` |
| Identifiants inventés refusés, sans appel IA | idem |
| Jetons invalides (signature, `none`, émetteur, audience, expiration, email) | idem |
| Rotation des clés acceptée ; kid inconnu répété : une seule interrogation de Google | idem |
| Durable Object absent ou en panne : 503, IA non appelée | idem |
| Configuration invalide : 503 | idem |
| Origine étrangère refusée ; pré-vol CORS autorise `Authorization` | idem |
| Validation : formats invalides refusés ; 302 cas réels acceptés | `validation.test.mjs` |
| Adresse figée, debug absent, jeton envoyé à un seul endroit, scripts syntaxiquement valides | `client-static.test.mjs` |
| `case-ids.js` synchronisé avec `cases_202.js` | idem |

### Test de mutation
Dans une copie de travail, la sérialisation du Durable Object a été retirée. Les tests de concurrence (niveau objet
**et** niveau HTTP) échouent alors. Les tests détectent donc bien la régression qu'ils visent.

### Incident de test (résolu, documenté)
Une exécution a échoué sur 7 tests. La cause n'était pas le code : la commande avait laissé le shell dans la copie
mutée, qui n'a pas accès à `cases_202.js`. Relancée depuis le dépôt, la suite passe (plusieurs répétitions, dont 8
sur les tests de concurrence, sans échec).

## 4. Tests restants (non automatisables ici)

Ces points demandent un environnement réel. Ils ne sont **pas** validés :

1. **Runtime Cloudflare réel** : concurrence sur le vrai Durable Object (le test simule la sérialisation).
2. **Jetons Firebase réels** : les tests utilisent des jetons synthétiques signés par une clé de test. Vérifier avec un
   vrai compte (connexion Google, email vérifié).
3. **Clés Google** : l'URL `securetoken@system.gserviceaccount.com` n'a pas pu être interrogée depuis la session.
   La vérifier depuis un environnement qui y a accès.
4. **Navigateur** : connecté / non connecté, quota atteint (402), IA en panne (502), Worker indisponible (503) ;
   Android (Chrome) et ordinateur. Vérifier que le moteur local prend le relais dans chaque cas, sans message d'erreur visible.
5. **Préproduction** : tests de fumée du `worker/README.md`.
6. **Règles Firestore réellement déployées** : le dépôt contient un fichier de règles, mais seule la console Firebase
   prouve ce qui est en vigueur.
7. **Test de charge** : un test sur un volume réel, au-delà de 100 requêtes simultanées.

## 5. Problèmes non résolus (hors périmètre de cette étape)

- **C1** : les 302 cas et leurs corrigés restent dans `cases_202.js`, chargé par le navigateur. Le diagnostic reste
  lisible par qui le cherche, quel que soit le quota. Le Premium ne peut pas protéger le contenu tant que C1 n'est pas traité.
- **C3** : les scores sont calculés et enregistrés par le navigateur. Les règles Firestore ne contrôlent pas les valeurs.
- **Persona et faits** envoyés par le navigateur : une injection de consigne reste possible dans les limites de format.
- **Comptes multiples** : un étudiant peut créer plusieurs comptes pour multiplier les 5 cas gratuits.
- **Moteur local sans quota** : après un refus, la simulation continue sans IA et sans limite.
- **Premium manuel** : pas de paiement ni de webhook ; l'accès s'accorde par écriture dans KV.

## 6. Configuration externe nécessaire (avant déploiement, à faire par toi)

1. Créer l'espace KV `STATE` (ou réutiliser l'existant) et renseigner son identifiant dans `wrangler.toml`.
2. Vérifier que la liaison `AI` existe et que les Durable Objects sont disponibles sur le compte.
3. Vérifier les variables : `MAX_MESSAGES_PER_CASE`, `USER_REQUESTS_PER_MINUTE`, `IP_REQUESTS_PER_MINUTE`.
4. Retirer la liaison `RATE` (KV) si elle existe encore : elle n'est plus utilisée.
5. Attention : `wrangler deploy` remplace les réglages faits dans le tableau de bord Cloudflare. Comparer avant.

## 7. Décisions à valider

1. **Plafond de 40 messages par cas et par mois** (choix d'un identifiant serveur plutôt que de consultation client).
2. **Remise à zéro des quotas au premier déploiement** (les anciens compteurs KV ne sont pas migrés).
3. **Quotas 5 / 150 / 40** (gratuit / Premium / messages par cas) : politique révisée le 4 novembre 2026, appliquée dans le code et les tests ; à valider commercialement. Voir `docs/quotas-politique.md`.
4. **Ordre de déploiement** : Worker d'abord, puis client (voir `worker/README.md`, section 9). Une courte coupure de l'IA est inévitable.

## 8. Fichiers modifiés

| Fichier | Nature |
|---|---|
| `worker/patient-worker.js` | Réécrit : validation, Durable Object, quotas atomiques, JWKS, échec fermé |
| `index.html` | Trois modifications : adresse figée, suppression du mode debug, commentaire de l'adresse |
| `worker/case-ids.js` | Nouveau : 302 identifiants (aucun contenu médical) |
| `worker/scripts/build-case-ids.mjs` | Nouveau : génération et vérification de `case-ids.js` |
| `worker/wrangler.toml` | Nouveau : configuration cible, avec identifiant de remplacement (non déployable) |
| `worker/package.json` | Scripts `test` et `check:case-ids` |
| `worker/test/helpers.mjs` | Nouveau : simulateurs (Firebase, KV, Durable Object, IA) |
| `worker/test/quota-limiter.test.mjs` | Nouveau : tests du Durable Object |
| `worker/test/patient-worker.test.mjs` | Réécrit : tests HTTP |
| `worker/test/validation.test.mjs` | Nouveau : validation et 302 cas réels |
| `worker/test/client-static.test.mjs` | Nouveau : garanties du navigateur |
| `worker/README.md` | Réécrit : configuration, Durable Objects, déploiement, retour arrière |
| `docs/securite-phase-1.md` | Ce document |

Aucun fichier de contenu médical (`cases_202.js`) n'a été modifié.

## 9. État réel de production (constaté le 4 novembre 2026, lecture seule)

- Le Worker `muddy-shadow-c8d5` déployé est **la version d'origine** : pas d'authentification, pas de quota,
  limite par IP via KV `RATE`. **La protection C2 n'est donc pas active en production.** Elle ne le deviendra
  qu'après déploiement de cette branche (voir `worker/README.md`, section 9).
- Le seul namespace KV du compte est `salledegarde-rate`. Le namespace `STATE` n'existe pas encore.
- Identité du dépôt : déploiement GitHub Pages `success` pour le commit `dd5412a` (= `main`), URL
  `https://salledegarde.online/`.
