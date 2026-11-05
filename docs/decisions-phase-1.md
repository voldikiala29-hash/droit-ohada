# Décisions de la phase 1 : limites, erreurs et architecture des droits

Statut : **documentation et architecture proposée. Aucun code modifié, aucune ressource Cloudflare ou D1 créée, aucun
déploiement, aucune modification de production.** Ce document précise les décisions D-P1 à D-P4 de
`docs/audit-phase-1.md`. D-P5 (Turnstile, App Check) est reporté.

Documents liés : `docs/audit-phase-1.md`, `docs/revue-c2-sous-etape-1-2.md`, `docs/quotas-politique.md`,
`docs/architecture-espace-jeux.md`.

---

## 1. D-P1 — Protection des cas : option α

### 1.1 Ce qui est retenu

Les corrigés, diagnostics attendus, grilles de notation et traitements indispensables ne sont plus présents dans les
fichiers publics du navigateur. Le Worker les détient et les renvoie après la consultation.

Champs concernés dans `cases_202.js` : `key`, `exEss`, `dx`, `tx`, `pieges`, `rev`, `full`. Les champs nécessaires au
simulateur (`plainte`, `hist`, `ex`, `res`) restent dans le navigateur.

### 1.2 Mécanisme prévu

1. **Génération** : un script hors ligne extrait les champs protégés de `cases_202.js` et produit un module
   `worker/case-answers.js` (une entrée par identifiant de cas). Le module est généré, jamais écrit à la main.
2. **Test de cohérence** : le script vérifie que le nombre de cas est 302, que chaque identifiant existe dans
   `case-ids.js`, et qu'aucun champ protégé n'apparaît dans les fichiers publics (voir §1.4).
3. **Fin de consultation** : le navigateur envoie au Worker le transcript de la consultation (voir D-P2). Le Worker
   renvoie le corrigé et la note. Le corrigé n'est jamais demandé avant la fin.
4. **Affichage** : le corrigé s'affiche après validation. Il ne peut pas être demandé pendant la consultation.

### 1.3 Limites documentées

| Limite | Conséquence |
|---|---|
| **Le contenu clinique reste lisible.** Le patient, ses réponses (`hist`) et les résultats (`ex`, `res`) sont dans le navigateur. | Un étudiant qui lit le code peut connaître le cas sans jouer. α protège le corrigé, pas le cas. |
| **Le moteur local a besoin de `hist` et `res`.** | Le hors ligne et le moteur local sont conservés, donc le contenu reste nécessaire dans le navigateur. |
| **Le diagnostic peut être déduit** des résultats d'examens et du contenu clinique, sans corrigé. | Un étudiant attentif peut trouver le diagnostic. Le corrigé est protégé, la déduction ne l'est pas. |
| **Les champs protégés peuvent fuiter avant la fin** si une version précédente du site reste en cache (service worker). | Le changement de `VERSION` dans `sw.js` est nécessaire au déploiement. |
| **Le Worker devient une dépendance** pour la correction. | Sans le Worker, pas de corrigé. Comportement à définir en cas de panne (voir §3). |

### 1.4 Vérification automatisée

- Test : aucun des champs protégés n'apparaît dans `cases_202.js` une fois α appliqué (le fichier publié est
  reconstruit sans eux).
- Test : aucun des champs protégés n'apparaît dans `index.html` ni dans `sw.js`.
- Test : le Worker renvoie le corrigé seulement après un transcript valide.

Ces tests n'existent pas encore. Ils seront écrits pendant la sous-étape 1.5.

### 1.5 Évolution vers β

β fait traiter le patient par le serveur : chaque question reçoit une réponse calculée par le Worker, à partir de
l'identifiant du cas et de la question.

Étapes prévues, sans calendrier engagé :

1. Déplacer `hist` et `res` dans le module serveur, avec une réponse par question (identifiant de question, réponse).
2. Remplacer le moteur local par des appels au Worker pour le contenu protégé.
3. Décider du comportement hors ligne (voir §3.4) : sans moteur local, le simulateur n'est plus utilisable hors ligne.
4. Supprimer `cases_202.js` du navigateur, ne garder que les métadonnées publiques (nom, service).

β change l'expérience hors ligne. Il ne sera pas engagé sans votre décision écrite.

---

## 2. D-P2 — Calcul des notes côté serveur

### 2.1 Ce qui est retenu

