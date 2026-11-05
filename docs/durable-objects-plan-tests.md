# Plan de tests Durable Objects (environnement Cloudflare réel)

Statut : **plan uniquement.** Aucun déploiement n'a été fait. Ces tests se font sur un environnement de
**préproduction** dédié, jamais sur le Worker de production `muddy-shadow-c8d5`.

## 0. Prérequis

- Un Worker de préproduction (nom distinct, par exemple `muddy-shadow-c8d5-preprod`), avec ses propres liaisons.
- Un namespace KV `STATE` de préproduction, créé pour l'occasion (`wrangler kv namespace create STATE --env preprod`).
- Deux comptes Firebase de test, email vérifié, avec leurs identifiants (`uid-A`, `uid-B`).
- Un script de test qui obtient des jetons Firebase réels (connexion avec le compte de test) et les envoie au Worker.
- Un accès Workers AI sur le compte.

## 1. Configuration du namespace Durable Objects

**Vérifier**
- `wrangler.toml` déclare `[[durable_objects.bindings]]` avec `name = "QUOTA"` et `class_name = "QuotaLimiter"`.
- La migration `tag = "v1"` contient `new_sqlite_classes = ["QuotaLimiter"]`.
- `npx wrangler deploy --dry-run --env preprod` liste la liaison `QUOTA` (Durable Object) et `STATE` (KV) sans erreur.

**Résultat attendu** : aucune erreur de liaison ; la classe est reconnue.

**Risque** : si la liaison `STATE` pointe encore sur `REMPLACER_PAR_ID_KV_STATE`, le déploiement échoue. C'est voulu.

## 2. Migration

**Procédure**
1. Déployer la préproduction pour la première fois.
2. Vérifier dans le tableau de bord que l'objet `QuotaLimiter` apparaît dans les Durable Objects, avec la migration `v1`.
3. Redéployer sans changer la migration : aucune erreur ne doit apparaître.

**Points de contrôle**
- La migration `v1` ne doit **jamais** être modifiée ni retirée une fois en production (cela efface les compteurs).
- Une nouvelle classe demande une nouvelle migration (`v2`), jamais une modification de `v1`.

## 3. Objet par utilisateur

**Test** : `uid-A` consomme 3 cas ; `uid-B` ne doit rien voir.

**Attendu** : `uid-B` a un quota plein (5 cas disponibles) ; les compteurs sont indépendants.

**Commande** : deux séries de requêtes avec deux jetons, puis lecture des `quota.used`.

## 4. Limite par IP

**Test** : depuis une seule machine, 21 requêtes successives, même adresse.

**Attendu** : les 20 premières passent la limite IP (et échouent éventuellement plus loin, en 401 si jeton invalide) ; la 21e
renvoie **429**.

**Précaution** : `CF-Connecting-IP` est fourni par Cloudflare et ne peut pas être falsifié depuis le client.
Le test doit donc venir d'une vraie adresse de test. Les IP partagées (NAT) ne peuvent pas être simulées ici.

## 5. Persistance des compteurs

**Test**
1. `uid-A` consomme 2 cas.
2. Attendre plusieurs minutes sans requête (l'objet peut alors être retiré de la mémoire).
3. `uid-A` consomme un 3e cas.

**Attendu** : `quota.used` = 3, pas 1. Le stockage SQLite du Durable Object survit à l'éviction.

## 6. Redémarrage

**Test**
1. Consommer 2 cas.
2. Redéployer la préproduction avec un changement sans effet sur les données (par exemple un commentaire).
3. Consommer un 3e cas.

**Attendu** : `used` = 3. Un redéploiement ne doit pas effacer les compteurs.

**Risque connu** : la file de traitement (mutex) est en mémoire. Elle est vide au redémarrage, ce qui est sans danger
car aucune opération n'est en cours. Une requête interrompue pendant la réservation peut laisser une réservation
sans libération (voir `docs/quotas-politique.md`, limite 7).

## 7. Requêtes simultanées

**Test A** : 100 requêtes simultanées, `uid-A`, 100 cas distincts valides.
**Attendu** : exactement **5** réponses 200 ; 95 réponses 402 (ou 429 si la limite de débit est atteinte avant).
Pour isoler le quota, régler `USER_REQUESTS_PER_MINUTE` à 1000 en préproduction.

**Test B** : 100 requêtes simultanées, `uid-B`, même cas valide.
**Attendu** : exactement **40** réponses 200 ; le reste en 409 (`reason: messages`).

**Test C** : 100 requêtes simultanées mêlant cas distincts et répétés.
**Attendu** : `quota.used` final ≤ 5 et `msgs` par cas ≤ 40 ; aucun dépassement.

**Mesure** : compter les réponses 200 et comparer avec les appels IA (journaux Workers AI) : ils doivent être égaux.

## 8. Double réservation et libération incorrecte

**Risque 1 : double réservation**. Deux requêtes pour un même cas ne doivent pas compter deux fois le cas.
→ Couvert par le test 7-B (le compte des cas reste à 1 pour un cas unique).

**Risque 2 : libération d'un mauvais cas**. La libération est indexée par `caseId`. Une libération pour `cas_X` ne
peut toucher que `cas_X`.
→ Test : après un échec IA sur `cas_1` pendant qu'une requête réussie porte sur `cas_2`, `cas_2` doit garder son
compte.

**Risque 3 : libération en double**. Un second appel de libération ne doit pas retirer un message qui n'a pas été réservé.
→ Test : libérer deux fois la même réservation ; le compteur ne doit pas descendre sous zéro.

**Risque 4 : échec IA réel**. Pour provoquer un échec IA en préproduction sans modifier le code, utiliser une valeur
de modèle invalide dans une version de test (à déployer uniquement en préproduction), puis vérifier que `msgs` et `used` ne bougent pas.

## 9. Indisponibilité

**Test A** : retirer la liaison `QUOTA` en préproduction → 503, IA non appelée.
**Test B** : configuration invalide (`MAX_MESSAGES_PER_CASE=abc`) → 503.
**Test C** : KV `STATE` absent → 503.

**Attendu** : aucune réponse IA dans ces trois cas ; le navigateur doit basculer sur le moteur local. Ce dernier point
se vérifie dans un navigateur sur la préproduction.

## 10. Coûts et limites Cloudflare

Vérifier avant production :
- le coût des Durable Objects (requêtes et stockage) à volume réel ;
- le débit d'un objet unique : un utilisateur ne génère qu'un petit nombre de requêtes par minute, donc le goulot
  est acceptable, mais à mesurer ;
- la durée maximale d'exécution d'une requête (une réservation et un appel IA doivent y tenir).

## 11. Critères de passage en production

- Tous les tests 1 à 9 passent sur la préproduction.
- Les tests 7 et 8 sont répétés au moins trois fois, sans écart.
- Un test de bout en bout depuis le navigateur (connecté, quota atteint, IA en panne) est validé.
- La limite par IP est revue (voir `docs/quotas-politique.md`).
- Le retour arrière (`worker/README.md`, section 11) a été testé sur la préproduction.

## 12. Retour arrière

- Revenir à une version précédente du Worker ne supprime pas le Durable Object ni ses compteurs.
- Ne jamais retirer la migration `v1` en production.
- Ne jamais supprimer le namespace `STATE` sans sauvegarde des enregistrements `plan:<uid>`.
