# Préparation de D1 : schéma, migration, sauvegarde, coûts et cohérence

Statut : **préparation uniquement.** Aucune base D1 n'est créée, aucune migration n'est exécutée, aucune ressource
Cloudflare n'est touchée, rien n'est déployé. Le schéma ci-dessous est un **brouillon à valider**. Autorisation de création :
décision D-P4-ter, toujours en attente.

Documents liés : `docs/decisions-phase-1.md` (§4, architecture D1 et Durable Objects), `docs/revue-c2-sous-etape-1-2.md`,
`docs/plan-correction-1-4.md`.

---

## 1. Rôles retenus (rappel de D-P4)

- **D1** : source de vérité des abonnements, droits, historiques commerciaux et journal des consultations comptées.
- **Durable Objects** : réservations atomiques des quotas (consultations et messages), limites de débit.
- **KV** : `plan:<uid>`, actuellement source des formules. Gardé en lecture seule pendant la migration, puis conservé.
- **R2** (proposition, à décider) : contenu des transcripts, séparé des données commerciales.

Règle : **D1 décide la formule, les Durable Objects appliquent les compteurs.** Une consultation n'est comptée qu'une
fois, et cette comptabilisation est enregistrée dans D1.

---

## 2. Schéma définitif proposé (brouillon SQL, non exécuté)

Toutes les dates sont en UTC, au format ISO 8601 (`TEXT`). Les montants sont en unité mineure (`INTEGER`).

```sql
-- Identité minimale. Aucun nom, téléphone ni donnée de santé.
CREATE TABLE users (
  uid            TEXT PRIMARY KEY,               -- uid Firebase
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  created_at     TEXT NOT NULL
);

-- Abonnements. Une ligne par abonnement ou période.
CREATE TABLE subscriptions (
  id           TEXT PRIMARY KEY,                 -- identifiant interne
  uid          TEXT NOT NULL REFERENCES users(uid),
  plan         TEXT NOT NULL CHECK (plan IN ('premium', 'simulateur_premium', 'jeux_premium', 'bundle')),
  status       TEXT NOT NULL CHECK (status IN ('active', 'cancel_pending', 'expired', 'suspended')),
  origin       TEXT NOT NULL CHECK (origin IN ('manual', 'apple', 'google', 'web')),
  provider_ref TEXT UNIQUE,                      -- identifiant côté fournisseur
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,                    -- fin de la période payée (downgrade effectif ici)
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX subscriptions_uid_status ON subscriptions (uid, status);

-- Paiements. Idempotence : un même événement fournisseur ne peut être inséré qu'une fois.
CREATE TABLE purchases (
  id             TEXT PRIMARY KEY,
  uid            TEXT NOT NULL REFERENCES users(uid),
  subscription_id TEXT REFERENCES subscriptions(id),
  provider       TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'web_mobile_money', 'web_card', 'manual')),
  provider_tx_id TEXT NOT NULL UNIQUE,
  product        TEXT NOT NULL,
  amount_minor   INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency       TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('paid', 'refunded', 'failed', 'pending')),
  created_at     TEXT NOT NULL
);

-- Journal append-only des événements commerciaux (renouvellement, annulation, remboursement, changement).
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uid         TEXT NOT NULL REFERENCES users(uid),
  kind        TEXT NOT NULL,
  ref         TEXT NOT NULL,                     -- identifiant fournisseur ou interne
  payload_sha256 TEXT,                           -- empreinte du message reçu, pas le message
  occurred_at TEXT NOT NULL,                     -- date fournie par le fournisseur
  recorded_at TEXT NOT NULL,                     -- date d'insertion
  UNIQUE (kind, ref)
);
-- Append-only : toute modification ou suppression est refusée.
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events est en ajout seul'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events est en ajout seul'); END;

-- Droits actuels, dérivés des abonnements. Recalculés à chaque événement.
CREATE TABLE entitlements (
  uid         TEXT PRIMARY KEY REFERENCES users(uid),
  plan        TEXT NOT NULL,
  valid_until TEXT,                              -- NULL pour la formule gratuite
  version     INTEGER NOT NULL,                  -- incrémenté à chaque changement (pour le snapshot)
  updated_at  TEXT NOT NULL
);

-- Consultations comptées (une ligne par consultation démarrée et confirmée côté serveur).
CREATE TABLE attempts (
  id            TEXT PRIMARY KEY,                -- sessionId émis par le serveur
  uid           TEXT NOT NULL REFERENCES users(uid),
  case_id       TEXT NOT NULL,                   -- identifiant parmi les 302
  month         TEXT NOT NULL,                   -- AAAA-MM UTC, mois de comptage
  reservation_id TEXT NOT NULL UNIQUE,           -- identifiant de la réservation dans le Durable Object
  status        TEXT NOT NULL CHECK (status IN ('open', 'closed', 'abandoned')),
  started_at    TEXT NOT NULL,
  closed_at     TEXT,
  score         INTEGER CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  scored_at     TEXT,
  transcript_ref TEXT                            -- clé de l'objet R2 (si R2 retenu)
);
CREATE INDEX attempts_uid_month ON attempts (uid, month);
CREATE UNIQUE INDEX attempts_uid_case_month ON attempts (uid, case_id, month);

-- Requêtes rejouées : réponse mise en cache pour éviter une double consommation (F2).
CREATE TABLE idempotency (
  request_id  TEXT PRIMARY KEY,                  -- généré par le navigateur, unique par message
  uid         TEXT NOT NULL REFERENCES users(uid),
  attempt_id  TEXT REFERENCES attempts(id),
  response_json TEXT,                            -- réponse renvoyée, rejouable
  created_at  TEXT NOT NULL
);
```

