# Architecture : simulateur, abonnements et espace Jeux médicaux

Statut : **proposition à valider**. Aucun code de jeu n'est écrit. Le simulateur, `main`, les paramètres Cloudflare
et Firebase ne sont pas modifiés par ce document.

Documents liés : `docs/quotas-politique.md` (politique et enforcement actuel), `docs/impact-financier-ia.md`
(coûts IA), `docs/limite-ip-universites.md` (protection par IP), `docs/plan-deploiement-c2.md`.

---

## 1. Décisions retenues

**Simulateur**

- 5 simulations gratuites par utilisateur et par mois, renouvelées au changement de mois, non reportées.
- **Toute simulation commencée compte**, y compris celle qui utilise le moteur local sans IA.
- Premium : 150 consultations IA par mois, accès complet au simulateur, accès à toutes les spécialités.
- Une consultation = un cas clinique distinct traité avec l'IA. Les messages suivants sur le même cas ne consomment
  pas de nouvelle consultation.
- Plafond de 40 messages par utilisateur, par cas et par mois, applicable aux deux offres.
- Le compteur est contrôlé côté serveur.

**Abonnements**

- Passage au Premium : effet immédiat.
- Retour à la formule gratuite (downgrade) : effet à la fin de la période payée.
- Les consultations déjà consommées restent comptées pendant le mois en cours.

**Espace Jeux**

- Espace indépendant, à l'adresse `/jeux/`.
- Premier jeu : le jeu des triades.
- Provisoirement : 20 parties gratuites par mois et par jeu, Premium donne accès aux jeux réservés et aux parties
  illimitées.
- Quotas des jeux indépendants de ceux du simulateur.

**Documents médicaux**

- Import PDF hors ligne, jamais accessible depuis le site public.
- Extraction des questions, réponses, explications et références de pages.
- Questions reformulées et vérifiées médicalement avant publication.
- Aucun contenu protégé publié sans autorisation appropriée.

---

## 2. État actuel (constats)

| Élément | Constat | Conséquence |
|---|---|---|
| `index.html` | 2 517 lignes : CSS, JavaScript et interface dans un seul fichier | Ajouter le simulateur de jeux dans ce fichier augmenterait le risque de régression. |
| `cases_202.js` | 302 cas chargés dans le navigateur, répartis en 11 services (`svc`) | Les droits Premium par spécialité ne peuvent pas être appliqués tant que C1 n'est pas traité. |
| Worker IA | Vérifie le jeton Firebase, applique les quotas dans un Durable Object (`QuotaLimiter`), appelle l'IA | Point de contrôle serveur déjà en place pour les consultations IA. |
| Plan Premium | Lu dans KV (`plan:<uid>`), accordé à la main, sans paiement ni webhook | Suffisant pour le lancement manuel, insuffisant pour des abonnements automatiques. |
| Moteur local | `patientReply` / `patientReplyRaw` dans `index.html`, règles par mots-clés et expressions régulières, exécuté dans le navigateur | Voir §4.3 : c'est le principal contournement actuel. |
| Firestore | Collections `progression`, `etats`, `medecins`, règles strictes par propriétaire | Une collection pour les jeux ou les scores demandera une règle nouvelle. |
| Scoring | Calculé dans le navigateur | Triche possible tant que C3 n'est pas fait. |

---

## 3. Architecture cible

```
            navigateur                                  Cloudflare (serveur)
 ┌──────────────────────────┐                ┌────────────────────────────────────┐
 │ index.html  (simulateur) │── start ──────▶│ Worker                             │
 │  moteur local (sans IA)  │◀─ jeton ───────│  ├─ vérification jeton Firebase    │
 │  moteur IA (via Worker)  │── message ────▶│  ├─ lecture formule (KV plan:<uid>)│
 ├──────────────────────────┤                │  ├─ Durable Object QuotaLimiter    │
 │ /jeux/ (espace Jeux)     │── partie ─────▶│  │    compteurs simulateur         │
 │  moteur commun           │                │  │    compteurs jeux (espace séparé)│
 │  modules par type de jeu │◀─ questions ───│  └─ IA (uniquement simulateur)     │
 └──────────────────────────┘                └────────────────────────────────────┘
                                                        │
 Hors ligne (vous seul)                                 ▼
 ┌──────────────────────────┐                ┌────────────────────────────────────┐
 │ import PDF → questions   │── relecture ──▶│ contenu/*.json versionné           │
 │ contrôles automatiques   │                │ validé par script avant publication│
 └──────────────────────────┘                └────────────────────────────────────┘
```

