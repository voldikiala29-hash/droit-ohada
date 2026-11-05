# Politique des quotas

Statut : **valeurs provisoires**, révisées le 4 novembre 2026, à valider avant lancement. Ne pas modifier sans validation.

## 1. Politique commerciale (révisée)

| Offre | Consultations IA | Bibliothèque des cas | Autres accès |
|---|---|---|---|
| **Gratuit** | **5** par mois | Accès limité | — |
| **Premium** | **150** par mois | Accès illimité aux cas disponibles | Tous les services médicaux ; corrections détaillées |

**Limite par cas** : **40** messages par utilisateur et par cas, par mois. Cette limite s'applique aux deux offres.

## 2. Ce que le serveur applique réellement

| Règle | Appliquée côté serveur | Où |
|---|---|---|
| 5 cas distincts par mois (gratuit) | **Oui** | `FREE_CONSULTATIONS_PER_MONTH` (Worker) |
| 150 cas distincts par mois (Premium) | **Oui**, si le plan Premium est valide | `PREMIUM_CONSULTATIONS_PER_MONTH` (Worker) |
| 40 messages par utilisateur et par cas et par mois | **Oui** | `MAX_MESSAGES_PER_CASE` (Worker, Durable Object) |
| Limite de débit par utilisateur (20 par minute) | **Oui** | Durable Object |
| Limite de débit par IP | **Oui**, en filet de sécurité (voir `docs/limite-ip-universites.md`) | Durable Object |
| Accès limité ou illimité à la bibliothèque | **Non** | Tous les 302 cas sont livrés au navigateur (C1 non traité) |
| Accès à tous les services médicaux | **Non** | Idem |
| Corrections détaillées réservées au Premium | **Non** | Les corrigés sont dans le navigateur (C1 non traité) |

**Conséquence** : seule la partie « consultations IA » de la politique est appliquée. La différence entre gratuit et
Premium sur la bibliothèque et les corrections **n'existe pas techniquement** tant que C1 n'est pas traité. Toute
communication qui promet ces différences est en avance sur le produit.

## 3. Définition retenue de « consultation »

Le serveur compte des **cas distincts** : un identifiant de cas (parmi les 302 autorisés) consommé une fois dans le mois.
Les messages suivants sur le même cas ne consomment pas de nouveau cas, mais comptent dans la limite de 40.

**À valider** : la politique dit « consultations IA ». Si le mot signifie « consultation d'un cas », la définition
actuelle convient. S'il signifie « message », la politique doit être réécrite (le coût change d'un ordre de grandeur,
voir `docs/impact-financier-ia.md`).

## 4. Mois de décompte

- Le mois est calculé en **UTC**. Le changement a lieu à **01 h 00 heure de Kinshasa** le 1er du mois.
- Les compteurs du mois précédent sont effacés au changement de mois.

## 5. Séquence d'une demande

1. Limite de débit par IP.
2. Vérification du jeton Firebase et de l'email.
3. Lecture de la formule (`plan:<uid>` dans KV, lecture seule).
4. **Réservation atomique** : débit utilisateur, quota de cas, plafond de messages.
5. Appel à l'IA.
6. En cas d'échec de l'IA ou de réponse vide : **libération** de la réservation.

Un refus (402, 409, 429) n'entame ni quota de cas ni plafond de messages.

## 6. Formule Premium

- Lue dans KV à chaque requête : `{"plan":"premium","until":"AAAA-MM-JJTHH:MM:SSZ"}`.
- Une date de fin dépassée revient automatiquement à la formule gratuite.
- Une modification peut prendre environ une minute (cohérence finale de KV).
- **Aucun paiement ni webhook n'existe.** L'accès s'accorde à la main.

## 7. Ce qui se passe au refus

Depuis la sous-étape 1.4a, le navigateur **ne répond plus jamais localement** à une question posée au patient IA. Un refus
(401, 402, 409, 413, 426, 429) retire la question du journal, la restitue dans la saisie et affiche le motif (quota atteint,
plafond de 40 messages, connexion requise, etc.). Une panne (5xx, délai, réseau) garde la question en attente et propose
« Réessayer », qui renvoie le même identifiant : la question n'est comptée qu'une fois. Hors ligne, le patient IA n'est pas
disponible ; le reste du simulateur fonctionne.
Conséquence pour l'étudiant : sans connexion ou sans quota, il n'y a plus de réponse de secours du patient.

## 8. Incohérences relevées

| Source | Problème | Action |
|---|---|---|
| `index.html` ligne ~638 : « Gratuit, illimité » | Contredit les 5 consultations gratuites | À corriger (frontend, à autoriser) |
| `index.html` ligne ~582 : « 0 $ gratuit pour les étudiants » | Vrai pour l'offre gratuite, mais ne mentionne pas les limites | À reformuler (frontend, à autoriser) |
| Message au médecin quand son quota est atteint | Absent avant 1.4a | **Fait (1.4a)** : message de refus affiché dans le chat |
| `conditions-utilisation.html` article 2 : « jusqu'à 50 nouveaux cas générés par IA par jour » | Aucune génération de cas n'existe dans le code ; pas de quota correspondant | Juridique : à valider ou retirer. Non modifié |
| Frontend : pas d'affichage du quota | L'utilisateur ne voit pas sa consommation | Fonctionnalité à prévoir (frontend, à autoriser) |
| Bibliothèque et corrections différenciées | Non appliquées | Dépend de C1 |

## 9. Limites restantes

1. **Adresse IP partagée** : une promotion derrière la même connexion peut être bloquée. Voir `docs/limite-ip-universites.md`.
2. **Comptes multiples** : un étudiant peut créer plusieurs comptes pour multiplier les 5 cas gratuits. Voir les protections proposées (App Check, Turnstile).
3. **Coût non borné par plan** : le Premium à 150 cas et 40 messages par cas peut coûter plus que son prix annuel effectif. Voir `docs/impact-financier-ia.md`.
4. **Moteur local sans quota** : après un refus, la simulation continue sans limite.
5. **Premium manuel** : pas de paiement ni de webhook.
6. **Contenu non protégé** : tant que C1 n'est pas traité, le diagnostic de chaque cas est lisible dans le navigateur.

## 10. Décisions à valider avant lancement

1. Définition de « consultation » : cas distinct (actuel) ou message.
2. Valeurs 5 / 150 / 40, à confirmer commercialement.
3. Plafond d'usage équitable pour le Premium, ou prix révisé (voir `docs/impact-financier-ia.md`).
4. Message affiché au médecin quand son quota est atteint.
5. Formulation des offres (bibliothèque, corrections) : ne pas promettre ce que C1 n'a pas encore livré.
6. Sort de la clause CGU « 50 cas générés par IA par jour ».
