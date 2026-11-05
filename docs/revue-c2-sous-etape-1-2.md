# Revue du code C2 — sous-étape 1.2 (phase 1)

Statut : **revue de code et tests simulés. Aucune modification de code, aucune ressource Cloudflare ou D1 créée,
aucun déploiement, aucun changement de production.** Ce qui suit n'est **pas** une validation sur Cloudflare réel
ni sur Firebase réel.

Périmètre lu : `worker/patient-worker.js` (448 lignes, en entier), `worker/test/*.test.mjs`, et le chemin de
repli côté client dans `index.html` (fonction `answerPatient`, lignes 1548 à 1572 sur la branche).

Décisions appliquées à cette revue : D-P1 (α), D-P2, D-P3, D-P4 (D1 et Durable Objects), D-P5 reporté.

---

## 1. Résultat des tests (simulés)

- `npm test` dans `worker/` : **70 tests, 70 réussis, 0 échec.**
- Ces tests simulent le Durable Object (`FakeStorage`, avec délai artificiel), KV, Workers AI et les jetons Firebase
  (clés générées localement). Ils ne prouvent pas le comportement sur le runtime Cloudflare ni avec de vrais jetons.

---

## 2. Ce qui est correct

| Domaine | Vérification | Constat |
|---|---|---|
| Algorithme du jeton | `alg` doit être `RS256`, `kid` présent | Correct. `none` et les autres algorithmes sont refusés. |
| Signature | Clé importée depuis JWKS, `RSASSA-PKCS1-v1_5` + SHA-256 | Correct. |
| Émetteur, audience | `iss = https://securetoken.google.com/<projet>`, `aud = <projet>` | Correct. |
| Expiration, émission, authentification | `exp` futur, `iat` et `auth_time` non dans le futur (tolérance 5 min) | Correct. |
| Sujet | `sub` présent, 128 caractères au plus | Correct. |
| E-mail | `email_verified` exigé (403 sinon) | Correct. Le client envoie bien `sendEmailVerification` à l'inscription par e-mail (ligne 954). |
| Cache JWKS | 1 h de cache, rechargement au plus toutes les 5 min pour un `kid` inconnu | Correct. Limite les appels à Google en cas de faux `kid`. |
| Réservation atomique | Opérations du Durable Object exécutées une à une (file `run`) | Correct. Testé à 100 requêtes simultanées : 5 acceptées pour le quota gratuit, 40 pour le plafond de messages. |
| Libération | `release` en cas d'échec de l'IA ou de réponse vide | Correct. Un refus n'entame ni le quota ni le plafond. |
| Débit | 20 requêtes par minute par utilisateur, 20 par IP | Correct, avec les réserves de F5 et F9. |
| Validation du contenu | Format strict des messages, de l'historique, des faits, de l'étape et de l'identifiant de cas (liste blanche des 302) | Correct. |
| Échec fermé | Sans `STATE` ou `QUOTA`, ou configuration invalide : 503 | Correct. |
| Origine | Liste autorisée, 403 sinon | Correct, mais voir F10 : ce n'est pas un contrôle d'accès. |

---

## 3. Constats

Classement : **haut** = peut faire perdre un quota ou un droit ; **moyen** = incohérence ou risque réel mais limité ;
**bas** = à documenter ou à durcir.

### F1 — Refus traités comme une panne par le client (haut)

- **Où** : `index.html`, `answerPatient`. Toute réponse qui n'est pas `res.ok` (401, 402, 409, 429, 503, 502) et toute
  exception (délai de 15 s, réseau) tombent sur `patientReply`, le moteur local.
- **Scénario** : un gratuit a consommé ses 5 consultations. Le Worker répond 402. Le navigateur appelle le moteur local,
  et la simulation continue sans limite.
- **Constat** : confirmé par lecture du code. Le contournement décrit dans `docs/audit-phase-1.md` est toujours présent
  sur la branche.
- **Correction** : sous-étape 1.4 (D-P3). Le moteur local ne doit servir qu'aux pannes techniques. Refus et erreurs
  d'authentification ne doivent jamais le déclencher.

### F2 — Consommation sans réponse affichée, risque de double consommation (haut)

- **Où** : côté client, délai de 15 s (`AbortController`). Côté Worker, la réservation est faite **avant** l'appel à l'IA
  (ligne 402) et la libération n'a lieu qu'en cas d'échec explicite.
- **Scénario** : l'IA met plus de 15 s. Le client abandonne et affiche le moteur local. Le Worker, lui, termine la
  requête et garde le message consommé, sans que l'étudiant ait vu la réponse. S'il renvoie le même message, un second
  message est consommé.