### 2.1 Relations

- `users` 1—N `subscriptions`, `purchases`, `events`, `attempts`.
- `subscriptions` 1—N `purchases` (un paiement peut renouveler un abonnement).
- `entitlements` 1—1 `users` (vue de travail, recalculée).
- `attempts` 1—N `idempotency` (une consultation peut recevoir plusieurs requêtes rejouées).

### 2.2 Ce qui n'est pas dans D1

- **Contenu des messages** : volume trop élevé pour D1 (voir §5). Proposition : R2, clé `transcript_ref`.
- **Compteurs de quota** : restent dans les Durable Objects. D1 garde la trace durable (`attempts`), pas le compteur temps réel.
- **Corrigés et grilles** : restent sur le Worker (D-P1 α).

---

## 3. Cohérence entre D1 et les Durable Objects

### 3.1 Problème

D1 et les Durable Objects ne partagent pas de transaction. Une réservation touche les deux.

### 3.2 Protocole proposé (saga avec compensation)

1. **Réserver** dans le Durable Object : `reservation_id` créé, compteur incrémenté, état `pending` avec expiration (60 s).
2. **Enregistrer** dans D1 : insertion de `attempts` avec `reservation_id` (contrainte unique).
3. **Confirmer** dans le Durable Object : `pending` → `confirmed`.
4. En cas d'échec de l'étape 2 : **libérer** la réservation dans le Durable Object (compensation).
5. Une réservation `pending` non confirmée après 60 s est **libérée automatiquement** par le Durable Object à la prochaine
   opération. Cela couvre l'interruption du Worker entre les étapes (correction F7).

### 3.3 Tests de cohérence (à écrire avant toute implémentation)

| Test | Vérifie |
|---|---|
| Une réservation confirmée a exactement une ligne `attempts` | Pas de consommation sans trace durable |
| Une ligne `attempts` a une réservation confirmée | Pas de trace sans consommation |
| Nombre de cas distincts du Durable Object pour un mois = nombre de lignes `attempts` (`counted`) du mois | Compteurs identiques |
| Échec de l'insertion D1 : la réservation est libérée | Compensation |
| Interruption après réservation : libération après 60 s | Expiration (F7) |
| Requête rejouée (même `request_id`) : aucune nouvelle réservation, réponse identique | Idempotence (F2) |
| Deux insertions simultanées pour le même uid, cas et mois | Contrainte unique, une seule consultation |
| Changement de mois pendant une réservation | Rattachement au mois de la réservation, pas à l'horloge de la requête (F6) |

