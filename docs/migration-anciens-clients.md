# Migration des anciens navigateurs (1.4-C) : analyse et stratégie

Statut : analyse et proposition, aucune décision prise. Date : 6 novembre 2026.
Référence de code : `main` (index.html lignes 1548 à 1567 ; worker/patient-worker.js sur `main`).

## 1. Ce que font réellement les anciens clients

L'ancien client de `main` :

- envoie `Content-Type: application/json` et **jamais** `Authorization` ni `X-SDG-Protocol` ;
- n'utilise la réponse du Worker que si elle est `ok`, contient `reponse` et n'est pas marquée `source: "error"` ;
- sinon (statut non ok, exception, délai de 15 s) il appelle `patientReply`, **le moteur de règles local**, sans quota.

Conséquences vérifiées par lecture du code :

1. **La date `PROTOCOL_CUTOFF` ne protège aucun ancien client.** Dans le Worker v2, l'authentification (étape 3) précède le contrôle de protocole (étape 4). Un ancien client n'a pas de jeton, donc il reçoit 401 dès le premier jour, avant toute vérification de date. La « période de transition de 30 jours » annoncée par 1.4-C n'a donc aucun effet pour eux.
2. **Avant le Worker v2, le problème est pire.** Le Worker actuel sur `main` n'authentifie personne et ne compte rien : les anciens clients ont l'IA gratuite et illimitée côté serveur.
3. **Le Worker v2 ferme la porte serveur mais ouvre le moteur local** aux anciens clients. Le contournement des quotas ne disparaît pas ; il se déplace vers le moteur de règles.
4. **Le serveur ne peut pas empêcher ce comportement.** Il ne contrôle pas le code exécuté par la page. Aucune réponse HTTP (401, 402, 409, 426, 429) ne l'arrête, puisque toutes déclenchent le même repli.

## 2. Le scénario demandé : ancien client, Worker v2, sans jeton, 401, moteur local

Ce scénario ne peut être supprimé que par le remplacement du code de l'ancien client. Trois voies, par ordre de rendement :

| Voie | Mécanisme | Limite |
|---|---|---|
| Mise à jour du service worker | `sw.js` en réseau d'abord : tout chargement en ligne reçoit la nouvelle `index.html`. Changement de `VERSION` obligatoire à chaque modification de la coquille (garde-fou : `worker/test/sw-update.test.mjs`). | Ne concerne que les chargements. |
| Onglets déjà ouverts | Le nouveau service worker prend le contrôle (`clients.claim`) mais **ne recharge pas la page**. L'ancien JavaScript continue. | Tant que l'onglet n'est pas rechargé. Forcer `WindowClient.navigate()` risque de faire perdre un brouillon ; non recommandé sans mesure. |
| PWA installée | Même mécanisme que le navigateur, à la prochaine ouverture en ligne. | Dépend des mises à jour de l'OS (iOS peut retarder). |
| Hors ligne | L'ancienne coquille reste servie depuis le cache. Le moteur local répond **sans quota et sans connexion**. | Risque résiduel, borné par la durée pendant laquelle l'appareil reste hors ligne sans rouvrir l'application. Non traitable côté serveur. |

## 3. Comportement de chaque erreur selon la version du client