Principes :

1. **Le serveur décide, le navigateur affiche.** Toute permission (lancer une simulation, une partie, un message IA)
   passe par le Worker.
2. **Compteurs séparés.** Simulateur et jeux ont des clés distinctes dans le même Durable Object.
3. **Contenu statique pour les jeux, décidé plus tard pour les réponses.** Voir §7 et §8.

---

## 4. Simulateur : quotas et contrôle serveur

### 4.1 Définitions

- **Simulation commencée** : l'utilisateur envoie son premier message sur un cas. Ouvrir un cas sans écrire ne compte
  pas. *Interprétation de « commencée » à confirmer (D2).*
- **Consultation** : une simulation commencée, identifiée par son `cas.id`. Pour l'IA comme pour le moteur local, la
  consultation est comptée une fois par cas et par mois.
- **Message** : une question envoyée dans une consultation. Limite : 40 par cas et par mois.

### 4.2 Séquence serveur proposée

Nouvel endpoint `POST /simulation/start` avec `{ cas, mode: "ia" | "local" }` :

1. Vérification du jeton Firebase et de l'email vérifié.
2. Lecture de la formule (`plan:<uid>`).
3. Réservation atomique dans le Durable Object : une consultation pour `cas` ce mois-ci, si elle n'est pas déjà
   réservée.
4. Renvoi d'un **jeton de session signé** (durée limitée, lié à l'uid et au cas) et du compte restant.

Chaque message ensuite passe par `POST /simulation/message` avec le jeton de session :

- Mode IA : vérification du jeton, réservation d'un message (plafond 40), appel à l'IA, libération en cas d'échec.
- Mode local : vérification du jeton, réservation d'un message (plafond 40), **pas d'appel IA**. La réponse est
  calculée localement (§4.3).

Refus : 402 (quota de consultations épuisé), 429 (débit), 409 (plafond de messages atteint pour ce cas).

### 4.3 Moteur local : fonctionnement et risque

**Fonctionnement actuel.** `patientReplyRaw` cherche les mots-clés de la question dans les données du cas (règles
`hist` avec expressions régulières, synonymes, réponses types). Il n'appelle rien et fonctionne hors ligne.

**Le problème.** Aujourd'hui, `answerPatient` bascule sur le moteur local dès que le Worker répond autrement que
par un succès, y compris sur un refus de quota (402) ou de débit (429). Un utilisateur qui a épuisé ses 5 consultations
gratuites peut donc continuer sans limite. C'est un contournement direct de la règle que vous avez retenue.

**Ce que la décision impose :**

- Le moteur local ne doit démarrer qu'après un jeton de session accordé par le serveur (`/simulation/start`).
- Sur un refus serveur (402, 409, 429), le navigateur **n'utilise pas** le moteur local. Il affiche un message clair
  (quota atteint, date de renouvellement).
- Seul un échec réseau ou une indisponibilité du Worker (503, délai dépassé) peut laisser le moteur local répondre.

**Point de vigilance : le réseau hors ligne.** Si l'utilisateur est hors ligne, il ne peut pas obtenir de jeton. Deux
options à trancher (D5) :

- A. Pas de simulation sans connexion. Le contrôle est total, mais l'application est inutilisable hors ligne.
- B. Jeton de repli avec une consultation réservée à la prochaine connexion. Plus souple, mais une simulation hors
  ligne peut ne pas être comptée si l'utilisateur ne revient jamais se connecter.

**Limite technique : le contenu du cas est dans le navigateur.** Tant que C1 n'est pas traité, un utilisateur peut lire
les cas et contourner le moteur. Le contrôle serveur porte sur le nombre de consultations, pas sur la lecture des
cas. C'est la même limite que dans `docs/quotas-politique.md`.

### 4.4 Plafond de 40 messages : en mode local

Le moteur local ne passe pas par l'IA, mais il peut être appelé aussi souvent qu'on le veut. Pour que le plafond de 40
messages s'applique réellement, chaque message local doit passer par le serveur. L'appel est léger (pas d'IA, donc
pas de coût de modèle), mais il crée une dépendance réseau pour chaque message.

