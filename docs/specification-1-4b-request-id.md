# Spécification 1.4b : identifiant de requête et idempotence

Statut : **implémentée sur la branche `securite/phase-1-cases-worker-scores`** (Worker : `patient-worker.js` ;
navigateur : `patient-client.js`). Non déployée. Voir la section 7 pour les écarts avec la rédaction initiale.
Décisions reprises : 1.4-A (comptage unique), 1.4-B (durée de vie de 48 heures), D-P3-bis (secours très limité).

## 1. Problème (F2)

Le navigateur abandonne une demande après 15 secondes. Le Worker a peut-être déjà réservé le message. Le secours local
répond, et si l'étudiant renvoie le même message, un second message est consommé.

## 2. Contrat

- Chaque message porte un `requestId` (UUID v4) généré par le navigateur, dans l'en-tête `X-SDG-Request-Id`.
- Un `requestId` identifie **un** message. Renvoyer le même `requestId` est une **reprise**, pas une nouvelle consultation.
- Pendant la transition, un message sans `requestId` garde le comportement actuel (compté, sans reprise possible).

## 3. Règles serveur

| Situation | Réponse | Effet sur le quota |
|---|---|---|
| `requestId` inconnu | Traitement normal (réservation, IA, confirmation) | Un message compté |
| `requestId` déjà confirmé, même contenu | 200 avec la **même** réponse mémorisée | Aucun nouveau message |
| `requestId` confirmé, contenu différent | 409 `request_conflict` | Aucun |
| `requestId` en cours (réservé, pas encore confirmé) | 409 `in_progress` | Aucun |
| `requestId` libéré (échec IA) | Nouvelle tentative autorisée avec le même `requestId` | Réservation à nouveau |
| `requestId` expiré (plus de 48 heures) | 410 `request_expired` | **Aucun**. Jamais réservé, jamais envoyé à l'IA |

### Point précis : expiration

- L'expiration est mesurée à partir de la **première réservation** du `requestId`, sur l'horloge du Worker.
- Un `requestId` expiré n'est **jamais** traité comme nouveau : sinon une reprise tardive compterait deux fois.
- Le Worker ne rejoue **aucune** demande expirée automatiquement.
- Un nouvel envoi volontaire du même texte par l'étudiant doit utiliser un **nouveau** `requestId`, donc compte comme un
  nouveau message. Le navigateur doit l'afficher comme tel.
- Le mémo de réponse est conservé 48 heures puis supprimé avec le `requestId`.

### Stockage

- Dans le Durable Object `uid:<uid>`, table `rid` : `{ state: pending|confirmed, caseId, firstAt, answer }`.
- Le balayage existant (`PENDING_TTL_MS`, 90 secondes) s'applique aux `pending`. Les `confirmed` restent 48 heures.
- Coût : une écriture de plus à la confirmation, une lecture de plus par requête. À mesurer (voir `docs/d1-preparation.md`).

## 4. Règles navigateur (D-P3-bis)

