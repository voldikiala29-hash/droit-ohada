# Plan de correction, sous-étape 1.4 : F1 à F7 et secours en panne

Statut : **état d'avancement.**
- 1.4c et 1.4d (serveur) : commit `a7133c4`, poussé sur `securite/phase-1-cases-worker-scores`.
- 1.4a (navigateur, refus, pannes, en-tête de version, avertissement) et 1.4b (identifiant de requête, idempotence) :
  implémentés sur la même branche, non déployés. Voir `docs/specification-1-4b-request-id.md` (section 7) pour les écarts.
- Décision de conception : aucune réponse locale au chat patient, y compris hors ligne (le bandeau hors ligne le dit).
- `PROTOCOL_CUTOFF` reste à son placeholder : **ne pas la fixer avant la mise en production du client 1.4a**.

Décisions appliquées : D-P3 (aucun secours après refus), D-P3-bis (secours en panne très limité, idempotence),
D-P3-ter (plafond de messages en 409, **déjà appliqué** sur la branche, commit `5bb2151`).

Documents liés : `docs/revue-c2-sous-etape-1-2.md` (constats F1 à F13), `docs/decisions-phase-1.md` (§3, taxonomie),
`docs/d1-preparation.md` (protocole de réservation).

---

## 1. Règles de décision (D-P3-bis, reprises telles quelles)

1. **Aucun secours local après une réponse 401, 402, 409 ou 429.**
2. **Pour les 5xx et les délais dépassés**, le secours n'est autorisé que si le serveur confirme que la consultation a
   déjà été comptabilisée.
3. **Idempotence** : un message rejoué ne doit jamais être consommé deux fois.
4. **Si l'état ne peut pas être confirmé**, afficher une erreur technique explicite et **ne pas lancer** le moteur local.

Conséquence pratique : le moteur local ne répond jamais à un nouveau message sans confirmation serveur. Il peut
seulement continuer une consultation dont la réservation est confirmée.

---

## 2. Vue d'ensemble

| Constat | Priorité | Partie | Sous-étape |
|---|---|---|---|
| F1 — refus traités comme panne (contournement) | Haute | navigateur + Worker | 1.4a |
| F2 — délai client, consommation sans réponse, double consommation | Haute | navigateur + Worker | 1.4b |
| F3 — code 402/409 incohérent | Résolue | Worker, docs | fait (`5bb2151`) |
| F4 — panne des clés Google classée en 401 | Moyenne | Worker | 1.4c |
| F5 — corps non borné avant validation | Moyenne | Worker | 1.4c |
| F6 — réinitialisation du mois à la frontière | Moyenne | Durable Object | 1.4d |
| F7 — réservation orpheline | Moyenne | Durable Object + Worker | 1.4d |

Ordre proposé : **1.4c → 1.4d → 1.4b → 1.4a**. Les corrections serveur d'abord, pour que le client ait un comportement
fiable à appeler. Le navigateur ne change qu'après.

---

## 3. Détail par constat

### 3.1 F1 — refus traités comme panne (sous-étape 1.4a, navigateur)

**Problème** : `answerPatient` (`index.html`, ligne 1548 sur la branche) bascule sur `patientReply` pour toute réponse
non `ok` et toute exception.

**Correction** :

- Séparer trois issues :
  - **Décision serveur** (400, 401, 402, 403, 409, 429) : afficher le message correspondant, **ne jamais** appeler
    `patientReply`. Pour 401, proposer de se reconnecter. Pour 402, indiquer la date de renouvellement. Pour 409, indiquer
    le plafond atteint pour ce cas. Pour 429, demander d'attendre.
  - **Panne** (5xx, délai, réseau) : voir 3.2.
  - **Succès** (200) : comportement actuel.
- Messages dédiés à chaque code, rédigés en français, sans mention de « consultation IA » en dehors des textes existants
  (un test interdit ce libellé dans `index.html` hors cas autorisés).

**Fichiers** : `index.html` (`answerPatient` et son appelant), messages dans le même bloc.

**Tests** :

- Simulation navigateur (Chromium) : réponse 402, 409, 429, 401 → aucun appel à `patientReply` (espion sur la fonction).
- Test statique : `answerPatient` ne référence `patientReply` que dans la branche « panne ».