La note est recalculée et validée côté serveur. Le navigateur ne peut plus écrire une note libre dans Firestore.

### 2.2 Principe

1. Le navigateur envoie le **transcript** : la liste des messages échangés (rôle, texte, horodatage), les examens
   demandés et les traitements proposés, le diagnostic annoncé.
2. Le Worker rejoue les règles de détection (les mêmes que `evaluate` aujourd'hui) sur le transcript, pas sur une liste
   de questions déclarée par le client.
3. Le Worker calcule la note, l'enregistre, et renvoie le résultat.
4. Firestore : le champ de note n'est plus écrit par le client. Une règle refuse les écritures de notes depuis le client
   (l'écriture passe par le Worker, avec un compte de service).

### 2.3 Limites de la validation d'un transcript fourni par le client

| Limite | Explication | Mesure possible |
|---|---|---|
| **Transcript fabriqué.** Un étudiant peut écrire un transcript qui n'a jamais eu lieu et obtenir une note élevée. | Le serveur ne voit pas la consultation réelle. Tant que le patient est simulé dans le navigateur (α), le serveur ne peut pas savoir si les réponses étaient celles du patient. | Vérifications de plausibilité : durée minimale, nombre de messages cohérent avec la durée, réponses du patient cohérentes avec le cas. Ce sont des freins, pas des garanties. |
| **Réponses du patient non vérifiables.** Le texte de la réponse du patient est fourni par le client. | Le serveur ne peut pas recalculer la réponse sans β. | Seule β (réponses calculées par le serveur) permet une vérification complète. |
| **Horodatage fourni par le client.** | La durée peut être fausse. | Horodatage serveur à l'envoi du premier message de la consultation, enregistré dans D1. |
| **Ré-envoi d'un transcript.** Un même transcript peut être noté plusieurs fois. | Risque d'inflation des notes et de doublons dans les classements. | Identifiant de consultation (`sessionId`) émis par le serveur au démarrage. Une seule note par `sessionId`. |
| **Notation rejouée sur une consultation abandonnée.** | Le transcript est incomplet. | La note n'est acceptée que pour une consultation terminée (`sessionId` marqué terminé côté serveur). |

**Conclusion** : avec α, la note devient difficile à tricher pour un étudiant ordinaire, mais elle n'est pas garantie
contre un étudiant technique. Une garantie complète demande β.

### 2.4 Lien avec les quotas

Une consultation commencée sur le serveur (D-P3, §3) est comptée. Son `sessionId` permet de rattacher la note à une
consultation comptée. Une note sans consultation comptée est refusée.

---

## 3. D-P3 — Moteur local et taxonomie des erreurs

### 3.1 Ce qui est retenu

- Le moteur local est désactivé lorsque l'utilisateur a épuisé son quota.
- Un utilisateur gratuit qui a consommé ses cinq consultations ne peut plus simuler gratuitement en contournant le Worker.
- Les refus 401, 402, 409 et 429 ne déclenchent **jamais** un fonctionnement de secours qui contourne les quotas.

### 3.2 Taxonomie proposée

| Code | Catégorie | Sens | Comportement du navigateur | Moteur local ? |
|---|---|---|---|---|
| 400 | Contenu invalide | Erreur de programmation côté client | Message technique discret, journal | **Non** |
| 401 | Authentification | Jeton absent, invalide ou expiré | Demander de se reconnecter | **Non** |
| 403 `email_unverified` | Authentification | Adresse non vérifiée | Inviter à vérifier l'adresse | **Non** |
| 403 `origin` | Sécurité | Origine non autorisée | Erreur, aucune réessai automatique | **Non** |
| 402 | Quota | Quota de consultations épuisé | Message clair avec date de renouvellement | **Non** |
| 409 (ou 402, voir F3 de la revue) | Quota | Plafond de messages du cas atteint | Message clair | **Non** |
| 429 | Débit | Trop de requêtes | Attendre, réessayer après un délai | **Non** |
| 503 `config` ou `unavailable` | Panne technique | Stockage ou configuration indisponible | Message « service momentanément indisponible » | **Oui, sous conditions (§3.3)** |
| 502 | Panne technique | L'IA n'a pas répondu | Réessayer | **Oui, sous conditions (§3.3)** |
| Délai dépassé, réseau coupé | Panne technique | Pas de réponse du Worker | Message « connexion instable » | **Oui, sous conditions (§3.3)** |

**Règle de distinction** : un code 4xx (sauf délai) est une **décision** du serveur : jamais de secours. Un code 5xx ou
une absence de réponse est une **panne** : secours possible, sous conditions.

### 3.3 Conditions du secours en cas de panne

Une panne ne doit pas devenir une porte de contournement. Proposition :

- **Le secours n'est autorisé que pour une consultation déjà comptée côté serveur.** Le serveur émet un `sessionId` au
  démarrage de chaque cas (lors de la première consultation). Pendant une panne, le navigateur ne peut continuer que la
  consultation pour laquelle il possède un `sessionId` valide, émis et comptabilisé avant la panne.
- **Pas de nouveau cas pendant une panne.** Un cas jamais démarré côté serveur ne peut pas être ouvert en secours.
- **Décompte différé** : les messages du secours sont comptés à la reconnexion, et le plafond de 40 messages est
  respecté à ce moment-là.

Décision à prendre (D-P3-bis) : acceptez-vous ces conditions pour les pannes ? La variante plus stricte est de
supprimer le secours entièrement (le simulateur ne fonctionne plus en cas de panne serveur).

### 3.4 Hors ligne et moteur local

Le moteur local reste disponible hors ligne **uniquement** pour une consultation déjà comptée (§3.3). Une consultation
démarrée hors ligne n'est pas comptée tant que le navigateur n'a pas pu la déclarer au serveur. Cette règle reprend la
décision D5 de l'architecture de l'espace Jeux : pas de simulation hors ligne pour les nouveaux cas.

### 3.5 Vérification automatisée prévue (sous-étape 1.4)

- Un refus 402, 409 ou 429 ne déclenche jamais le moteur local (test sur le client).
- Une panne 503 ou un délai ne déclenche le moteur local que pour une consultation avec `sessionId` valide (test).
- Un code 401 ou 403 affiche le message attendu et ne lance aucun appel de secours.

---

## 4. D-P4 — Architecture détaillée des droits

### 4.1 Ce qui est retenu

- **Cloudflare D1** : source de vérité des abonnements, droits et historiques commerciaux.
- **Durable Objects** : réservations atomiques et gestion des quotas.

### 4.2 Schéma D1 proposé

Tables (noms indicatifs) :

| Table | Rôle | Clés et contraintes |
|---|---|---|
| `users` | Identité minimale : `uid`, `email_verified`, date de création. Pas de nom ni de téléphone. | `uid` clé primaire |
| `subscriptions` | Une ligne par abonnement : formule, statut, début et fin de période, origine (store, web, manuel). | `id` clé primaire ; `provider_ref` unique |
| `purchases` | Une ligne par achat ou paiement : fournisseur, identifiant du fournisseur, montant, devise, statut. | `provider_tx_id` **unique** (idempotence) |
| `events` | Journal append-only des événements commerciaux (renouvellement, annulation, remboursement, changement de formule). | `id` ; jamais modifié ni supprimé |
| `entitlements` | Vue dérivée des droits actuels par uid (Premium, bundle). Recalculée à chaque événement. | `uid` clé primaire |

Principes :

- **Aucune donnée de santé** ni contenu de consultation dans D1. Les transcripts et les notes sont gérés séparément
  (voir §4.6).
- **Journal append-only** : une correction est un nouvel événement, pas une modification.
- **Idempotence** : un événement de fournisseur (webhook) déjà reçu ne modifie rien (`provider_tx_id` unique).

### 4.3 Rôle des Durable Objects

| Objet | Clé | Contenu | Rôle |
|---|---|---|---|
| `QuotaLimiter` (existant) | `uid:<uid>` | Compteurs du mois UTC, plafonds de messages, débit | Réservations atomiques (consultations et messages) |
| `QuotaLimiter` (existant) | `ip:<ip>` | Débit | Limite par adresse |
| **Nouveau** : `EntitlementCache` | `uid:<uid>` | Snapshot de la formule (formule, fin de période, version) | Lecture rapide dans le Worker, mise à jour par D1 à chaque changement |

Principe : **D1 décide, les Durable Objects appliquent.** Le Worker lit la formule dans le snapshot du Durable Object.
Si le snapshot est absent ou périmé, il est relu dans D1 avant la décision. Si D1 est indisponible, la requête est
refusée (échec fermé).

### 4.4 Flux

**Passage au Premium (immédiat)**

1. Le webhook du fournisseur arrive au Worker, avec signature vérifiée.
2. Le Worker insère l'achat dans `purchases` et l'événement dans `events` (une seule transaction D1, idempotente).
3. Le Worker met à jour `subscriptions` et `entitlements`.
4. Le Worker écrit le nouveau snapshot dans `EntitlementCache`.
5. La requête suivante de l'utilisateur voit la formule Premium : **effet immédiat** au sens de la décision.

**Downgrade (fin de période)**

1. L'événement d'annulation est enregistré. La fin de période (`period_end`) est conservée.
2. Jusqu'à `period_end`, la formule reste Premium.
3. À `period_end`, un job planifié écrit la formule gratuite dans D1 et dans le snapshot.
4. Les consultations déjà comptées pour le mois UTC restent comptées (décision retenue).

**Mois civil UTC** : les compteurs restent au mois civil UTC, comme décidé (« 5 consultations par mois civil UTC »). La
période d'abonnement ne sert qu'à la formule, pas aux compteurs.

### 4.5 Migration depuis KV

Aujourd'hui : `plan:<uid>` dans KV, écrit à la main.

Étapes proposées, sans rien supprimer :

1. Créer la base D1 **dans un environnement séparé** (sur autorisation).
2. Importer les `plan:*` existants dans `subscriptions` avec `origine = manuel`. KV n'est pas modifié.
3. Le Worker lit D1 pour la formule, avec un indicateur `ENTITLEMENTS_SOURCE=kv|d1` pour revenir à KV en cas de problème.
4. Comparer les deux sources pendant une période (journal des écarts).
5. Quand les écarts sont nuls, passer à D1 comme source. KV reste en lecture seule pendant au moins 30 jours.
6. Aucune suppression des données KV sans accord écrit.

### 4.6 Données sensibles et rétention

- Transcripts et notes : stockés séparément des droits, dans `attempts` (identifiant de consultation, note, date), sans
  texte de la consultation pour les notes (le transcript est conservé seulement si vous le décidez).
- Durée de rétention à décider (proposition : transcripts 90 jours, notes indéfiniment).
- Suppression de compte : à prévoir dans le parcours (exigence des stores), avec effacement ou anonymisation des
  transcripts. Ce point relève aussi de la protection des données, à valider juridiquement.

### 4.7 Cohérence et erreurs

| Situation | Comportement |
|---|---|
| D1 indisponible pour une lecture de formule | Refus 503 (échec fermé) |
| Snapshot Durable Object périmé | Relecture dans D1 avant décision |
| Webhook reçu deux fois | Ignoré (idempotence) |
| Webhook arrivé dans le désordre | L'événement est daté par le fournisseur ; la formule est recalculée à partir du journal, pas du dernier message reçu |
| Écart D1 / KV pendant la migration | Journal des écarts, alerte, décision humaine |

### 4.8 Coûts et limites (à vérifier avant souscription)

- D1 : grille tarifaire, quotas inclus, facturation par lignes lues et écrites. **À vérifier** avant création.
- Durable Objects : facturation par requêtes et durée ; le nouveau snapshot ajoute une lecture par requête.
- Cohérence de D1 : les lectures doivent se faire sur le primaire pour les décisions de droits. **À vérifier** dans la
  documentation D1 au moment de l'implémentation.

### 4.9 Ce qui n'est pas fait

- Aucune base D1 créée. Aucune migration. Aucun changement du Worker.
- Les règles de droits du code actuel (KV) restent en vigueur.

---

## 5. Décisions à prendre

| Id | Question |
|---|---|
| **D-P1-bis** | Acceptez-vous que le contenu clinique reste lisible dans le navigateur après α, en attendant β ? |
| **D-P2-bis** | Acceptez-vous des freins de plausibilité sur les transcripts (durée minimale, cohérence) plutôt qu'une garantie ? |
| **D-P3-bis** | Secours en cas de panne limité aux consultations déjà comptées (§3.3), ou suppression complète du secours ? |
| **D-P3-ter** | Plafond de messages : code 409 ou 402 ? (recommandation : 409) |
| **D-P4-bis** | Rétention des transcripts : 90 jours ? |
| **D-P4-ter** | Création de la base D1 dans un environnement séparé : quand l'autorisez-vous ? |
