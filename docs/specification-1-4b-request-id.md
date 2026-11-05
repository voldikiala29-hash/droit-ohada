# Spécification 1.4b : identifiant de requête et idempotence

Statut : **spécification. Non implémentée.** Elle sera exécutée seulement après autorisation explicite.
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