**Risque** : modification du parcours principal. À tester avant fusion sur appareil réel (Android et iOS).

### 3.2 F2 — délai client et double consommation (sous-étape 1.4b, navigateur et Worker)

**Problème** : le client abandonne à 15 secondes. Le serveur a déjà réservé le message. Le secours local répond, et si
l'étudiant renvoie le même message, un second message est consommé.

**Correction** :

- **Identifiant de requête** : le navigateur génère un `requestId` (UUID) pour chaque message, et le renvoie dans l'en-tête
  ou le corps.
- **Idempotence côté Worker** : table `idempotency` (voir `docs/d1-preparation.md`) ou, en phase précédant D1, stockage
  dans le Durable Object de l'utilisateur. Une requête déjà traitée renvoie la **même réponse** sans nouvelle réservation.
  Une requête en cours (même `requestId`, pas encore de réponse) renvoie 409 `in_progress` **sans** réserver.
- **Délai côté client** : passer de 15 s à un délai plus long pour le réseau lent, mais ne **jamais** utiliser le secours
  pour un message dont le `requestId` est déjà connu du serveur. Le client réessaie le **même** `requestId` (pas un nouveau).
- **Secours (D-P3-bis)** : après un délai ou une 5xx, le client demande au serveur l'état de ce `requestId`
  (`GET /message/status`). Si le serveur confirme la consommation et qu'il n'a pas de réponse, le client affiche une erreur
  technique explicite. Le moteur local ne répond que si la consultation est confirmée et que le serveur ne peut pas
  répondre. Dans ce cas, le message est compté par le serveur à la reconnexion, avec le même `requestId`.

**Points à décider avant implémentation** :

- Le message local en secours doit-il être compté ? Oui, pour éviter qu'un étudiant obtienne une réponse gratuite. La
  consommation est déjà faite côté serveur pour ce `requestId`, donc pas de double comptage.
- Durée de vie d'un `requestId` (proposition : 10 minutes).

**Tests** :

- Même `requestId` envoyé deux fois : une seule réservation, deux réponses identiques.
- `requestId` en cours : 409 `in_progress`, aucune réservation supplémentaire.
- Délai client puis nouvel envoi du même `requestId` : pas de double consommation.
- Secours autorisé uniquement si `GET /message/status` confirme la réservation.

**Risque** : nouveau champ dans le contrat Worker ↔ navigateur. Ancien navigateur (cache) : compatibilité à prévoir, sans
`requestId` le Worker garde le comportement actuel pendant une période transitoire.

### 3.3 F4 et F5 — erreurs techniques et taille du corps (sous-étape 1.4c, Worker)

**F4 — pannes des clés Google classées en 401**

- Dans `verifyIdToken`, distinguer `invalid_token` (401) de `jwks_unavailable` et `jwks_invalid` (503).
- Dans `handleRequest`, retourner 503 pour ces deux erreurs, avec `error: "unavailable"`.
- Tests : `jwks_unavailable` → 503 (et non 401) ; jeton invalide → 401 ; jeton expiré → 401.

**F5 — corps non borné**

- Refuser avant `request.json()` les corps dont `Content-Length` dépasse 64 Ko : 413.
- Contrôler la taille réelle après lecture (text), pour les requêtes sans `Content-Length`.
- Déplacer la limite par IP **avant** la lecture du corps.
- Tests : corps de 65 Ko → 413 sans appel IA ni réservation ; limite IP déclenchée avant lecture.

**Risque** : faible. Aucun effet sur les requêtes légitimes (un message fait au plus 600 caractères).

### 3.4 F6 et F7 — mois monotone et réservations orphelines (sous-étape 1.4d, Durable Object)

**F6 — réinitialisation du mois**

- Dans `rollMonth`, ne jamais revenir à un mois antérieur à celui stocké : une requête dont le mois est antérieur est
  traitée comme appartenant au mois stocké.
- Le mois stocké n'est remplacé que par un mois postérieur.
- Test de frontière : requête datée du 31 octobre 23 h 59 traitée après une requête de novembre → compteurs de novembre
  conservés.

**F7 — réservation orpheline**

- Chaque réservation reçoit un `reservation_id` et un état `pending` avec expiration de 60 secondes.
- `release` dans un `finally` côté Worker.
- Une réservation `pending` expirée est libérée par le Durable Object à la prochaine opération.
- Test : interruption simulée après réservation → après 60 s, le compteur revient à sa valeur précédente.