### 3.4 Réconciliation

- Tâche planifiée quotidienne : compare les compteurs des Durable Objects avec D1 pour le mois en cours. Écarts journalisés,
  jamais corrigés automatiquement sans relecture.
- Reconstruction : si un Durable Object est perdu, ses compteurs se reconstruisent depuis `attempts` (source durable).

---

## 4. Migration depuis KV

### 4.1 Données à migrer

| Source | Cible | Règle |
|---|---|---|
| `plan:<uid>` dans KV (`{"plan":"premium","until":"…"}`) | `subscriptions` (origine `manual`) + `entitlements` | Une ligne par uid. `until` → `period_end`. |
| Rien d'autre aujourd'hui | — | Les compteurs sont dans les Durable Objects, pas dans KV. |

### 4.2 Étapes

1. **Inventaire** : liste des clés `plan:*` dans KV (lecture seule), comptage, contrôle des formats invalides.
2. **Import à blanc** (dry-run) : rapport des lignes qui seraient créées, des formats invalides et des dates passées.
3. **Import réel** dans une base D1 de test (après autorisation), idempotent : ré-exécuter ne crée pas de doublon (clé `uid`).
4. **Comparaison** : pour chaque uid, formule lue dans KV et formule lue dans D1 doivent concorder. Écarts listés.
5. **Bascule** : indicateur `ENTITLEMENTS_SOURCE=kv|d1`, passé à `d1` seulement quand les écarts sont nuls.
6. **Période de surveillance** : au moins 30 jours avec KV en lecture seule.
7. **Retour arrière** : repasser `ENTITLEMENTS_SOURCE=kv`. Aucune donnée n'est supprimée.
8. **Fin** : KV conservé. Suppression éventuelle uniquement sur accord écrit, après sauvegarde.

### 4.3 Règles

- Aucune écriture dans KV pendant la migration.
- Aucune suppression de données, ni dans KV ni dans D1, sans accord écrit.
- Chaque étape a un journal (date, nombre de lignes, écarts).

---

## 5. Coûts prévisionnels

### 5.1 Tarifs (page officielle D1, mise à jour le 30 octobre 2026)

| Élément | Formule Free | Formule Paid, inclus par mois | Dépassement |
|---|---|---|---|
| Lignes lues | 5 millions par jour | 25 milliards | 0,001 USD par million |
| Lignes écrites | 100 000 par jour | 50 millions | 1,00 USD par million |
| Stockage | 5 Go au total | 5 Go | 0,75 USD par Go-mois |

Taille maximale d'une base : non indiquée sur la page tarifaire ; à vérifier sur la page des limites.
Le coût fixe de la formule Workers Paid n'est pas détaillé sur cette page : **à vérifier** avant souscription.

### 5.2 Hypothèses

- Une consultation : 1 ligne `attempts`, 1 à 3 lignes `idempotency`, 1 ligne d'événement en moyenne (écritures totales ≈ 5).
- Un transcript d'une consultation : environ 60 messages de 300 caractères, soit environ 18 Ko.
- Lectures D1 : une lecture de formule par démarrage de consultation (le snapshot des Durable Objects évite les autres).
- Trois consultations par utilisateur et par mois en moyenne.

### 5.3 Projection

| Utilisateurs actifs | Écritures D1 / mois | Lectures D1 / mois | Transcripts / mois (Go) | Stockage D1 si transcripts en D1, rétention 90 j |
|---|---|---|---|---|
| 1 000 | 15 000 | 3 000 | 0,05 | 0,15 Go, inclus |
| 10 000 | 150 000 | 30 000 | 0,54 | 1,6 Go, inclus |
| 100 000 | 1,5 million | 300 000 | 5,4 | 16 Go, environ 11 Go au-delà de l'inclus : environ 8 USD par mois |

