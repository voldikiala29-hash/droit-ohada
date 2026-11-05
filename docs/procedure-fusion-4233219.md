# Procédure de fusion du correctif `?debug=1` (commit 4233219)

Statut : **procédure préparée. Aucune fusion n'a été faite.** La fusion ne se fait qu'après autorisation explicite.

## 1. Ce que fait le correctif

Branche `fix/debug-hook-main`, commit `4233219`, fondé sur `origin/main` (dd5412a). Diff vérifié :

```
index.html | 5 +----   (1 insertion, 4 suppressions)
- var LLM_URL=window.SDG_LLM_URL||WORKER_URL;   →   var LLM_URL=WORKER_URL;
- /* Point d'accès de test … */ et la ligne if(/[?&]debug=1/…) window._sdgDbg = …   (supprimées)
- commentaire orphelin « Point d'accès de test : uniquement si… » (supprimé)
```

Effet : supprime le point d'accès `window._sdgDbg` (accessible avec `?debug=1`) et la surcharge `SDG_LLM_URL`.
Aucune autre ligne ne change. Les fonctionnalités du simulateur ne sont pas touchées.

## 2. Pourquoi c'est une mise en production immédiate

Vérifié par lecture seule (GitHub) :

- Le seul workflow de déploiement est `pages-build-deployment` (GitHub Pages, source : branche `main`).
- Chaque poussée sur `main` déclenche un déploiement sur **salledegarde.online**. Constaté sur les 50 derniers déploiements, tous issus de `main`.
- `main` n'a **aucune protection de branche** et aucun ruleset.

Conséquence : fusionner `4233219` dans `main` publie le correctif en production dès le déploiement Pages.

## 3. Contrôles avant fusion (à refaire juste avant, pas à partir de ce document)

| Contrôle | Attendu | Commande ou lieu |
|---|---|---|
| Tête de `main` | `dd5412a` | `git rev-parse --short origin/main` |
| Tête du correctif | `4233219` | `git rev-parse --short origin/fix/debug-hook-main` |
| Diff | 1 insertion, 4 suppressions, `index.html` seul | `git diff --stat origin/main origin/fix/debug-hook-main` |
| Syntaxe des scripts | compile | test `client-static` (tests 1, 2, 4 passent ; tests 3 et 5 échouent car ils attendent des fonctions de la branche de sécurité, attendu) |
| Workflows | seul `pages-build-deployment` | `gh api repos/<dépôt>/actions/workflows` |
| Protection de `main` | aucune (signalée, non bloquante) | `gh api repos/<dépôt>/branches/main/protection` (404 attendu) |
| Source Pages | `main` | interface GitHub, Settings › Pages (l'API `/pages` renvoie 403 depuis l'environnement d'agent : à vérifier à la main) |

**Décision à prendre avant fusion** : le correctif touche la même ligne `LLM_URL` que la branche de sécurité. Fusionner
le correctif dans `main` avant la branche de sécurité évite un conflit ; la branche de sécurité devra ensuite être rebasée
sur `main`.

## 4. Étapes de fusion (une fois autorisée)

1. Vérifier les contrôles de la section 3 : têtes inchangées.
2. Fusionner `fix/debug-hook-main` dans `main` **sans modifier le commit** (fusion rapide ou fusion sans réécriture ; pas de
   force-push).
3. Attendre la fin du déploiement Pages (onglet Actions, workflow `pages-build-deployment`).
4. Vérifier la production (section 5).
5. Ne pas toucher à `securite/phase-1-cases-worker-scores` pendant cette opération.

## 5. Vérifications après déploiement

- `curl -s https://salledegarde.online/ | grep -c "_sdgDbg"` → **0**.
- Ouvrir `https://salledegarde.online/?debug=1` dans un navigateur : `window._sdgDbg` doit être `undefined`.
- Le simulateur répond toujours (parcours patient en mode local).
- Le Worker de production reste inchangé : ce correctif ne le touche pas.

## 6. Retour arrière

Créer un commit de revert sur `main` (`git revert -m 1 <fusion>` ou `git revert 4233219`). **Le revert redéploie aussi
Pages**, donc il faut le considérer comme une seconde mise en production, avec les mêmes vérifications.
Ne jamais réécrire `main` (pas de `--force`).

## 7. Limite

Le Worker de production (`muddy-shadow-c8d5`) reste sans authentification tant que la branche de sécurité n'est pas
fusionnée et déployée. Ce correctif ne règle que le point d'accès de débogage côté navigateur.