Options (D6) :

- A. Chaque message local est comptabilisé côté serveur. Plafond respecté, dépendance réseau à chaque message.
- B. Le plafond de 40 ne s'applique qu'au mode IA. Le mode local reste sans limite de messages, mais une consultation
  est toujours comptée.

Je recommande A, pour que la règle soit tenue sans exception.

### 4.5 Ce que le serveur sait et ne sait pas

| Information | Connue du serveur ? |
|---|---|
| Qu'une consultation a été lancée sur un cas | Oui, via `/simulation/start` |
| Nombre de messages IA | Oui |
| Nombre de messages locaux | Oui si l'option A de §4.4 est retenue |
| Contenu des messages | Non (ils ne sont pas stockés) |
| Lecture des cas sans simulation | Non (C1) |

---

## 5. Abonnements : cycle de vie

Formule lue dans KV : `{"plan":"premium","until":"AAAA-MM-JJTHH:MM:SSZ"}`. Une date dépassée revient à la formule
gratuite.

| Événement | Effet |
|---|---|
| Passage au Premium | Immédiat. La limite passe à 150 consultations dès la prochaine requête. Les consultations du mois restent comptées. |
| Downgrade (annulation, échec de paiement) | Effet à `until`. Jusqu'à cette date, les droits Premium restent actifs. |
| Fin de `until` | Formule gratuite. Si le mois en cours a déjà plus de 5 consultations, l'utilisateur est bloqué jusqu'au mois suivant. |
| Changement de mois UTC | Compteurs remis à zéro. |

**Risques de cette mécanique**

- **Décalage entre période payée et mois UTC.** Un abonnement qui commence le 20 se termine le 20 du mois suivant,
  alors que les compteurs changent le 1er. Un utilisateur peut donc consommer 150 consultations, puis passer au
  gratuit le 20 avec des compteurs déjà pleins. Proposition : compteurs ancrés sur la période d'abonnement pour les
  Premium (D3).
- **Cohérence de KV.** KV est éventuellement cohérent : une modification peut prendre environ une minute. L'effet
  « immédiat » n'est donc pas instantané. Pour des abonnements automatiques, il faudra une source fortement cohérente
  (Durable Object ou D1).
- **Aucun paiement ni webhook aujourd'hui.** Le passage Premium reste manuel. Le choix du fournisseur (Mobile Money,
  cartes) est à faire après vérification de la couverture réelle en RDC.

---

## 6. Espace Jeux

### 6.1 Structure

```
/jeux/
  index.html          catalogue et accueil de l'espace (chargé séparément)
  jeux.js             moteur commun : chargement, rendu, navigation, score
  catalogue.json      liste des jeux, accès, quotas
  types/
    triade.js         jeu des triades (QCM à 4 réponses)
    qcm.js            quiz médicaux (plus tard)
    vrai-faux.js      (plus tard)
    diagnostic.js     diagnostic différentiel (plus tard)
    chrono.js         défis chronométrés (plus tard)
  contenu/
    triades/*.json    questions validées
```

- Le simulateur `index.html` n'est pas modifié. `/jeux/` est sur la même origine : la session Firebase est partagée.
- Lien depuis l'accueil vers `/jeux/` : seul changement visible du simulateur.
- Chargement différé : les modules de jeu sont chargés seulement quand l'utilisateur ouvre un jeu.

### 6.2 Catalogue

```json
{ "id": "triades", "titre": "Jeu des triades", "type": "triade",
  "acces": "gratuit", "limite": { "gratuit": { "parMois": 20 } }, "actif": true }
```

Un jeu réservé : `"acces": "premium"`. Un jeu gratuit sans limite : `"limite": null`.

### 6.3 Quotas des jeux

- Compteur `jeu:<uid>:<jeuId>:<mois>` dans le même Durable Object, indépendant des compteurs `cas:` du simulateur.
- Une partie comptée au lancement. Une partie abandonnée reste comptée.
- Gratuit : 20 parties par mois et par jeu (provisoire).
- Premium : parties illimitées et accès aux jeux réservés.
- Renouvellement au changement de mois UTC, comme le simulateur.

### 6.4 Jeu des triades