Lecture : les écritures et lectures restent très en dessous des montants inclus de la formule payante. Le poste sensible
est le **stockage des transcripts**. D'où la proposition de les placer dans R2 (tarifs R2 **à vérifier**).

### 5.4 Points à vérifier avant décision

- Coût fixe de la formule payante Workers.
- Tarifs R2 pour les transcripts.
- Coût des Durable Objects après ajout du snapshot et de la réconciliation (lectures et écritures supplémentaires).
- Impact du mode « réservation en attente » sur le nombre de requêtes DO.

---

## 6. Sauvegarde et restauration

### 6.1 Ce que propose Cloudflare (page officielle, consultée le 5 novembre 2026)

- **Time Travel** : restauration à n'importe quelle minute des **30 derniers jours** sur la formule payante, **7 jours**
  sur la formule gratuite. Toujours activé, sans coût supplémentaire.
- Restauration par horodatage ou par signet (`bookmark`). La restauration **écrase la base en place**. Les requêtes en
  cours sont annulées. Une restauration peut elle-même être annulée (signet précédent).
- Un signet de plus de 30 jours ne peut plus servir de point de restauration.
- Au-delà de 30 jours : export vers R2 (à mettre en place, par exemple avec Workflows).
- Pas de clonage ni de fourche de base pour l'instant : un test de restauration se fait sur une base séparée, alimentée
  à partir d'un export.

### 6.2 Stratégie proposée

| Élément | Proposition |
|---|---|
| Point de restauration de D1 | Time Travel, 30 jours (formule payante) |
| Export quotidien | Export de `subscriptions`, `purchases`, `events` et `entitlements` vers R2, avec empreinte. Conservation 12 mois. |
| Export des transcripts | Déjà dans R2 (si retenu). Cycle de vie : suppression à 90 jours. |
| Durable Objects | **Non couverts par Time Travel.** Reconstruction depuis `attempts` (§3.4). |
| KV | Copie de lecture avant migration, puis conservation. |
| Test de restauration | Trimestriel : restauration d'un export sur une base séparée, comparaison de comptes et d'empreintes. |
| Objectif de perte (RPO) | Time Travel : à la minute près sur 30 jours. Export quotidien : 24 heures au pire. |
| Objectif de reprise (RTO) | À mesurer lors du premier test. Non estimé ici. |

### 6.3 Points de vigilance

- **Restaurer écrase** : toute restauration doit être décidée par une personne, avec signet noté et journal.
- **Les réservations en cours sont perdues** lors d'une restauration : les compteurs des Durable Objects ne reviennent pas
  en arrière avec D1. Après restauration, la réconciliation (§3.4) est obligatoire.
- **Données personnelles** : les exports et les transcripts contiennent des données personnelles. Accès restreint,
  chiffrement, durée de rétention à valider juridiquement.

---

## 7. Plan d'implémentation (après autorisation D-P4-ter)

1. Valider ce brouillon de schéma (§2) et la stratégie de transcripts (D1 ou R2).
2. Créer la base D1 **de test** (aucune base de production).
3. Écrire les tests de cohérence (§3.3) avant le code de réservation.
4. Implémenter la saga de réservation dans le Worker et le Durable Object, derrière un indicateur.
5. Importer `plan:*` (§4), à blanc puis réellement, sur la base de test.
6. Exécuter les tests de cohérence, la réconciliation et un test de restauration.
7. Ne rien déployer en production sans autorisation écrite.

---

## 8. Décisions à prendre

| Id | Question |
|---|---|
| **D1-A** | Transcripts : dans D1 ou dans R2 ? (proposition : R2) |
| **D1-B** | Rétention des transcripts : 90 jours (proposition) ou autre ? |
| **D1-C** | Export quotidien vers R2 : 12 mois de conservation, d'accord ? |
| **D1-D** | Test de restauration trimestriel : d'accord ? Qui le réalise ? |
| **D1-E** | Quand autorisez-vous la création d'une base D1 de test ? |
