# Architecture multiplateforme : site, Android, iOS

Statut : **audit et proposition, aucune implémentation.** Ce document ne modifie aucun fichier de code, ne crée aucun
service payant, ne touche ni `main`, ni Firebase, ni Cloudflare, et ne prend aucune décision irréversible.

Documents liés : `docs/architecture-espace-jeux.md` (simulateur, quotas, espace Jeux),
`docs/quotas-politique.md`, `docs/impact-financier-ia.md`, `docs/plan-deploiement-c2.md`.

---

## 1. Résumé

- **Un seul compte** : garder Firebase Authentication comme identité unique (uid). Le site et les apps l'utilisent
  déjà ou peuvent l'utiliser sans changement de fournisseur.
- **Une seule source de droits** : les droits (Premium, XP, bundle) doivent vivre côté serveur, pas dans Firestore
  écrit par le client, ni dans KV tel qu'il est aujourd'hui.
- **Application mobile = enveloppe autour de l'application web existante** (Capacitor recommandé), pour ne pas
  réécrire les 2 517 lignes de `index.html` ni les 302 cas. C'est la voie qui préserve le plus de code.
- **Paiements** : les achats faits *dans* l'application mobile doivent passer par les systèmes de paiement des stores
  (Google Play Billing, StoreKit). Le paiement sur le Web (Mobile Money, cartes) est possible, mais l'application ne
  doit pas inciter à payer ailleurs, sous peine de rejet. Les règles exactes doivent être vérifiées avant lancement
  (voir §5.4).
- **XP et classements** : XP calculés et stockés côté serveur dans un journal (ledger) en ajout seul. Les classements
  sont calculés côté serveur.
- **Migration progressive** en 7 phases. Le site actuel reste en service à chaque étape.

Recommandation principale : **Phase 0 (PWA installable, sans store) puis Capacitor**, avec la source de droits déplacée
côté serveur avant tout achat in-app.

---

## 2. Audit de l'existant

### 2.1 Branches et code

