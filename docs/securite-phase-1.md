# Sécurité, Phase 1 : état et suite

Branche : `securite/phase-1-cases-worker-scores`. Aucune fusion, aucun déploiement.

## Livré dans cette branche

### C2 : Worker IA sécurisé (fait)
- Vérification du jeton Firebase (RS256, clés publiques Google, émetteur, audience, expiration, délai d'horloge de 5 min).
- Refus si l'email n'est pas vérifié.
- Quota mensuel par utilisateur, appliqué côté serveur (KV `STATE`).
- Plan Premium lu depuis `plan:<uid>`, avec date de fin ; sans enregistrement valide, formule gratuite.
- Limite de débit par utilisateur (20 requêtes par minute).
- Échec fermé : sans `STATE`, réponse 503.
- Le client envoie le jeton ; sans jeton, le moteur local prend le relais (comportement déjà prévu).
- 19 tests automatisés (`worker/test/`), dont signature falsifiée, algorithme `none`, audience, expiration, quota, Premium expiré, échec de l'IA sans décompte.

### Ce qui change pour les utilisateurs
- Un visiteur **non connecté** n'a plus accès à l'IA (il bénéficie du moteur local).
- Un utilisateur **connecté** dispose de 5 cas IA par mois.
- Au-delà du quota, le moteur local prend le relais, sans message explicatif pour l'instant.

## Non réalisé dans cette branche (à traiter avant le Premium)

### C1 : cas et corrigés côté serveur (non fait)
- Les 302 cas et leurs corrigés (`dx`, `tx`, `pieges`, `expl`) restent dans `cases_202.js`, chargé par le navigateur.
- La notation (`scoreEntry`, `dxHit`, `evaluate`) est exécutée dans le navigateur et dépend de l'état de l'interface.
- Une migration sûre demande : un module de notation partagé, sans dépendance au DOM, utilisé à la fois par le navigateur et le Worker ; un fichier de cas public (sans corrigé) ; un fichier de cas privé servi par le Worker ; des tests de non-régression sur les 302 cas.

### C3 : scores et progression (non fait)
- Les scores sont calculés et écrits par le navigateur (`index.html` ligne ~2212, `setDoc` sur `progression`).
- Les règles Firestore ne contrôlent pas les valeurs des scores.
- Solution prévue : calcul par le serveur et écriture par le serveur (Firebase Admin, via compte de service stocké en secret), puis fermeture des écritures client sur `progression`. Cette étape n'est pas faite car elle casserait l'enregistrement de la progression sans le serveur.

## Configuration externe nécessaire
1. Créer l'espace KV `STATE` et le lier au Worker sous ce nom.
2. Vérifier que la liaison `AI` existe toujours.
3. Facultatif : conserver `RATE`.
4. Déployer le Worker **après** la fusion, jamais avant.

## Points à valider
- Valeurs des quotas (5 gratuits, 60 Premium).
- Comportement après quota atteint (moteur local, sans message).
- Non-connectés sans IA : accepté ?

## Tests manuels à faire avant fusion
- Connexion Google et email ; consultation avec IA ; quota gratuit (6e cas) ; moteur local en mode non connecté.
- Android (Chrome) et ordinateur ; progression et badges inchangés ; 302 cas toujours présents.