- Trois signes cliniques présentés, quatre réponses proposées, une seule correcte.
- Correction pédagogique après réponse : bonne réponse, explication médicale, référence de page.
- Points attribués selon la réponse. Résultats enregistrés.
- Phase 1 : questions en fichiers statiques, scores enregistrés par le serveur (dépend de C3, voir §8).

### 6.5 Scores

- Collection Firestore `scores/{uid}` (ou écriture via le Worker). Une règle Firestore nouvelle est nécessaire. Je ne
  la publierai pas sans votre accord.
- Tant que C3 n'est pas fait, les scores sont indicatifs.

---

## 7. Documents médicaux : import PDF hors ligne

### 7.1 Pipeline

1. **Extraction** : `pdftotext` ou PyMuPDF. Pour les PDF scannés, OCR (Tesseract). Texte découpé par chapitre et par
   page, référence de page conservée.
2. **Génération** : chaque passage est envoyé à l'IA avec un schéma JSON strict (signes, quatre réponses, index de la
   bonne réponse, explication, page citée). Le modèle doit reformuler, pas recopier.
3. **Contrôles automatiques** (script) :
   - une seule bonne réponse ;
   - quatre réponses distinctes ;
   - aucun signe repris dans la bonne réponse ;
   - page citée existante ;
   - JSON valide ;
   - longueur des textes bornée.
   Les questions en échec sont rejetées avec la raison.
4. **Relecture médicale** : chaque question passe de `brouillon` à `valide` après votre relecture. Seules les questions
   `valide` sont publiées.
5. **Publication** : `contenu/*.json` versionné dans le dépôt, script de validation exécuté à chaque commit.

### 7.2 Format d'une question

```json
{ "id": "tri-0001",
  "source": { "livre": "Titre du livre", "page": 142 },
  "signes": ["Fièvre", "Ictère", "Douleur de l'hypochondre droit"],
  "reponses": ["Cholécystite aiguë", "Hépatite virale", "Pancréatite", "Abcès du foie"],
  "bonne": 0,
  "explication": "Texte reformulé.",
  "statut": "valide", "relu_par": "Dr …", "version": 1 }
```

### 7.3 Droits

- Seuls les PDF et livres sur lesquels vous détenez les droits sont traités.
- Les questions sont des reformulations originales. Aucun extrait recopié, aucun passage reproduit.
- La référence de source (livre et page) est conservée en interne. Son affichage public est à décider (D7).

### 7.4 Coût

Génération hors ligne : de l'ordre de quelques dollars par livre, à mesurer sur un premier livre. Le coût dépend du
nombre de passages et du taux de rejet.

---

## 8. Sécurité

| Menace | Mesure | Statut |
|---|---|---|
| Contournement du quota simulateur par le moteur local | Jeton de session serveur, suppression du repli sur refus (§4.3) | À implémenter |
| Contournement par création de comptes multiples | App Check, Turnstile, protection par IP | Hors périmètre immédiat |
| Lecture des cas et corrigés dans le navigateur | C1 : livraison serveur | Non traité |
| Lecture des bonnes réponses des triades | Contenu statique : visible. Pour les jeux Premium, correction côté serveur | Décision D8 |
| Score falsifié | C3 : scores côté serveur | Non traité |
| Quota de jeux contourné | Compteur serveur `jeu:` | À implémenter |
| Accès aux PDF sources | Pipeline hors ligne, rien n'est publié brut | Par conception |
| Erreur médicale publiée | Relecture obligatoire, statut `valide` | Par conception |
| Règles Firestore trop larges | Règle dédiée pour `scores/{uid}`, `hasOnly`, `size` | À écrire, à valider |
| Abus de l'endpoint de démarrage | Limite de débit par utilisateur et par IP (existante) | Existant |
| Clé de session falsifiée | Signature HMAC, expiration courte, lien uid et cas | À implémenter |

---

## 9. Dépendances

| Fonction | Dépend de | Pourquoi |
|---|---|---|
| Compteur des simulations gratuites (serveur) | Phase 1 / C2 (déjà en place côté Worker) | Le compteur existe déjà pour l'IA. |
| Interdiction du repli sur refus | Modification de `index.html` (`answerPatient`) | Nécessite votre accord. |
| Jeton de session `/simulation/start` | Nouvel endpoint Worker | Nécessite votre accord. |
| « Accès à toutes les spécialités » en Premium | C1 | Le serveur doit livrer les cas. |
| Scores fiables des jeux | C3 | Calcul côté serveur. |
| Paiements | Choix du fournisseur, vérification de la couverture RDC | Non commencé. |
| Compteurs ancrés sur la période d'abonnement | Source de plan fortement cohérente (DO ou D1) | Voir §5. |
| Règles Firestore des scores | Votre validation | Non publiée. |