**Risque** : les tests de délai utilisent une horloge simulée ; à compléter par un test sur Cloudflare réel (non réalisé).

### 3.5 F3 — résolue

Le code 409 est appliqué (commit `5bb2151`). Reste à aligner le message affiché (sous-étape 1.4a).

---

## 4. Taxonomie finale (à implémenter)

| Code | Catégorie | Réaction du navigateur | Secours local |
|---|---|---|---|
| 400 | Contenu invalide | Erreur technique, journal | Non |
| 401 | Authentification | Reconnexion | Non |
| 403 `email_unverified` | Authentification | Vérifier l'adresse | Non |
| 403 `origin` | Sécurité | Erreur | Non |
| 402 | Quota de cas | Message avec date de renouvellement | Non |
| 409 `messages` | Plafond de messages | Message « plafond atteint pour ce cas » | Non |
| 409 `in_progress` | Requête déjà en cours | Attendre, puis interroger le statut | Non |
| 413 | Corps trop grand | Erreur technique | Non |
| 429 | Débit | Attendre | Non |
| 503 `unavailable` / `config` | Panne | Erreur explicite ; secours seulement si la consultation est confirmée | Conditionnel |
| 502 | IA indisponible | Réessayer le même `requestId` | Conditionnel |
| Délai, réseau | Panne | Interroger le statut du `requestId` | Conditionnel |

---

## 5. Tests à ajouter

**Worker (simulés)** :

- F4 : `jwks_unavailable` → 503.
- F5 : corps de 65 Ko → 413 ; limite IP avant lecture.
- F6 : frontière de mois.
- F7 : réservation expirée libérée.
- F2 : idempotence (même `requestId`), `in_progress`.
- Mise à jour des tests existants si le contrat change (`requestId` optionnel pendant la transition).

**Navigateur (Chromium, simulation)** :

- Espion sur `patientReply` : jamais appelé pour 401, 402, 409, 429.
- Délai simulé : pas de secours sans confirmation serveur.
- Message d'erreur affiché pour chaque code.

**Non réalisable ici, à faire après autorisation** :

- Cloudflare réel (Durable Objects, expiration de réservation).
- Firebase réel (jetons, JWKS).
- Android et iOS réels.

**Règle** : aucun test simulé ne sera présenté comme une validation réelle.

---

## 6. Risques après 1.4

| Risque | Mesure |
|---|---|
| Parcours principal modifié (F1) | Test navigateur, puis test sur appareils réels avant fusion |
| Contrat `requestId` et anciens navigateurs | Transition : `requestId` optionnel pendant une période |
| Expiration de réservation sur horloge réelle | Test réel obligatoire avant déploiement |
| Message en secours compté à la reconnexion | Décision à valider (voir 3.2) |
| Coûts DO supplémentaires (statut, expiration) | Mesure sur le plan de tests réel |

---

## 7. Commits prévus

1. `quotas : 409 pour le plafond de messages` — **fait** (`5bb2151`).
2. `worker : 503 pour les pannes des clés, limite de taille du corps, limite IP avant lecture` (1.4c).
3. `durable object : mois monotone, réservations expirantes, libération garantie` (1.4d).
4. `worker : requestId et idempotence des messages` (1.4b, côté serveur).
5. `navigateur : séparation décision / panne, secours conditionnel, messages par code` (1.4a et 1.4b, côté client).
6. `tests : couverture des codes, idempotence, frontière de mois, expiration` (à répartir dans chaque commit).

Chaque commit sera poussé sur la branche de sécurité seulement, après vos tests et votre accord.

---

## 8. Décisions à confirmer avant exécution

| Id | Question |
|---|---|
| **1.4-A** | Un message servi par le secours à la reconnexion est-il compté ? (proposition : oui, une seule fois, avec le même `requestId`) |
| **1.4-B** | Durée de vie d'un `requestId` : 10 minutes ? |
| **1.4-C** | Période de transition pour les anciens navigateurs : combien de temps ? |
| **1.4-D** | Autorisez-vous l'exécution de 1.4c et 1.4d (serveur) avant 1.4a et 1.4b (navigateur) ? |
