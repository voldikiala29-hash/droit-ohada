# Limitation par IP et réseaux partagés (propos, non appliqué)

Statut : **proposition.** Aucun paramètre Cloudflare ni Firebase n'a été modifié. Les valeurs ci-dessous sont des
propositions à valider.

## 1. Problème

Aujourd'hui, `IP_REQUESTS_PER_MINUTE = 20` s'applique à **toutes** les requêtes, avant même la vérification du jeton.
Dans une université, tous les étudiants sortent par la même adresse publique (NAT). Une promotion entière partage
donc 20 requêtes par minute. Un seul étudiant actif peut bloquer les autres.

Le quota doit reposer sur l'**identité** (compte Firebase), pas sur l'adresse réseau.

## 2. Principe proposé : quota principal par utilisateur, IP en filet de sécurité

| Couche | Clé | Rôle | Valeur proposée (à valider) |
|---|---|---|---|
| 1. Quota métier | `uid` Firebase | Cas distincts (5 gratuit / 150 Premium), plafond de 40 messages par cas, débit par utilisateur | Politique révisée : 5 / 150 / 40 ; débit utilisateur 20/min |
| 2. Filet anonyme | IP | Bloque les requêtes **sans jeton valide** (bots, scripts) | 30 par minute |
| 3. Plafond authentifié | IP | Borne un abus massif depuis une même adresse, sans bloquer un campus | 300 par minute |
| 4. Périmètre Cloudflare | IP, en amont du Worker | Attaques volumétriques et bots, hors Worker | Règle de limitation à définir dans le tableau de bord (non appliquée) |

### Pourquoi 300 par minute pour le plafond authentifié

Hypothèse de calcul (à mesurer) : un étudiant qui envoie un message toutes les 20 secondes produit 3 requêtes par
minute. 300 par minute couvre donc environ 100 étudiants actifs simultanément derrière la même adresse. Une promotion
plus nombreuse en consultation simultanée dépasserait ce seuil : il faudra alors le relever ou exempter l'adresse.

### Pourquoi 30 par minute pour les requêtes anonymes

Un visiteur légitime ne fait aucune requête IA sans être connecté : le client n'envoie que des requêtes qui seront
refusées (401) et qui basculent sur le moteur local. Trente requêtes anonymes par minute et par adresse suffisent
pour détecter un script, sans toucher les usages normaux.

## 3. Modifications de code nécessaires (à autoriser, non faites)

1. **Déplacer la limite IP après la vérification du jeton** pour les requêtes authentifiées (plafond de 300).
2. **Garder une limite IP avant authentification** pour les requêtes sans jeton valide (30/min).
3. **Ne plus compter les requêtes authentifiées dans la limite anonyme.**
4. Nouvelles variables : `ANON_IP_REQUESTS_PER_MINUTE` (30) et `AUTH_IP_REQUESTS_PER_MINUTE` (300).
   `IP_REQUESTS_PER_MINUTE` est remplacée par ces deux variables.

Ordre dans le Worker proposé :
```
origine -> méthode -> configuration -> validation du contenu
-> si jeton absent ou invalide : limite anonyme par IP (30/min), puis 401
-> jeton valide : limite authentifiée par IP (300/min), puis débit utilisateur (20/min), puis quotas
```

Conséquence : un bot qui envoie des jetons invalides est arrêté par la limite anonyme ; un étudiant authentifié
n'est limité que par son propre compte, sauf si toute l'université dépasse 300 par minute.

## 4. Gestion des connexions partagées dans les universités

- **Ce qui est partagé** : l'adresse IP. **Ce qui ne l'est pas** : le compte Firebase, donc le quota métier.
- Si une université dépasse régulièrement le plafond authentifié, deux options :
  - relever le plafond pour cette adresse (liste d'exemptions gérée à la main) ;
  - ne rien faire, et laisser le moteur local prendre le relais (pas d'erreur visible).
- Les journaux de refus (429) par adresse doivent être surveillés pour repérer les campus concernés.
- **Risque** : une liste d'exemptions IP est une donnée à maintenir. À limiter au strict nécessaire.

## 5. Protection contre les attaques automatisées

Couches proposées, par ordre de priorité :

1. **Limite anonyme par IP** (section 3) : bloque les requêtes sans jeton. Aucun coût de configuration.
2. **Règle de limitation Cloudflare** (tableau de bord) : limite les volumes anormaux avant le Worker. **Nécessite ton
   autorisation** et une configuration dans le compte.
3. **Firebase App Check** : vérifie que les requêtes viennent bien de l'application et non d'un script. Demande une
   intégration côté client (reCAPTCHA), donc une modification de `index.html`. **Décision à prendre.**
4. **Turnstile** (Cloudflare) sur l'inscription et la connexion : freine la création massive de comptes, qui contourne
   les quotas gratuits. Demande une intégration côté client. **Décision à prendre.**

Les points 3 et 4 ne sont pas nécessaires pour déployer C2, mais ils limitent le contournement par comptes multiples,
risque connu et non traité.

## 6. Tests à réaliser

- Une seule adresse, 25 requêtes sans jeton en une minute : les 5 dernières sont refusées (429).
- Une seule adresse, 10 comptes de test, chacun 2 requêtes par minute : aucune refusée.
- Une adresse, 150 requêtes authentifiées en une minute depuis 15 comptes : aucune refusée.
- Une adresse, 350 requêtes authentifiées en une minute : les dernières sont refusées (429).
- Vérifier que le refus n'entraîne pas de quota de cas consommé.
- Tester depuis un réseau réellement partagé (point d'accès mobile ou Wi-Fi d'un établissement), avec des comptes de test.

## 7. Points à décider

1. Valeurs 30 (anonyme) et 300 (authentifié) par minute.
2. Autoriser la modification du code pour séparer les deux limites (section 3).
3. Règle de limitation Cloudflare dans le tableau de bord : oui ou non, et avec quelle valeur.
4. Intégrer App Check et Turnstile maintenant, ou dans une phase ultérieure.
5. Procédure d'exemption IP pour les campus (qui décide, qui maintient la liste).
