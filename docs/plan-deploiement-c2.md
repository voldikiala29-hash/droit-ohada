# Plan de mise en production de C2 (sans interruption inutile de l'IA)

Statut : **plan.** Rien n'est déployé. Chaque étape indique si elle nécessite ton autorisation ou une action dans le
tableau de bord.

## 0. Constat qui conditionne tout le plan

- Le Worker en production (`muddy-shadow-c8d5`) est la version d'origine, **sans authentification**.
- Le client sur `main` n'envoie aucun jeton.
- Le namespace KV `STATE` n'existe pas. Le seul namespace est `salledegarde-rate`.

Un déploiement brutal de la nouvelle version provoque une coupure : soit le client actuel n'envoie pas de jeton et
reçoit 401, soit le client mis à jour envoie `Authorization`, que l'ancien Worker refuse en CORS. Dans les deux cas,
l'IA disparaît pour tous et le moteur local prend le relais.

**Solution proposée** : une phase de transition où le Worker accepte encore les requêtes anonymes, avec une limite stricte.

## 1. Vue d'ensemble

```
Phase A  Préparation (aucun impact)          -> ressources de préproduction, tests
Phase B  Worker en mode transitoire         -> le Worker accepte les anonymes (30/min par IP)
Phase C  Client mis à jour                  -> les connectés envoient leur jeton
Phase D  Mode strict                        -> les anonymes sont refusés (401)
Phase E  Nettoyage                          -> retrait de RATE, documentation finale
```

Aucune phase n'interrompt l'IA pour les utilisateurs existants.

## 2. Phase A : préparation (préproduction uniquement)