- **Impact** : pas de contournement (le quota est plus consommé, pas moins), mais l'utilisateur paie deux fois pour une
  réponse et ne voit qu'une.
- **Correction proposée** : un identifiant de requête (`requestId`, généré par le client) avec réponse mise en cache
  côté serveur pendant quelques minutes. Une requête rejouée renvoie la même réponse sans nouvelle réservation. À décider
  avec D-P3 (sous-étape 1.4).

### F3 — Codes de réponse incohérents (moyen) — **résolu**

- **Constat initial** : code et tests renvoyaient 402 pour le plafond de messages, la documentation disait 409.
- **Décision** : D-P3-ter, plafond de messages en **409**. Appliqué dans `worker/patient-worker.js` (ligne 409 :
  `messages` → 409, `quota` → 402, `rate` → 429), dans les tests `patient-worker.test.mjs` (trois assertions) et dans
  `worker/README.md`, `docs/quotas-politique.md`, `docs/plan-deploiement-c2.md`, `docs/durable-objects-plan-tests.md`.
- **Reste à faire (1.4)** : le navigateur doit afficher un message dédié pour 409 et ne pas basculer sur le moteur local.

### F4 — Panne de la clé Google classée comme erreur d'authentification (moyen)

- **Où** : `handleRequest`, bloc « Authentification ». Toute exception de `verifyIdToken` donne 401, y compris
  `jwks_unavailable` et `jwks_invalid`, qui sont des pannes techniques.
- **Impact** : un utilisateur légitime, pendant une panne de Google, reçoit une erreur d'authentification et son
  navigateur peut, avant correction F1, basculer sur le moteur local.
- **Correction** : distinguer `invalid_token` (401) des erreurs de récupération des clés (503). À faire en 1.4 avec un
  test dédié.

### F5 — Corps de requête non borné avant validation (moyen)

- **Où** : `request.json()` (ligne 363) lit le corps en entier avant toute validation et **avant** la limite de débit
  par IP (ligne 368-376).
- **Impact** : une requête très volumineuse coûte du temps de traitement et de la mémoire sans être comptée.
- **Correction** : refuser les corps de plus de 64 Ko (en-tête `Content-Length` et contrôle après lecture) avant
  `request.json()`, et déplacer la limite par IP avant la lecture du corps.

### F6 — Changement de mois piloté par la requête : risque de réinitialisation (moyen)

- **Où** : `rollMonth(month)` (ligne 289). Le mois vient de l'horloge du Worker qui traite la requête. Si une requête
  arrive avec un mois antérieur à celui stocké (horloge en retard, requête lente à la frontière du mois), `rollMonth`
  **efface tous les compteurs** du mois en cours et repart en arrière.
- **Scénario** : une requête calculée le 31 octobre à 23 h 59 UTC, traitée le 1er novembre après une requête déjà
  comptée pour novembre. Les compteurs de novembre sont effacés : le quota du mois est remis à zéro.
- **Probabilité** : faible (fenêtre de quelques secondes à la frontière du mois), mais l'effet est total pour
  l'utilisateur concerné.
- **Correction** : rendre le mois monotone (une requête dont le mois est antérieur au mois stocké est traitée comme
  appartenant au mois stocké, ou refusée). À faire en 1.4 avec un test de frontière.

### F7 — Réservation orpheline en cas d'interruption (moyen)

- **Où** : entre `stub.reserve` (ligne 402) et `release` (ligne 423). Si la requête est interrompue (exception non
  rattrapée, arrêt du Worker, annulation), aucune libération n'a lieu.
- **Impact** : le message reste consommé. Ce n'est pas un contournement, mais une perte pour l'utilisateur.
- **Correction** : libération dans un `finally`, et expiration automatique des réservations sans réponse (par exemple
  après 60 s), pour ne pas dépendre de l'exécution complète du Worker.

### F8 — Persona et faits fournis par le navigateur (moyen, lié à C1)

- **Où** : `validateContent` accepte `persona` et `facts` du client, tant qu'ils respectent le format.
- **Constat** : le Worker est un proxy IA généraliste, limité seulement par les quotas. Un étudiant peut remplacer le
  persona par un autre texte (dans le format imposé) et détourner le modèle hors du contexte médical. Les quotas limitent
  l'usage (5 cas × 40 messages pour un gratuit), mais ne limitent pas le contenu.