1. Après un délai ou une 5xx, le navigateur **n'appelle pas le moteur local** tant que le statut n'est pas connu.
2. Il interroge le statut du même `requestId` (`GET /message/status`, à spécifier avec l'implémentation).
3. Si le serveur confirme la consommation et une réponse : affichage de la réponse, pas de secours.
4. Si le serveur confirme la consommation sans réponse : erreur technique explicite, pas de secours.
5. Si le serveur confirme **qu'il n'y a pas** eu de consommation : nouvel envoi avec le même `requestId`.
6. Si l'état ne peut pas être confirmé : erreur technique explicite. Le moteur local ne se lance pas.
7. Après 401, 402, 409 (sauf `in_progress`), 429 et 426 : aucun secours.

## 5. Tests à écrire avec l'implémentation

- Même `requestId` deux fois : une réservation, deux réponses identiques.
- `requestId` en cours : 409 `in_progress`, aucune réservation.
- Contenu différent sous un `requestId` confirmé : 409 `request_conflict`.
- Reprise après délai côté client : pas de double consommation.
- `requestId` expiré : 410, aucune réservation, aucun appel IA.
- Frontière : 47 h 59 accepté, 48 h 01 refusé.
- Navigateur (simulation) : pas de secours sans statut confirmé.

## 6. Risques

- Horloge : l'expiration dépend du Worker. Test réel obligatoire avant déploiement.
- Anciens navigateurs : sans `requestId`, pas d'idempotence pendant la transition (30 jours, décision 1.4-C).
- Un `requestId` ne protège pas contre un étudiant qui obtient deux UUID différents : c'est la limite des comptes multiples
  (voir `docs/quotas-politique.md`, section 9).

## 7. Mise en œuvre et écarts avec la spécification

Mise en œuvre : `QuotaLimiter.reserve`, `confirm`, `release`, `sweepAll` (Durable Object) ; `handleRequest` (Worker) ;
`sendMessage`, `classify`, `uuidV7` (navigateur, `patient-client.js`).

| Point | Spécification | Mise en œuvre | Raison |
|---|---|---|---|
| Statut d'une requête | `GET /message/status` | **Pas d'endpoint.** La reprise renvoie le même `POST` avec le même identifiant : réponse mémorisée (`replay`), « en cours » (409), ou nouvelle réservation si la précédente a été libérée | Un seul chemin, aucun état à deux endroits à synchroniser. Le résultat est le même : rien n'est compté deux fois |
| Expiration (48 h) | Mesurée à partir de la première réservation | **Mesurée à partir de l'heure encodée dans l'identifiant** (UUID version 7, créé par le navigateur) | Une requête ancienne ne peut jamais redevenir « nouvelle », même si son enregistrement a disparu. Aucune table de « requêtes périmées » à conserver |
| Décalage d'horloge | non prévu | Le navigateur recale son horloge sur l'en-tête `Date` du Worker. Une demande neuve refusée pour horloge décalée (410 ou 400) est recréée une seule fois : elle n'avait jamais été acceptée | Un téléphone à l'heure fausse ne doit pas être bloqué |
| Tolérance vers le futur | non prévue | 5 minutes ; au-delà, 400 | Empêche les identifiants « du futur » qui repousseraient l'expiration |
| Changement de mois | non prévu | Les compteurs sont remis à zéro, les identifiants de requête sont conservés 48 h | Une réponse confirmée juste avant minuit reste rejouable après minuit, sans nouveau décompte |
| Requête sans identifiant | « pendant la transition » | Comportement sans idempotence (limite documentée). Le navigateur à jour envoie toujours un identifiant | Transition : anciens navigateurs en cache |
| Libération | non prévue | Une libération retire aussi l'identifiant : une nouvelle tentative réserve de nouveau, une seule fois au total | Sinon une panne d'IA bloquerait la question pendant 48 h |

Tests : `worker/test/request-id.test.mjs` (19 tests dont double clic simultané, réservation orpheline, bornes de 48 h,
renouvellement mensuel) ; mutation vérifiée : sans la mémorisation des requêtes, 5 tests échouent.

Limites : la fenêtre de 90 secondes et l'expiration de 48 heures reposent sur l'horloge du Worker et sur celle du
navigateur (recalée). Pas encore vérifié sur Cloudflare réel. Un étudiant qui crée deux questions identiques reçoit
deux identifiants et paie deux fois : c'est voulu (chaque question est un message).

## 8. Révision du 6 novembre 2026 (corrections B2 à B5)

- **Ordre des vérifications** : format de l'identifiant (400), puis authentification, protocole, et enfin le Durable Object. Dans le Durable Object, l'enregistrement de l'identifiant est consulté **avant** tout contrôle d'horodatage :
  - contenu différent : 409 `request_conflict` ;
  - réponse confirmée encore conservée : rejeu (200 `replay`), sans appel IA ni décompte, même si l'heure encodée est ancienne ;
  - réponse confirmée dont la conservation est terminée : 410 `request_expired` ;
  - réservation en cours : 409 `in_progress` ;
  - identifiant inconnu : 410 si l'heure encodée a plus de 48 h, 400 si elle est plus de 5 min dans le futur.
- **Conservation** : 48 h à partir de la première réception par le Worker (et non de l'heure encodée). La purge a lieu 5 min plus tard ; cette marge garantit qu'un identifiant purgé reste refusé (410), car tout identifiant accepté a une heure encodée au plus 5 min après sa réception.
- **Stockage** : SQLite structuré (tables `ledger` pour le décompte et `idem` pour les requêtes idempotentes, une ligne par réservation ou par identifiant), transactions synchrones, purge par requête SQL. Voir `worker/patient-worker.js`, `STORAGE_SCHEMA`.
- **Client** : l'horloge de l'appareil ne décide plus de l'expiration d'une question en attente. Une question peut être abandonnée ; renvoyée à l'identique, elle reprend son identifiant.
- **Date de transition** : format ISO 8601 UTC strict obligatoire au démarrage (échec fermé sinon). Le refus des dates passées est fait par `worker/scripts/check-deploy.mjs`, pas au démarrage.
