# Politique des quotas (valeurs techniques provisoires)

Statut : **valeurs provisoires, non validées commercialement.** Aucune valeur n'a été modifiée dans cette étape.

## 1. Valeurs actuelles

| Paramètre | Valeur | Où il est défini | Modifiable par |
|---|---|---|---|
| Cas distincts par mois, compte gratuit | **5** | `FREE_CONSULTATIONS_PER_MONTH` dans `worker/patient-worker.js` | Code |
| Cas distincts par mois, compte Premium | **60** | `PREMIUM_CONSULTATIONS_PER_MONTH` dans `worker/patient-worker.js` | Code |
| Messages IA par cas et par mois | **40** | variable `MAX_MESSAGES_PER_CASE` (défaut 40) | Configuration |
| Requêtes IA par minute, par utilisateur | **20** | variable `USER_REQUESTS_PER_MINUTE` | Configuration |
| Requêtes par minute, par adresse IP | **20** | variable `IP_REQUESTS_PER_MINUTE` | Configuration |

## 2. Ce qu'est une « consultation » pour le serveur

Le serveur ne reçoit pas de notion de consultation. Il compte :
- un **cas distinct** : un identifiant de cas (parmi les 302 autorisés) utilisé au moins une fois dans le mois ;
- des **messages IA** : chaque demande de réponse du patient pour un cas donné.

Un cas est consommé dès son premier message réussi. Les messages suivants du même cas, dans le même mois, ne
consomment pas de nouveau cas, mais ils comptent dans le plafond de 40.

## 3. Mois de décompte

- Le mois est calculé en **UTC**. Le changement de mois a lieu à **01 h 00 heure de Kinshasa** le 1er du mois.
- Au changement de mois, les compteurs du mois précédent sont effacés. Les données ne sont pas conservées pour l'historique.

## 4. Séquence d'une demande

1. Limite de débit par IP.
2. Vérification du jeton Firebase et de l'email.
3. Lecture de la formule (`plan:<uid>` dans KV, lecture seule).
4. **Réservation atomique** : débit utilisateur, quota de cas, plafond de messages.
5. Appel à l'IA.
6. En cas d'échec de l'IA ou de réponse vide : **libération** de la réservation.

Un refus (402, 429) n'entame aucun quota de cas ni de message. Il consomme seulement le jeton de débit par minute.

## 5. Formule Premium

- Lue dans KV à chaque requête. Enregistrement attendu : `{"plan":"premium","until":"AAAA-MM-JJTHH:MM:SSZ"}`.
- Un enregistrement dont la date de fin est dépassée revient automatiquement à la formule gratuite.
- Une modification peut mettre environ une minute à être prise en compte (cohérence finale de KV).
- Aucun paiement ni webhook n'existe à ce stade : l'accès s'accorde à la main (voir `worker/README.md`).

## 6. Ce que le moteur local fait après un refus

Quand le Worker refuse (402, 429, 401, 503), le navigateur **continue la consultation avec le moteur local**,
sans IA et sans aucun quota. Les quotas limitent donc uniquement l'IA, pas la simulation.

## 7. Limites connues

1. **Adresse IP partagée (critique pour un usage universitaire)** : plusieurs étudiants derrière la même connexion
   (campus, cybercafé, opérateur mobile avec NAT) partagent la même adresse. Avec 20 requêtes par minute par IP,
   une promotion entière peut être bloquée. Cette limite doit être revue avant un lancement réel.
2. **Comptes multiples** : un étudiant peut créer plusieurs comptes et multiplier les 5 cas gratuits.
3. **Pas de mesure de coût** : le coût réel par message n'est pas mesuré. Les valeurs 5, 60 et 40 ne sont pas
   justifiées par un coût.
4. **Premium sans paiement** : 60 cas sont accordés à la main. Aucun contrôle de paiement.
5. **Contenu non protégé** : tant que C1 n'est pas traité, le diagnostic des cas est lisible dans le navigateur.
   Les quotas ne protègent pas le contenu.
6. **Garanties de concurrence** : prouvées par simulation seulement. Voir `docs/durable-objects-plan-tests.md`.
7. **Réservations perdues** : si le Worker est interrompu entre la réservation et la libération (par exemple
   dépassement de temps d'exécution), la réservation n'est pas libérée. Le coût pour l'utilisateur est au plus un
   message du mois.
8. **Premier déploiement** : les quotas repartent à zéro (voir `docs/migration-compteurs.md`).

## 8. Décisions à valider avant lancement

1. Confirmer 5 cas gratuits et 60 cas Premium.
2. Confirmer 40 messages par cas et par mois (et non par consultation identifiée par le client).
3. Revoir la limite par IP pour les réseaux partagés (valeur ou exemption).
4. Décider si les réservations doivent être libérées par un mécanisme de nettoyage (expiration) plutôt que seulement
   par l'appel de libération.
5. Mesurer le coût réel d'un message avant de fixer une éventuelle offre payante.