| Code | Nouveau client (1.4a) | Ancien client |
|---|---|---|
| 200 | Réponse affichée, avertissement si `X-SDG-Upgrade` | Réponse affichée |
| 401 | « Connecte-toi pour consulter le patient » ; aucune réponse locale | **Moteur local** |
| 402 | Quota de cas atteint ; aucune réponse locale | **Moteur local** |
| 403 | Vérification de l'e-mail demandée | **Moteur local** |
| 409 | Plafond de messages ou requête en cours ; question restituée | **Moteur local** |
| 410 | Demande explicite (la question n'est pas recomptée) | **Moteur local** |
| 426 | « Mets à jour l'application » ; aucune réponse locale | **Moteur local** |
| 429 | Attendre une minute ; aucune réponse locale | **Moteur local** |
| 503 / délai | Question conservée, « Réessayer » (même identifiant, décompte unique) | **Moteur local** |

Le 426 n'a donc d'utilité que pour les nouveaux clients, qui savent l'afficher. Il ne sert à rien contre les anciens.

## 4. Observation : ce que le Worker peut mesurer

Le Worker écrit désormais, pour chaque requête sans `X-SDG-Protocol`, une ligne JSON sans donnée personnelle :

```json
{"evt":"sans_protocole","avec_jeton":false,"at":1794312000000}
```

`avec_jeton: false` identifie les anciens clients (ils n'envoient jamais de jeton). Cette mesure est la seule façon de savoir combien d'anciens clients restent actifs. Elle suppose que les journaux Workers sont activés et consultables ; **à vérifier dans le tableau de bord Cloudflare, aucune vérification réelle n'a été faite**.

## 5. Stratégie proposée

**Étape A : ordre de déploiement (inchangé, obligatoire).** Le Worker v2 est en production **avant** le client 1.4a. Sinon le préflight CORS échoue (le Worker actuel n'autorise que `Content-Type`) et le chat tombe pour tous.

**Étape B : Worker v2 en production.** Les anciens clients passent au moteur local dès ce jour. Décision D-N1 à prendre avant.

**Étape C : client 1.4a et service worker `sdg-pwa-2026-11-06a` en production**, après l'étape B.

**Étape D : observation de 14 jours.** Suivre `sans_protocole` avec `avec_jeton: false`. Critère de fin proposé (D-N3) : moins de 1 % des requêtes sur 7 jours consécutifs.

**Étape E : fin de la migration.** Quand le critère est atteint, le moteur local ne sert plus qu'aux anciens clients hors ligne, par construction. **La date `PROTOCOL_CUTOFF` n'a aucun rôle de sécurité** : elle n'accélère pas la fin de la migration. Décision D-N2 (voir section 6).

## 6. Décisions à prendre (non tranchées)

- **D-N1 : acceptez-vous que les anciens clients basculent sur le moteur local dès le déploiement du Worker v2 ?** Proposition : oui, car la réponse serveur sans quota n'est plus possible. Conséquence pour les étudiants : une réponse moins riche, non comptée, sans message. Il faudrait l'annoncer.
- **D-N2 : supprimer la notion de date de transition ?** Proposition : refuser d'emblée toute requête sans `X-SDG-Protocol` (426, avant l'authentification). Cela modifie la décision 1.4-C (« 30 jours puis blocage ») ; elle relève donc de vous.
- **D-N3 : seuil de fin de migration.** Proposition : moins de 1 % des requêtes sans protocole pendant 7 jours.

## 7. Retour arrière

- **Ne jamais revenir au Worker v1** (sans authentification, sans quota) : ce serait rouvrir la faille la plus grave.
- Retour arrière du Worker v2 : désactiver le contrôle de protocole (le refus 426 disparaît) sans toucher à l'authentification ni aux quotas.
- Retour arrière du client : `git revert` du commit client **et** nouvelle `VERSION` du service worker. Ne jamais réutiliser une version déjà publiée : les navigateurs garderaient la coquille en cache.
- Dans tous les cas, la date `PROTOCOL_CUTOFF` se remet à une date future explicite, jamais au placeholder (le contrôle `worker/scripts/check-deploy.mjs` le refuse).

## 8. Risques pour les étudiants

| Risque | Gravité | Mesure |
|---|---|---|
| Réponse du moteur local (anciens clients) : moins riche, sans signalement | Moyenne | Annonce dans l'application, D-N1 |
| Question perdue si le stockage local est effacé pendant une panne | Moyenne | Documentée (A6 de la revue) ; « Abandonner » explique l'état |
| Nouveau client : « Connecte-toi » au lieu d'une réponse | Faible | Message explicite |
| Faux positif du contrôle de protocole sur un navigateur récent | Élevée si elle existe | Tests navigateur 18/18 ; à reproduire sur appareil |
| Mise à jour iOS retardée | Moyenne | Mesure `sans_protocole` ; pas de contrôle possible sur l'appareil |

## 9. Ce qui reste à faire sur un environnement réel

- Vérifier que les journaux Workers conservent `sans_protocole` et permettent de compter les lignes.
- Mesurer, sur un appareil réel, le comportement d'un onglet ouvert pendant la mise à jour du service worker.
- Vérifier la mise à jour de la PWA installée sur iOS et Android.
