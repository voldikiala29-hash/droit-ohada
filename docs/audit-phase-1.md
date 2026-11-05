# Audit technique : phase 1 (sécurisation)

Statut : **audit de l'état réel, sans modification de code ni de production.** Ce document décrit ce qui est exposé
aujourd'hui, ce que la branche corrige déjà, et ce qui doit être décidé avant chaque opération risquée.

Périmètre : site en production (`main`, `dd5412a`), branche `securite/phase-1-cases-worker-scores`, Worker
`muddy-shadow-c8d5` (production, code d'origine non authentifié). Rien n'a été déployé ni modifié côté Firebase ou
Cloudflare. Les tests du Worker tournent sur des simulations ; **aucun test simulé n'est une validation sur Cloudflare
réel.**

---

## 1. Synthèse

| Priorité | Sujet | État production (`main`) | État branche | Action requise |
|---|---|---|---|---|
| **Urgent** | Worker IA sans authentification ni quota | **Ouvert** : tout le monde peut appeler l'IA sans limite | Corrigé dans le code (C2), testé en simulation, **non déployé** | Votre autorisation pour déployer C2 |
| **Urgent** | Mode débogage en production | **Ouvert** : `?debug=1` expose `window._sdgDbg()` qui renvoie toute la base des cas, corrigés compris | **Supprimé** sur la branche | Fusion et déploiement, sur autorisation |
| **Haut** | Corrigés et clés de scoring dans le navigateur (C1) | Ouvert | Ouvert | Décision D-P1 |
| **Haut** | Scores calculés et enregistrés par le navigateur (C3) | Ouvert | Ouvert | Dépend de C1 (décision D-P2) |
| **Haut** | Moteur local utilisé après un refus de quota | **Ouvert** | Ouvert | Modification de `answerPatient` (décision D-P3) |
| **Moyen** | Droits Premium lus dans KV, source non fortement cohérente | Absent (accord manuel) | Lecture KV (C2) | Décision D-P4 |
| **Moyen** | Historique écrit directement par le client dans Firestore | Ouvert | Ouvert | Dépend de C3 |
| **Moyen** | Comptes multiples, abus d'IP | Partiel (limites par IP et par utilisateur) | Idem | Décision D-P5 (App Check, Turnstile) |

---

## 2. Constats détaillés

### 2.1 Production : Worker IA ouvert (urgent)

- Le Worker `muddy-shadow-c8d5` en production exécute le code d'origine : **aucune vérification de jeton, aucun quota,
  aucune limite**. N'importe qui peut envoyer des requêtes à l'URL publique.
- Coût exposé : d'après `docs/impact-financier-ia.md`, un message coûte environ 0,00054 USD sur une consultation longue.
  Sans limite, le coût n'est pas borné : c'est un risque financier direct, même si chaque requête est petite.
- Le code corrigé (C2) est dans la branche. Il exige : un namespace KV `STATE` à créer, la migration Durable Objects,
  les variables d'environnement, et une vérification sur Cloudflare réel avant d'être considéré comme validé.

### 2.2 Production : mode débogage (urgent)

- `main`, `index.html` lignes 1568-1569 et 1609 : si l'URL contient `?debug=1`, la page expose `window._sdgDbg()`,
  qui renvoie `S`, `DB` (toute la base des cas), `guardLLM` et `N`.
- Ce mode donne accès à la base complète, corrigés inclus, sans passer par le simulateur. Il contourne la seule
  protection visible, le fait que les corrigés ne soient pas affichés pendant la consultation.
- Une surcharge `window.SDG_LLM_URL` est aussi possible en production (ligne 1524) : elle permet de rediriger le
  moteur IA vers une adresse arbitraire.
- **La branche supprime ces trois éléments.** Un correctif immédiat sur `main` serait minimal (trois lignes), mais
  `main` ne doit pas être modifié sans votre autorisation.

### 2.3 C1 : protection des 302 cas et des corrigés

Chaque cas de `cases_202.js` (7 903 lignes) contient, en clair, dans le navigateur :

| Champ | Contenu | Exposé au navigateur |
|---|---|---|
| `name`, `svc`, `plainte` | Titre, service, motif | Oui (nécessaire à l'affichage) |
| `hist` | Questions et réponses du patient, avec expressions régulières | Oui (nécessaire au moteur local) |
| `ex`, `res` | Examen clinique et résultats d'examens | Oui (nécessaire au simulateur) |
| `key`, `exEss`, `dx`, `tx`, `pieges` | Diagnostic attendu, examens et traitements indispensables, règles de notation | **Oui : c'est le corrigé** |
| `rev`, `full` | Correction et justification | **Oui** |

Conséquence : un étudiant qui ouvre les outils du navigateur (ou la console) obtient le diagnostic et la grille de
notation de tous les cas, sans jouer. En production, le mode `?debug=1` rend cette lecture encore plus simple.

**Limite technique** : le moteur local a besoin des réponses du patient (`hist`) et des résultats (`res`) dans le
navigateur. Protéger *tout* le contenu supprimerait le fonctionnement hors ligne du simulateur. C'est un arbitrage,
décrit en §3.1.

### 2.4 C3 : scores

- `evaluate(S)` (`index.html` ligne 1731) calcule la note à partir de `d.key`, `d.exEss`, `d.dx`, `d.tx` et des données
  de la consultation. Tout est dans le navigateur.
- Le résultat est écrit directement dans Firestore (`progression/{uid}`, champ `hist`). Les règles n'appliquent que la
  taille (< 5 000 entrées) et les clés autorisées : **un client peut écrire n'importe quelle note**.
- Le score est aussi stocké dans le navigateur (`localStorage`), donc modifiable à la main.

### 2.5 Quotas et moteur local

- Le serveur contrôle bien les consultations IA (C2 dans la branche, réservation atomique avant appel, libération en cas
  d'échec).
- **Contournement actuel** : `answerPatient` (`index.html`, ligne 1548) appelle le Worker, puis **bascule sur le moteur
  local dès que la réponse n'est pas un succès**. Un refus de quota (402), de débit (429) ou de plafond de messages (409)
  déclenche donc le moteur local, sans compteur. C'est le contournement que vous avez identifié. Il est présent dans
  `main` et dans la branche.
- Côté Worker, `persona` et `facts` viennent du navigateur et ne sont pas re-vérifiés contre le cas. Le serveur valide
  le format et l'identifiant du cas (302 identifiants autorisés), mais pas le contenu. C'est acceptable pour les quotas,
  moins pour le contrôle du contenu.

### 2.6 Droits et abonnements

- Le Premium est lu dans KV (`plan:<uid>`). KV est éventuellement cohérent (une minute de décalage possible).
- Aucun paiement, aucun webhook. Le passage Premium est manuel.
- Les règles Firestore interdisent l'écriture de tout document sauf `progression`, `etats` et `medecins`. Les droits
  ne sont donc pas modifiables par le client, c'est un point positif.

### 2.7 Points déjà corrects sur la branche

- Vérification du jeton Firebase (RS256, émetteur, audience, expiration, email vérifié) : testée.
- Réservation atomique des quotas dans un Durable Object (sérialisation des opérations) : testée en concurrence simulée
  (100 requêtes simultanées → 5 acceptées).
- Liste blanche des 302 identifiants de cas, validation stricte du contenu.
- Mode fermé (503) si la configuration ou les liaisons sont incomplètes.
- Tests : 70 réussis, dont 5 de cohérence de la politique des quotas et 12 de la PWA.

---

## 3. Décisions à prendre

### D-P1 — Niveau de protection des cas (C1)

| Option | Principe | Protège | Coût et risque |
|---|---|---|---|
| **α (recommandée, première étape)** | Retirer du navigateur les corrigés et les règles de notation (`key`, `exEss`, `dx`, `tx`, `pieges`, `rev`, `full`). Le Worker les détient (module généré à partir de `cases_202.js`) et les renvoie après la fin de la consultation. | Corrigé et grille de notation | Le simulateur reste jouable hors ligne. Le patient et ses réponses restent lisibles. |
| **β** | Le Worker sert aussi le patient : chaque réponse est calculée côté serveur, à partir d'un identifiant de cas et d'une question. | Tout le contenu du cas | Moteur local remplacé pour le contenu protégé ; hors ligne limité ; plus de requêtes. Changement majeur. |

Ma recommandation : **α en premier**, car il supprime le corrigé sans casser le simulateur. β reste la seule option qui
protège le contenu clinique lui-même. Ce choix doit être validé par vous, car il change ce que les étudiants peuvent
faire hors ligne.

### D-P2 — Calcul des scores (C3)

- **Principe** : le Worker calcule la note à partir du **transcript** (messages envoyés par l'étudiant), pas à partir
  d'une liste de questions déclarée par le navigateur. Le serveur rejoue les règles de détection sur les messages.
- **Limite honnête** : tant que le patient est simulé dans le navigateur (option α), un étudiant peut fabriquer un
  transcript. La triche devient plus difficile, pas impossible. Une garantie complète demande β.
- Dépend de D-P1 : sans les règles sur le serveur, pas de calcul serveur.

### D-P3 — Moteur local et refus de quota

- **Changement proposé** : sur 402, 409 et 429, le navigateur n'appelle plus le moteur local et affiche un message clair
  (quota atteint, date de renouvellement). Le moteur local reste utilisé seulement en cas d'échec réseau ou d'indisponibilité
  du Worker (503, délai dépassé).
- **Conséquence voulue** : un gratuit qui a épuisé ses 5 consultations ne peut plus simuler, même hors IA.
- **Point à trancher** : une simulation hors ligne ne peut pas être comptée (décision D5 de l'architecture espace Jeux).
  Ma proposition : pas de simulation hors ligne pour les comptes, ou un jeton de repli réservé au mode local.
- **Risque** : une modification de `answerPatient` touche le parcours principal. Elle doit être testée dans un navigateur
  (Chromium en simulation, puis appareils réels).

### D-P4 — Source des droits (centralisation)

- Option A (recommandée) : Durable Object par utilisateur pour les droits (lecture et écriture fortement cohérentes),
  KV en cache de lecture seule.
- Option B : base D1 pour les droits. Plus simple à interroger, mais une dépendance supplémentaire.
- Pas de paiement tant que le fournisseur n'est pas choisi (décision M3 et M4).

### D-P5 — Fraude et comptes multiples

- Turnstile sur le site, App Check sur les applications mobiles (phase 4).
- Ces services sont gratuits ou payants selon l'usage : **à valider avant souscription** (vous avez exclu tout service
  payant pour cette phase).

---

## 4. Plan de sous-étapes

Chaque sous-étape est présentée séparément. Aucune opération risquée n'est lancée sans votre accord.

| Sous-étape | Contenu | Risque | Dépend de | Statut |
|---|---|---|---|---|
| **1.1** | Audit (ce document) | Aucun | — | **Fait** |
| **1.2** | Vérifier C2 sur la branche : tests, revue du code d'authentification et des quotas | Faible (lecture et tests) | — | À faire sans accord |
| **1.3** | Préparer le plan de déploiement C2 : KV `STATE`, Durable Objects, variables, tests sur Cloudflare réel **dans un environnement séparé** | Moyen (création de ressources) | Accord | En attente |
| **1.4** | Correction du contournement (D-P3) sur la branche, avec tests navigateur | Moyen (parcours utilisateur) | Accord sur D-P3 | En attente |
| **1.5** | C1 α : module des corrigés sur le Worker, suppression des corrigés du navigateur, tests | Élevé (contenu, hors ligne) | Accord sur D-P1 | En attente |
| **1.6** | C3 : scoring serveur à partir du transcript, tests de cohérence avec le calcul actuel | Élevé (notes des étudiants) | 1.5 | En attente |
| **1.7** | Droits centralisés (D-P4) et protection contre les doubles consommations | Moyen | Accord sur D-P4 | En attente |
| **1.8** | Turnstile et App Check | Dépend du service choisi | Accord (D-P5) | En attente |
| **1.9** | Fusion et déploiement en production | Élevé et irréversible | Accord écrit explicite | **Non prévu sans accord** |

---

## 5. Tests prévus

- **Automatisés (simulation)** : déjà 70 tests. À ajouter pour chaque sous-étape : absence de corrigés dans le navigateur
  (recherche des champs dans les fichiers livrés), cohérence du scoring serveur avec l'ancien calcul sur un jeu de
  transcripts, refus sans appel au moteur local sur 402, 409 et 429.
- **Cloudflare réel** : impossible à faire sans ressources créées. À réaliser dans un environnement de test séparé, après
  accord (sous-étape 1.3). Aucun résultat de simulation ne sera présenté comme une validation réelle.
- **Firebase réel** : comptes de test à créer, avec votre accord. Non réalisé.
- **Navigateur** : Chromium en simulation seulement. Android et iOS réels à faire.

---

## 6. Risques résiduels

1. **Production ouverte** : tant que C2 n'est pas déployé, le Worker IA n'a ni authentification ni quota. C'est le risque
   le plus important et il ne dépend pas de la branche.
2. **Mode débogage en production** : supprimé sur la branche seulement.
3. **Triche sur les scores** : réduite par α et D-P2, pas supprimée sans β.
4. **Contenu clinique lisible** : tant que β n'est pas décidé, le patient reste lisible dans le navigateur.
5. **Hors ligne et protection** : les deux objectifs sont en tension. Le choix appartient à l'équipe.
6. **Comptes multiples** : non traités par le code seul.

---

## 7. Ce qu'il faut décider maintenant

1. **Déploiement de C2 en production** : autorisé ou non, et dans quel ordre (sous-étape 1.3 d'abord, dans un environnement séparé).
2. **D-P1** : option α ou β pour les cas.
3. **D-P3** : acceptez-vous qu'un gratuit qui a épuisé son quota ne puisse plus simuler, même hors IA ?
4. **D-P4** : Durable Object ou D1 pour les droits.
5. **Correction immédiate du mode débogage sur `main`** : souhaitez-vous que je prépare une modification minimale de trois lignes, à fusionner séparément, sur votre autorisation ?