---

## 10. Étapes de développement

Chaque étape est soumise à votre validation avant de démarrer. Aucune n'est commencée.

| Étape | Contenu | Critère de sortie | Dépend de |
|---|---|---|---|
| **A** | Décisions D1 à D8 | Décisions écrites | Vous |
| **B** | Endpoint `/simulation/start` et jeton de session dans le Worker, tests | Tests verts, pas de déploiement | A |
| **C** | Suppression du repli sur refus dans `index.html`, message de quota | Tests du navigateur | B |
| **D** | Compteurs `jeu:` et catalogue | Tests de concurrence | A |
| **E** | Pipeline PDF hors ligne, premier livre, relecture | Questions `valide` | Droits sur le livre |
| **F** | Maquette de `/jeux/` | Votre validation | A |
| **G** | Moteur commun et jeu des triades | 30 questions valides | D, E, F |
| **H** | Scores côté serveur (C3) | Tests de triche | G |
| **I** | C1 : livraison serveur des cas et corrigés | Tests de lecture | Votre demande |
| **J** | Paiements et abonnements automatiques | Décision du fournisseur | A, §5 |

Les étapes B à D et G touchent le Worker ou le navigateur. Elles ne seront ni déployées ni fusionnées sans votre accord
explicite.

---

## 11. Décisions à prendre

| Id | Question | Proposition |
|---|---|---|
| **D1** | En Premium, les simulations en moteur local comptent-elles dans les 150 consultations ? | Oui, pour uniformiser le compteur. Sinon, le mode local Premium est illimité. |
| **D2** | « Simulation commencée » : premier message envoyé, ou ouverture du cas ? | Premier message envoyé. |
| **D3** | Compteurs Premium ancrés sur le mois UTC ou sur la période d'abonnement ? | Période d'abonnement pour les Premium, à implémenter avec la source de plan (étape J). |
| **D4** | Downgrade : l'utilisateur garde-t-il ses consultations déjà faites ? | Oui, comme convenu. Les consultations restent comptées pour le mois. |
| **D5** | Simulation hors ligne : pas de simulation (A) ou jeton de repli (B) ? | A recommandé, pour que chaque simulation soit comptée. |
| **D6** | Plafond de 40 messages : aussi en mode local ? | Oui, option A de §4.4. |
| **D7** | Affichage public des références de page (livre, page) dans les jeux ? | Non par défaut. |
| **D8** | Correction des triades : statique (visible) ou côté serveur ? | Statique en phase 1, serveur pour les jeux Premium (étape I). |
| **D9** | Quota gratuit des jeux : 20 par mois et par jeu, est-ce définitif ? | Provisoire. |

---

## 12. Risques

1. **Contournement du simulateur via le moteur local** : le plus important. Résolu seulement quand l'étape C est faite.
2. **Lecture des cas dans le navigateur** : tant que C1 n'est pas fait, les droits par spécialité sont des promesses.
3. **Décalage période d'abonnement / mois UTC** (§5).
4. **Cohérence de KV** : effet Premium non instantané.
5. **Comptes multiples** et protection par IP pour les universités.
6. **Erreurs médicales** dans les questions générées : relecture obligatoire, mais la charge de relecture peut ralentir
   la publication.
7. **Droits d'auteur** sur les livres et PDF.
8. **Coût IA du Premium** au maximum d'usage : environ 3,25 USD par mois (voir `docs/impact-financier-ia.md`).
9. **Scores falsifiables** tant que C3 n'est pas fait.
10. **Taille de `index.html`** : chaque modification augmente le risque de régression. C'est la raison de l'espace séparé.

---

## 13. Hors périmètre de ce document

- Aucune modification du code du simulateur à ce stade.
- Aucune modification des quotas actuels (5 / 150 / 40 restent les valeurs codées).
- Aucun paramètre Cloudflare ou Firebase modifié.
- Aucune règle Firestore publiée.
- Aucun paiement intégré.
- Aucune question de jeu écrite ou publiée.
