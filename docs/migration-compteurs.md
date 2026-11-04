# Migration et remise à zéro des compteurs

## 1. Ce que contient réellement Cloudflare (lecture seule, vérifiée)

| Élément | Constat | Conséquence |
|---|---|---|
| Namespaces KV du compte | **Un seul** : `salledegarde-rate` (id `050d07c1…`) | Il n'existe **pas** de namespace `STATE`. Aucun plan Premium ni compteur de quota n'a pu être écrit. |
| Worker `muddy-shadow-c8d5` | Existe. Code déployé : **version d'origine**, sans jeton ni quota | Les compteurs de la branche n'ont jamais été déployés. |
| Usage de `salledegarde-rate` par le code déployé | Clés `rl:<ip>:<minute>` avec expiration de 120 s | Données **éphémères**, de limitation de débit uniquement. Aucune donnée utilisateur. |

**Conclusion** : les anciens compteurs KV ne contiennent **aucune donnée de quota réelle**. Le schéma `usage:<uid>:<mois>`
n'existe que dans la branche, qui n'a jamais été déployée. Il n'y a donc aucune donnée à migrer ni à remettre à zéro.

**Limite de cette conclusion** : je ne peux pas lister les clés d'un namespace avec les outils disponibles. La
conclusion repose sur le code déployé (`RATE` = clés éphémères) et sur l'absence du namespace `STATE`. Pour une
certitude totale, lister les clés de `salledegarde-rate` depuis le tableau de bord avant toute action.

## 2. Ce qui doit être fait au déploiement

1. **Créer** le namespace `STATE` (nouvel identifiant à reporter dans `wrangler.toml`). Aucun namespace existant n'est touché.
2. **Ne rien supprimer** : `salledegarde-rate` reste en place. Il n'est plus utilisé par la nouvelle version, mais la
   suppression est une opération destructive et n'est pas autorisée dans cette étape.
3. **Créer les plans Premium** éventuels après le déploiement, avec `wrangler kv key put` (voir `worker/README.md`).

## 3. Remise à zéro : stratégie

Comme il n'y a pas de compteur existant, la remise à zéro est **sans objet** pour la première mise en service. Le
Durable Object `QuotaLimiter` démarre vide.

Stratégie à retenir pour les futurs changements de quota ou de format :

- **Ne jamais réécrire un compteur en place.** Un changement de format passe par une nouvelle migration Durable Object
  (`v2`) et un nouveau nom de classe si nécessaire, avec lecture de l'ancien état avant effacement.
- **Ne jamais supprimer les données de `plan:<uid>`** : elles représentent des accès payés ou accordés.
- **Sauvegarder** les clés `plan:<uid>` (export JSON) avant toute opération sur le namespace `STATE`.
- **Changement de mois** : la remise à zéro est automatique et voulue (voir `docs/quotas-politique.md`).

## 4. Procédure de sauvegarde avant opération sur KV

1. Lister les clés `plan:` (tableau de bord ou API) et les enregistrer dans un fichier daté, hors dépôt.
2. Vérifier le nombre d'enregistrements.
3. Effectuer l'opération.
4. Comparer le nombre d'enregistrements après opération.

## 5. Points à décider

1. Accepter qu'aucune migration ne soit nécessaire (conclusion de la section 1).
2. Décider du sort de `salledegarde-rate` : conservé indéfiniment, ou supprimé après la mise en production de la
   nouvelle version et une fois sa vacuité confirmée.
3. Confirmer que la liaison `RATE` est retirée de la configuration réelle lors du déploiement.