| Action | Qui | Autorisation requise |
|---|---|---|
| Créer un Worker de préproduction `muddy-shadow-c8d5-preprod` | Toi, dans le tableau de bord, ou moi via `wrangler` | **Oui** |
| Créer un namespace KV `STATE-preprod` | Toi | **Oui** |
| Activer les Durable Objects sur le compte (vérifier l'offre) | Toi | **Oui** |
| Créer deux comptes Firebase de test, email vérifié | Toi, dans la console Firebase | **Oui** |
| Exécuter les tests de `docs/durable-objects-plan-tests.md` | Moi, après les actions ci-dessus | Oui (pour chaque déploiement de préproduction) |

## 3. Phase B : Worker en mode transitoire (production)

**Objectif** : déployer le nouveau Worker sans casser les usages actuels.

**Modification de code nécessaire (non faite)** : une variable `AUTH_MODE` avec deux valeurs.
- `optional` (transition) : les requêtes sans jeton sont acceptées, limitées à 30 par minute par IP, sans quota.
  Les requêtes avec jeton valide suivent le quota normal.
- `required` (strict) : les requêtes sans jeton valide sont refusées (401).

Le Worker doit aussi autoriser `Authorization` dans les en-têtes CORS (déjà le cas dans la nouvelle version).

**Étapes**
1. Créer le namespace KV `STATE` de production (nouvel identifiant). **Autorisation requise.**
2. Exporter la configuration actuelle du Worker dans le tableau de bord (liaisons, variables). **Important** : `wrangler deploy`
   remplace ces réglages.
3. Reporter dans `wrangler.toml` : la liaison `AI`, la liaison `STATE` (nouvel identifiant), la liaison `QUOTA`
   (Durable Object), la migration `v1`, les variables. **Retirer la liaison `RATE`** seulement à la phase E.
4. `npx wrangler deploy --dry-run` : vérifier que la configuration est complète.
5. `npm test` et `npm run check:case-ids` doivent passer.
6. **Autorisation requise** pour le déploiement. Déployer le Worker en mode `optional`.
7. Vérifier : une requête anonyme passe toujours (IA répond) ; une requête avec jeton invalide renvoie 401.

**Résultat attendu** : aucune interruption. Les utilisateurs existants ne voient aucune différence.

## 4. Phase C : client mis à jour

1. Fusionner la Pull Request (**autorisation requise**, après revue).
2. GitHub Pages republie le site. Le délai est de quelques minutes ; les navigateurs peuvent garder une version en
   cache plusieurs minutes de plus.
3. Les utilisateurs connectés envoient désormais leur jeton. Les anonymes continuent via le mode `optional`.

**Vérification** : une consultation connectée consomme un cas (quota visible) ; une consultation anonyme ne consomme rien.

## 5. Phase D : mode strict

1. Attendre une période d'observation (proposition : 7 jours) pendant laquelle on surveille les journaux d'anonymes.
2. Passer `AUTH_MODE` à `required` (**autorisation requise**, modification de variable).
3. Vérifier : une requête anonyme renvoie 401 ; le navigateur bascule sur le moteur local sans erreur visible.

**Décision à prendre** : durée de la période d'observation et seuil acceptable d'anonymes restants.

## 6. Phase E : nettoyage

1. Retirer `RATE` de la configuration (**autorisation requise**).
2. Ne **pas** supprimer le namespace `salledegarde-rate` (aucune suppression autorisée à ce stade).
3. Mettre à jour `worker/README.md` avec la configuration réelle (sans les identifiants secrets).

## 7. Configuration des variables d'environnement

| Variable | Phase B | Phase D | Remarque |
|---|---|---|---|
| `ALLOWED_ORIGIN` | `https://salledegarde.online` | idem | Inchangé |
| `FIREBASE_PROJECT_ID` | `salledegarde-89dae` | idem | Inchangé |
| `AUTH_MODE` | `optional` | `required` | Nouvelle variable (à coder) |
| `MAX_MESSAGES_PER_CASE` | `40` | `40` | Provisoire |
| `USER_REQUESTS_PER_MINUTE` | `20` | `20` | Provisoire |
| `ANON_IP_REQUESTS_PER_MINUTE` | `30` | `30` | Nouvelle (voir `docs/limite-ip-universites.md`) |
| `AUTH_IP_REQUESTS_PER_MINUTE` | `300` | `300` | Nouvelle (à valider) |
| `IP_REQUESTS_PER_MINUTE` | retirée | retirée | Remplacée par les deux variables ci-dessus |

Les variables sont déclarées dans `wrangler.toml` (valeurs non secrètes). Aucun secret n'est nécessaire pour ce Worker.

## 8. Namespace KV existant

- `salledegarde-rate` : utilisé par l'ancienne version pour des clés de débit éphémères (120 secondes). Aucune donnée
  utilisateur.
- `STATE` (à créer) : plans Premium uniquement. Les enregistrements `plan:<uid>` seront saisis à la main après la
  phase C, pour les comptes concernés.
- **Règle** : ne supprimer aucun namespace sans sauvegarde préalable et autorisation écrite.

## 9. Tests avec de vrais comptes Firebase

Préparer trois comptes de test (email vérifié) : `test-gratuit-1`, `test-gratuit-2`, `test-premium`.

| Test | Attendu |
|---|---|
| Connexion email, consultation, 5 cas distincts | Les 5 réussissent ; le 6e est refusé (402) |
| 40 messages sur un même cas | Les 40 réussissent ; le 41e est refusé (402) |
| Compte `test-premium` avec `plan:<uid>` valide | Le 6e cas réussit |
| Connexion Google | Même comportement qu'avec un email |
| Email non vérifié | Refusé (403) ; moteur local |
| Déconnexion puis consultation | Moteur local, aucun quota consommé |
| Jeton expiré (attendre ou forcer) | Rafraîchi par le client, ou moteur local |

## 10. Tests Android et ordinateur

| Appareil | Navigateur | Scénarios |
|---|---|---|
| Android | Chrome (version récente) | Connexion, consultation IA, quota atteint, réseau 3G ou faible, mode hors ligne |
| Ordinateur | Chrome, Firefox | Idem, plus le mode d'installation PWA |
| iPhone (si disponible) | Safari | Connexion et consultation (non prioritaire) |

Pour chaque scénario : l'IA répond, ou le moteur local prend le relais sans message d'erreur visible.
Vérifier aussi que la progression et les badges sont inchangés.

## 11. Vérification des quotas en production

- Après la phase C : consulter le compte de test gratuit, vérifier le compte consommé (`quota.used` dans la réponse).
- Surveiller les journaux du Worker pendant 48 heures : nombre de 402, 429, 401.
- Comparer le nombre de réponses 200 avec les appels Workers AI : ils doivent être égaux.
- Vérifier la liste des identifiants de cas refusés (400) : ce doit être vide pour les usages normaux.

## 12. Procédure de retour arrière

| Niveau | Action | Effet | Autorisation |
|---|---|---|---|
| 1 | Repasser `AUTH_MODE` à `optional` | Les anonymes sont de nouveau acceptés | Oui |
| 2 | Revenir à la version précédente du Worker (`npx wrangler rollback`) | Retour à la version d'origine ; les compteurs du Durable Object sont conservés | Oui |
| 3 | Revert du commit de client sur `main` | Le site redevient celui d'avant ; le moteur local reste disponible | Oui, et revue |

**Ne jamais** : supprimer le Durable Object, retirer la migration `v1`, supprimer `STATE`, supprimer `salledegarde-rate`.

Après chaque retour arrière, vérifier : une consultation anonyme et une consultation connectée fonctionnent.

## 13. Opérations nécessitant ton autorisation ou ton intervention

| # | Opération | Où | Intervention |
|---|---|---|---|
| 1 | Créer le Worker de préproduction | Cloudflare | Toi ou autorisation |
| 2 | Créer les namespaces KV `STATE-preprod` et `STATE` | Cloudflare | Toi ou autorisation |
| 3 | Activer / vérifier les Durable Objects | Cloudflare | Toi (vérifier l'offre) |
| 4 | Créer les comptes Firebase de test | Console Firebase | Toi |
| 5 | Exporter la configuration actuelle du Worker | Cloudflare | Toi |
| 6 | Déployer en préproduction | Cloudflare | Autorisation |
| 7 | Déployer le Worker en production (phase B) | Cloudflare | Autorisation |
| 8 | Fusionner la PR (phase C) | GitHub | Autorisation |
| 9 | Passer `AUTH_MODE` à `required` (phase D) | Cloudflare | Autorisation |
| 10 | Retirer `RATE` (phase E) | Cloudflare | Autorisation |
| 11 | Règle de limitation IP dans Cloudflare | Cloudflare | Toi |
| 12 | App Check / Turnstile | Firebase / Cloudflare | Décision + autorisation |

## 14. Critères de passage entre phases

- **A → B** : tous les tests de préproduction passent ; plan validé.
- **B → C** : Worker en production en mode `optional` stable pendant au moins 24 heures.
- **C → D** : tests Android et ordinateur validés ; quotas vérifiés ; aucune hausse anormale de 401 ou 429.
- **D → E** : période d'observation terminée ; aucun usage anonyme légitime identifié.