- **Correction** : dépend de D-P1 (α). Avec α, le Worker reconstruit le persona et les faits à partir de l'identifiant du
  cas, sans accepter de texte libre. Cela ne protège pas le contenu clinique lui-même (qui reste dans le navigateur) :
  c'est β qui le ferait.

### F9 — Adresse IP absente : seau partagé (bas)

- **Où** : `CF-Connecting-IP` absent → `"inconnu"`, un seul seau de 20 requêtes par minute pour tous.
- **Constat** : en production sur Cloudflare, l'en-tête est toujours présent. Le risque concerne les environnements de test
  ou un changement d'hébergement.
- **Correction** : refuser (400) les requêtes sans l'en-tête, ou ne pas appliquer de limite IP dans ce cas.

### F10 — L'origine n'est pas un contrôle d'accès (bas)

- **Constat** : le contrôle `Origin` (403) protège les navigateurs contre les sites tiers. N'importe quel client HTTP peut
  envoyer l'en-tête. La seule barrière réelle est le jeton Firebase (F-auth) et les quotas.
- **Correction** : aucune modification nécessaire. À documenter dans `worker/README.md` pour éviter une fausse confiance.

### F11 — Compte désactivé ou jeton révoqué : valable jusqu'à une heure (bas)

- **Constat** : `verifyIdToken` ne consulte pas la révocation (cela demande l'API Admin Firebase, hors Worker). Un compte
  désactivé garde son accès IA jusqu'à l'expiration du jeton (1 h).
- **Correction** : acceptable en phase 1. Une vérification de révocation pourrait être ajoutée plus tard via un service
  de confiance, à décider.

### F12 — Droit Premium : délai de révocation (bas)

- **Constat** : la formule est lue dans KV. Une révocation (passage au gratuit avant la date `until`) peut prendre environ
  une minute à être visible. La date `until` est vérifiée à chaque requête, donc une formule expirée n'est jamais
  acceptée.
- **Correction** : acceptable. Les décisions D-P4 prévoient la lecture depuis D1 et des Durable Objects, plus cohérentes.

### F13 — Tests : ce qui n'est pas couvert (information)

Absents des 70 tests :

- comportement client (délai, reprise, affichage des refus) ;
- taille du corps ;
- frontière de mois (F6) ;
- distinction 401 / 503 pour une panne de clés (F4) ;
- réservation orpheline (F7) ;
- de bout en bout avec Firebase réel et Cloudflare réel.

---

## 4. Risques restants après la sous-étape 1.2

| Risque | Gravité | Traité par |
|---|---|---|
| Contournement par le moteur local (F1) | Haute | 1.4 (D-P3) |
| Double consommation sur délai (F2) | Haute | 1.4 |
| Codes incohérents (F3) | Moyenne | 1.4 |
| Pannes classées comme erreurs d'authentification (F4) | Moyenne | 1.4 |
| Corps de requête non borné (F5) | Moyenne | 1.4 |
| Réinitialisation de mois (F6) | Moyenne | 1.4 |
| Réservations orphelines (F7) | Moyenne | 1.4 |
| Persona libre et proxy IA généraliste (F8) | Moyenne | 1.5 (α) |
| Corrigés et notation dans le navigateur (C1) | Haute | 1.5 (α), β plus tard |
| Scores écrits par le client (C3) | Haute | 1.6 (D-P2) |
| Worker de production non authentifié | **Critique, ouvert** | Déploiement de C2, sur votre autorisation |
| Mode `?debug=1` sur `main` | Haute, ouvert | Branche de correctif séparée (voir §5) |

---

## 5. Correctif `?debug=1` : branche isolée

- **Branche** : `fix/debug-hook-main`, créée depuis `origin/main` (`dd5412a`), commit `4233219`, poussée.
- **Contenu** : trois lignes de `index.html` (suppression du point d'accès `?debug=1` et de la surcharge
  `window.SDG_LLM_URL`). Diff : 1 ligne ajoutée, 4 supprimées (une ligne modifiée, trois commentaires et instructions retirés).
- **Vérification** : recherche de `_sdgDbg`, `debug=1` et `SDG_LLM_URL` dans le fichier : aucune occurrence restante.
  Le fichier n'a pas pu être chargé dans un navigateur, car les modules Firebase ne sont pas accessibles depuis
  l'environnement de test. Le test réel reste à faire.
- **Non fusionné**, aucun déploiement. `main` est inchangée (`dd5412a`).
- **Pour la mise en production** : fusion et déploiement sur votre autorisation écrite uniquement.