| Élément | Constat |
|---|---|
| Branches | `main` (production, `dd5412a`) et `securite/phase-1-cases-worker-scores` (travail en cours, 7 commits d'avance sur `main`). Aucune autre branche. |
| Projet mobile | Aucun (ni `android/`, ni `ios/`, ni Capacitor, Cordova, React Native ou Expo). |
| PWA | Présente : `manifest.webmanifest` (affichage `standalone`, icônes 192 et 512 px) et `sw.js` (minimal). L'application est donc déjà installable sur Android et iOS depuis le navigateur, sans store. |
| Interface | Un seul fichier `index.html` (2 517 lignes) : CSS, JavaScript, Firebase et interface. |
| Cas cliniques | `cases_202.js` (302 cas, chargés dans le navigateur). |
| Moteur local | `patientReply` / `patientReplyRaw`, sans serveur. |
| Worker IA | Authentification Firebase, quotas dans un Durable Object, appel IA (phase 1 / C2, sur la branche). |
| Firestore | `progression/{uid}`, `etats/{uid}`, `medecins/{uid}` ; règles strictes par propriétaire. |
| Publicité | `adsbygoogle` présent dans `index.html` (ligne ~531). |
| Paiement | Aucun. Le Premium est accordé à la main (KV). |
| Configuration Firebase | Clé Web publique dans `index.html`, projet `salledegarde-89dae`. |

### 2.2 Fonctionnalités à conserver

Toutes les fonctionnalités actuelles doivent rester intactes sur le site. Par défaut, rien n'est supprimé :

- Authentification Firebase (e-mail, Google) et profil médecin ;
- simulateur patient avec moteur local (secours hors ligne) et moteur IA via le Worker ;
- 302 cas cliniques, corrigés et scoring sur 100 ;
- historique et progression (`progression/{uid}`), badges et courbe ;
- sauvegarde de la consultation en cours (`etats/{uid}`) ;
- PWA installable ;
- pages légales (CGU, confidentialité, contact, à propos).

### 2.3 Points à corriger avant toute extension mobile

1. **Droits décidés côté client.** L'interface décide encore de ce qui est affiché. Le serveur ne contrôle que les
   consultations IA. Les droits Premium sur la bibliothèque ne sont pas appliqués (C1).
2. **Synchronisation par écrasement.** `progression` réécrit le tableau `hist` en entier (`setDoc` avec `merge`). Deux
   appareils connectés en même temps peuvent s'écraser mutuellement. Ce modèle ne tient pas avec trois supports.
3. **Scores calculés dans le navigateur** (C3). Impossible d'avoir des classements fiables tant que ce point n'est pas
   réglé.
4. **Repli sur le moteur local sur refus de quota** (voir `docs/architecture-espace-jeux.md` §4.3).
5. **Publicité AdSense** : en application mobile, elle demande son propre consentement (et sur iOS, une autorisation de
   suivi). Le retrait de la publicité est déjà envisagé dans le projet.

---

## 3. Architecture backend commune

### 3.1 Principe

```
 Site (web)     Android (Capacitor)    iOS (Capacitor)
     \                 |                  /
      \----- Firebase Auth (uid unique) --/
                        |
   +-----------------------------------------------------+
   | Worker Cloudflare (API commune, vérification serveur)|
   |   - /simulation/*    quotas IA (existant, phase 1)  |
   |   - /entitlements    lecture des droits             |
   |   - /xp/*            journal XP, achats, bonus      |
   |   - /scores/*        scores serveur (C3)            |
   |   - /classements     classements calculés           |
   |   - /webhooks/*      notifications des stores et    |
   |                      du prestataire de paiement     |
   +-----------------------------------------------------+
        |                         |                    |
   Firestore (données        Durable Objects         KV (cache lecture
   synchronisées, règles)    (compteurs, ordre)       seule, jamais source)
```

### 3.2 Rôle de chaque composant

| Composant | Rôle | Pourquoi |
|---|---|---|
| **Firebase Auth** | Identité unique (uid), e-mail vérifié, Google | Déjà en place sur le site. Un même compte sur les trois supports. |
| **Firestore** | Données synchronisées : progression, profil, préférences | Offline natif sur mobile, règles existantes. |
| **Worker** | Logique métier et contrôle des droits | Un seul endroit où les droits sont décidés. |
| **Durable Objects** | Compteurs (quotas, XP en cours, anti-rafale) | Opérations atomiques, déjà utilisées pour les quotas. |
| **KV** | Cache lecture seule | KV est éventuellement cohérent : jamais source de vérité. |
| **Entitlements (source de vérité)** | Droits par uid : Premium, bundle, date de fin, origine | Doit être fortement cohérent. Voir §6.2. |

### 3.3 Modèle de droits (entitlements)

Au lieu d'un seul « plan », des droits séparés, qui peuvent être vendus séparément ou ensemble :

| Droit | Exemple | Source |
|---|---|---|
| `simulateur.premium` | 150 consultations IA par mois, accès complet | Abonnement Premium, ou bundle |
| `jeux.premium` | Jeux réservés et parties illimitées | Abonnement Premium, ou bundle |
| `xp.solde` | Solde d'XP (compteur) | Journal XP (ledger), jamais modifié directement |
| `bundle.global` | Regroupe les deux droits ci-dessus | Abonnement global |

Chaque droit a une origine (`store_apple`, `store_google`, `web_mobile_money`, `manuel`, `bonus`) et une date de fin
le cas échéant. Un même uid peut avoir un droit acheté sur un support et utilisé sur un autre.

### 3.4 Journal XP (ledger)

- Une écriture par événement : bonne réponse, bonus quotidien, achat, correction administrative.
- Chaque écriture a un identifiant unique (idempotence). Un même achat ou une même réponse ne peut pas être comptée
  deux fois, même si la requête est rejouée.
- Le solde est la somme du journal, ou un compteur maintenu dans une transaction atomique (Durable Object).
- Aucune écriture d'XP ne vient directement du client. Le client envoie une réponse, le serveur calcule l'XP.
- Les écritures ne sont jamais modifiées ni supprimées. Une correction est une nouvelle écriture.

### 3.5 Classements

- Quotidien, hebdomadaire, mensuel, historique : calculés à partir du journal, côté serveur.
- Fenêtres en temps UTC, à aligner avec le fuseau d'affichage (Kinshasa, UTC+1), à décider.
- Agrégats mis en cache et recalculés par tâche planifiée, pas à chaque affichage.
- Pseudonymes publics, jamais l'e-mail. Possibilité de se masquer du classement.

---

## 4. Android et iOS : comparaison des solutions

| Solution | Principe | Avantages | Inconvénients | Verdict |
|---|---|---|---|---|
| **PWA seule** (existante) | Le site s'installe sur l'écran d'accueil | Aucun coût de store, aucune revue, déjà en place | Pas de présence dans les stores ; achats in-app impossibles ; iOS limite les notifications et le stockage | **Phase 0**, immédiate |
| **Capacitor** (recommandé) | Enveloppe native autour de l'application web actuelle | Réutilise `index.html` et les 302 cas tels quels ; une seule base de code ; plugins natifs pour les achats et l'authentification | Plugins natifs à maintenir ; authentification Google à adapter sur mobile ; revue store à passer | **Phase 2** |
| **Cordova** | Ancêtre de Capacitor | Écosystème mature | Moins maintenu, moins de plugins récents | Non retenu |
| **React Native / Expo** | Réécriture de l'interface | Performance native, grand écosystème | Réécriture complète de l'interface et du moteur local ; deux bases de code à maintenir | Non retenu à ce stade |
| **Flutter** | Réécriture en Dart | Interface soignée, un seul code | Réécriture complète ; langage différent de l'existant | Non retenu à ce stade |
| **Applications natives séparées** (Kotlin, Swift) | Deux codes distincts | Contrôle maximal | Triple coût : web, Android, iOS | Déconseillé |

**Conclusion** : Capacitor permet de garder l'investissement actuel (interface, cas, moteur local, PWA) et de le
publier sur les stores. Les réécritures sont plus coûteuses et plus risquées à ce stade.

### 4.1 Points de vigilance Capacitor

- **Authentification Google dans la WebView** : la connexion par fenêtre popup ne fonctionne pas dans une WebView.
  Il faut un plugin d'authentification natif ou une redirection. À prototyper avant engagement.
- **Connexion Apple** : si l'application propose une connexion par un fournisseur social (Google), Apple exige aussi
  « Se connecter avec Apple » sur iOS. À prévoir dès la conception.
- **Stockage hors ligne** : Firestore offline et le moteur local doivent être testés sur appareil réel.
- **Mises à jour** : Capacitor et les plugins natifs suivent les versions iOS et Android ; prévoir un cycle de
  maintenance.

---

## 5. Architecture de paiement et d'abonnement multiplateforme

### 5.1 Produits vendus

| Produit | Type | Remarque |
|---|---|---|
| Premium simulateur | Abonnement (mensuel, trimestriel, annuel) | Droit `simulateur.premium` |
| Premium jeux | Abonnement | Droit `jeux.premium`, peut être inclus dans le bundle |
| Bundle global | Abonnement | Regroupe les droits ci-dessus |
| Packs d'XP | Achat **consommable** | Solde d'XP ; achats répétables |

### 5.2 Principe

1. L'application mobile passe l'achat par le système du store (Google Play Billing ou StoreKit / StoreKit 2).
2. Le store envoie une confirmation. Le Worker la **vérifie côté serveur** auprès du store (API du store), jamais sur
   la seule parole du client.
3. Le store notifie le Worker des renouvellements, annulations et remboursements (webhooks) :
   - Apple : App Store Server Notifications ;
   - Google : notifications en temps réel via Pub/Sub.
4. Le Worker met à jour les droits (`entitlements`). Les applications lisent ces droits, mais ne les décident pas.
5. Un prestataire de gestion d'abonnements (option à évaluer, voir §5.5) peut centraliser les deux stores. Ce n'est
   pas obligatoire.

### 5.3 Paiement sur le Web (site)

- Le site accepte Mobile Money et cartes via un prestataire de paiement, à choisir après vérification de la couverture
  réelle en RDC (opérateurs M-Pesa, Orange Money, Airtel Money).
- Le webhook du prestataire met à jour `entitlements` avec `origine: web_mobile_money`.
- Un achat fait sur le Web débloque les droits sur mobile (même uid), sous réserve des règles de §5.4.

### 5.4 Règles des stores : points à vérifier avant tout lancement

Les recherches effectuées n'ont pas permis de confirmer toutes les règles en vigueur en novembre 2026. Les points
suivants doivent être vérifiés sur les pages officielles des stores, et si possible par un juriste :

- **Apple (App Store)** : les contenus numériques consommés dans l'application (abonnements, monnaie virtuelle) doivent
  en principe passer par l'achat intégré d'Apple. Des règles particulières existent pour certains marchés et pour les
  liens vers un paiement externe. Pour la RDC, l'hypothèse de travail est que l'achat intégré est obligatoire.
- **Google Play** : même principe pour les contenus numériques, avec des exceptions régionales et des régimes de
  « facturation alternative » introduits récemment. Les conditions exactes pour la RDC sont à vérifier.
- **Interdiction d'inciter** : dans l'application, il est en général interdit de pousser l'utilisateur vers un paiement
  moins cher ailleurs. Un bouton « payer sur le site » dans l'application peut donc entraîner un rejet.
- **Commissions** : elles varient selon le programme et le type d'achat (abonnements, consommables). À vérifier. Elles
  réduisent le revenu net, et doivent être intégrées dans le calcul de marge (`docs/impact-financier-ia.md`).

**Architecture recommandée** pour respecter ces règles :

- Dans l'application mobile : achats via le store uniquement, aucun lien ni bouton vers le paiement du site.
- Sur le site : Mobile Money et cartes, comme aujourd'hui prévu.
- Les droits sont partagés par uid : un abonné qui a payé sur le site peut utiliser l'application, sans que
  l'application ne mentionne le paiement externe.
- Les textes de l'application ne doivent pas décrire ni comparer les prix du site et du store.

Cette architecture doit être validée par un avis juridique avant implémentation.

### 5.5 Prestataires : options à évaluer (aucun n'est choisi ni souscrit)

| Besoin | Options à comparer | Point à vérifier |
|---|---|---|
| Achats in-app sur les deux stores, vérification et webhooks | RevenueCat, ou intégration directe (Google et Apple) | Tarif selon le chiffre d'affaires ; couverture des règles |
| Paiement web par Mobile Money et cartes | Prestataires d'agrégation africains (ex. Flutterwave, Paystack) ou solution directe avec les opérateurs | Couverture RDC réelle, frais, délais de versement |
| Vérification serveur des achats Apple et Google | Intégration directe (clés API des stores) | Gestion des clés secrètes (jamais dans le client) |

Tous ces services sont payants ou soumis à conditions. Aucun n'est souscrit à ce stade.

### 5.6 Coûts fixes à prévoir (à vérifier)

- Compte Apple Developer : cotisation annuelle.
- Compte Google Play Console : frais d'inscription uniques.
- Un Mac ou un service de compilation macOS pour générer l'application iOS (service payant ou matériel).
- Prestataire d'achats et de webhooks, si retenu.
- Plan Firebase et Cloudflare adapté au volume (grilles à vérifier).
- Commissions des stores et frais des prestataires de paiement (sur chaque vente).

---

## 6. Synchronisation des comptes et des données

### 6.1 Identité

- Un seul uid Firebase par personne, sur les trois supports.
- Connexion Google et e-mail vérifié sur les trois supports. Connexion Apple à ajouter sur iOS si un autre fournisseur
  social est proposé.
- Le profil `medecins/{uid}` est commun. Les règles existantes (`emailOk`) restent valables.

### 6.2 Droits : source de vérité

- **Firestore** (collection `entitlements/{uid}`, écrite uniquement par le Worker avec un compte de service) ou un
  **Durable Object** par uid pour la lecture et l'écriture fortement cohérentes.
- **KV** n'est pas une source de vérité : il est éventuellement cohérent (une minute de décalage possible). Il peut
  servir de cache de lecture.
- Les règles Firestore interdisent toute écriture de `entitlements` par le client.

### 6.3 Données synchronisées

| Donnée | Aujourd'hui | Proposition |
|---|---|---|
| Historique des cas | Tableau `hist` réécrit en entier | Un document par consultation, ou une sous-collection : chaque écriture ajoute, rien n'écrase |
| Consultation en cours | `etats/{uid}`, un document | Conserver ; une seule consultation active par appareil à la fois |
| Progression et scores | Calculés dans le navigateur | Scores enregistrés par le Worker (C3), puis synchronisés |
| XP et classements | Inexistants | Journal XP côté serveur (§3.4) |
| Préférences | Inexistantes | Document `preferences/{uid}`, dernière écriture gagnante |

**Principe de conflit** : les événements (réponses, consultations, XP) sont ajoutés, jamais écrasés. Les préférences
suivent la règle « dernière écriture gagnante ». Un appareil hors ligne accumule ses événements et les envoie à la
reconnexion, avec un identifiant unique pour éviter les doublons.

### 6.4 Hors ligne

- Mobile : Firestore offline + moteur local. Le moteur local ne doit pas être utilisé pour compter une consultation
  (voir `docs/architecture-espace-jeux.md` §4.3, décision D5).
- XP gagnés hors ligne : enregistrés localement, envoyés au serveur à la reconnexion, validés par le serveur.

---

## 7. Risques

### 7.1 Sécurité

| Risque | Mesure proposée |
|---|---|
| Droits décidés par le client | Droits lus uniquement côté serveur (§3.3) ; règles Firestore qui interdisent l'écriture client |
| Achat falsifié ou rejoué | Vérification serveur auprès de chaque store, identifiants uniques, idempotence |
| XP falsifiés | Calcul serveur, journal en ajout seul, limite de débit |
| Clés secrètes dans l'application | Aucune clé de service ni secret dans les applications ; les fichiers de configuration Firebase (`google-services.json`, `GoogleService-Info.plist`) ne sont pas des secrets, mais les clés de compte de service le sont |
| Contenu médical (images, questions) | Voir §8.1 |
| Comptes multiples pour les gratuits | App Check (Play Integrity, App Attest), Turnstile sur le Web, limites par IP existantes |
| Données personnelles | Pseudonymes publics, e-mail jamais affiché, droit à la suppression de compte (exigé par les stores) |

### 7.2 Coûts

| Poste | Risque | Mesure |
|---|---|---|
| Commissions des stores | Réduisent la marge de chaque abonnement | Intégrer dans le calcul de marge avant de fixer les prix |
| IA | Inchangée par le multiplateforme, mais le nombre d'utilisateurs augmente | Plafonds existants ; voir `docs/impact-financier-ia.md` |
| Firestore et Durable Objects | Écritures plus nombreuses (journal XP, classements, synchronisation) | Agrégats, cache, écritures groupées ; grilles à vérifier |
| Frais de compte (Apple, Google) | Coûts fixes | À budgéter |
| Remboursements et litiges | Plus fréquents sur les achats mobiles | Procédure de remboursement, conformité aux règles des stores |

### 7.3 Maintenance

- Trois supports à tester à chaque version (site, Android, iOS), dont deux sur appareil réel.
- Revues des stores à chaque mise à jour, délais variables.
- Mises à jour de Capacitor et des plugins natifs à planifier.
- Un seul `index.html` de plus de 2 500 lignes : chaque changement touche les trois supports. C'est la raison de la
  séparation en modules proposée dans `docs/architecture-espace-jeux.md`.
- Documentation des droits et des webhooks à maintenir.

### 7.4 Juridique et éditorial

- **Règles des stores sur les paiements** : §5.4, à faire valider.
- **Monnaie virtuelle (XP achetables)** : si des gains réels (argent, lots de valeur) sont liés aux classements, le
  risque de qualification de jeu d'argent ou de loterie apparaît. **Recommandation : aucun gain en argent ou lot de
  valeur lié aux classements.**
- **Images médicales** : elles doivent être libres de droits ou licenciées. Une image générée par IA n'est pas fiable
  pour une image diagnostique et ne doit pas être présentée comme telle.
- **Explications médicales** : relecture obligatoire, comme pour les questions.
- **Protection des données** : la réglementation applicable en RDC et les règles des stores (suppression de compte,
  déclaration des données) sont à vérifier.

---

## 8. Espace Jeux : ajustements au cahier des charges actuel

Le cahier des charges a évolué par rapport à `docs/architecture-espace-jeux.md`. Ce document le prend en compte :

| Élément | Avant | Maintenant |
|---|---|---|
| Format | Triades en QCM textuel | **Devinettes à images** : 3 images pour les triades, 4 pour les autres |
| Indices | Non prévus | Indices par catégories |
| Progression | Points par partie | **XP** : gagnés en jouant, ou achetés |
| Classements | Non prévus | Quotidien, hebdomadaire, mensuel, historique |
| Explications | Dans la correction | Accessibles gratuitement après validation de la réponse |

### 8.1 Contenu image

- Chaque image doit avoir une source libre de droits ou une licence écrite. Les photos cliniques de patients exigent un
  consentement et une anonymisation, et ne doivent pas être prises sur Internet sans autorisation.
- Les images doivent être publiées avec une légende et une source, et revues médicalement.
- Une image générée par IA peut servir d'illustration pédagogique seulement si elle est signalée comme telle, et
  jamais comme image réelle d'un patient.
- Le pipeline d'import PDF (`docs/architecture-espace-jeux.md` §7) doit extraire les images avec leur légende et leur
  page, et les soumettre à la même relecture.

### 8.2 Économie d'XP

- **Gains gratuits** : bonnes réponses, bonus quotidien, série de jours, consultations terminées. Plafonds quotidiens
  pour éviter l'abus.
- **Achats** : packs d'XP en consommable, via le store sur mobile et via le prestataire sur le Web.
- **Explications gratuites** : elles ne doivent pas être liées à un achat, sinon l'expérience gratuite devient
  inutilisable. À confirmer.
- Les XP achetés ne doivent pas donner un avantage décisif sur les classements, sinon le classement devient un
  classement de dépense. **Recommandation : classements séparés ou XP acheté non comptabilisé pour le classement**
  (à décider).

### 8.3 Classements

- Calculés côté serveur, à partir du journal XP.
- Fenêtres : jour, semaine, mois, historique ; fuseau à décider (Kinshasa ou UTC).
- Dépendent de C3 pour être fiables.

---

## 9. Plan de migration progressif

Le site reste en service à chaque phase. Chaque phase suppose votre validation écrite avant de démarrer.

| Phase | Contenu | Site | Coût immédiat | Dépend de |
|---|---|---|---|---|
| **0. Stabilisation** | Merge de la phase 1 (C2) après revue, déploiement contrôlé ; décisions D1 à D9 ; PWA améliorée (icônes, hors ligne, installation) | Inchangé, amélioré | Aucun | Vos décisions |
| **1. Droits serveur** | Déplacer les droits (`entitlements`) vers une source fortement cohérente ; le Worker lit cette source ; KV reste en cache | Inchangé | Faible | Phase 0 |
| **2. Conformité** | Protection des données, suppression de compte, pages légales mises à jour ; retrait de la publicité si décidé | Mis à jour | Faible | Avis juridique |
| **3. C1 et C3** | Livraison serveur des cas et corrigés ; scores serveur | Modifié (plus de contenu sur le serveur) | Faible | Phase 1 |
| **4. Enveloppe mobile** | Projet Capacitor dans un dossier séparé (`mobile/`), sans toucher au site ; connexion Google adaptée ; tests internes sur appareils | Inchangé | Comptes développeur (Apple, Google), Mac ou service macOS | Phase 3 |
| **5. Paiements** | Achats in-app (store) et paiement web (Mobile Money, cartes) ; webhooks vérifiés ; droits partagés par uid | Ajout de l'offre web | Prestataires, commissions | Phase 1, avis juridique, §5.4 |
| **6. Jeux et XP** | Espace Jeux (`docs/architecture-espace-jeux.md`), journal XP, classements | Ajout de l'espace | Stockage et écritures | Phases 3 et 5 |
| **7. Publication** | Tests de revue, lancement progressif (test interne, puis fermé, puis public) sur chaque store | Inchangé | Frais de revue | Phases 4 à 6 |

**Ordre recommandé** : 0, 1, 2, 3, puis 4 et 5 en parallèle, puis 6 et 7. Les paiements mobiles ne doivent pas être
publiés avant la phase 1, sinon les droits resteraient décidés côté client.

**Point de non-retour à éviter** : publier une application mobile qui vend des droits avant que le serveur ne soit la
source unique de ces droits.

---

## 10. Recommandations

1. **Ne rien acheter ni souscrire** avant d'avoir validé ce document.
2. **Phase 0 immédiate** : la PWA existe déjà. L'améliorer (icônes, hors ligne, installation) permet d'offrir une
   application aux étudiants sans frais de store et sans risque pour le site.
3. **Choisir Capacitor** plutôt qu'une réécriture, pour garder `index.html`, les 302 cas et le moteur local.
4. **Déplacer les droits côté serveur** (phase 1) avant tout achat in-app. C'est le prérequis de sécurité le plus
   important.
5. **Remplacer l'écriture en bloc de `progression`** par des événements ajoutés, avant d'ajouter le troisième support.
6. **Faire valider par un juriste** les règles de paiement des stores et la pratique du paiement web en RDC (§5.4).
7. **Ne pas lier de gains réels aux classements**, et séparer ou neutraliser l'XP acheté dans les classements.
8. **Utiliser uniquement des images libres de droits ou licenciées**, avec relecture médicale.
9. **Comparer les prestataires de paiement** (§5.5) sur des tarifs et une couverture RDC vérifiés, avant de s'engager.

---

## 11. Décisions à prendre

| Id | Question | Proposition |
|---|---|---|
| **M1** | Phase 0 (PWA améliorée) dès maintenant ? | Oui, sans coût ni risque pour le site. |
| **M2** | Capacitor pour l'enveloppe mobile ? | Oui, après la phase 1. |
| **M3** | Quel prestataire pour les achats in-app ? | À comparer ; aucun choix avant avis juridique. |
| **M4** | Quel prestataire pour le paiement web ? | À comparer sur la couverture RDC. |
| **M5** | L'XP acheté compte-t-il dans les classements ? | Non, ou classements séparés. |
| **M6** | Achat sur le Web, droits utilisés sur mobile : acceptable ? | À valider juridiquement (§5.4). |
| **M7** | Fuseau des classements : Kinshasa ou UTC ? | Kinshasa, pour l'affichage. |
| **M8** | Retrait de la publicité AdSense avant l'application mobile ? | Oui, recommandé (consentement mobile, iOS). |
| **M9** | Connexion Apple à ajouter dès la phase 4 ? | Oui, si Google reste proposé sur iOS. |

---

## 12. Hors périmètre de ce document

- Aucune implémentation, aucun projet mobile créé, aucune dépendance ajoutée.
- Aucun fichier de code modifié.
- Aucune configuration Firebase, Cloudflare ou des stores modifiée.
- Aucun service payant souscrit ni compte développeur ouvert.
- Aucun paiement intégré.
- Les règles des stores (§5.4) et les tarifs (§5.5, §5.6) sont à vérifier avant décision.
