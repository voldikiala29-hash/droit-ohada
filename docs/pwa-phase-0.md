# PWA, phase 0 : installation, hors ligne et affichage mobile

Statut : **réalisé sur la branche `securite/phase-1-cases-worker-scores`, non déployé.** Aucune modification de `main`,
aucune fusion, aucun déploiement sur le site public, aucune configuration Firebase ou Cloudflare, aucun changement du
moteur médical, des 302 cas, des règles d'abonnement ou des quotas.

Document lié : `docs/architecture-multiplateforme.md` (phase 0 du plan de migration).

---

## 1. Fichiers modifiés

| Fichier | Nature | Résumé |
|---|---|---|
| `manifest.webmanifest` | modifié | `id`, `orientation`, `categories`, `dir` ; couleurs de lancement alignées sur le fond réel (`#0A1518`) ; icônes maskable 192 et 512 ajoutées |
| `sw.js` | réécrit | Service worker : précache de la coquille et des SDK Firebase, réseau d'abord, page hors ligne, cache des polices. Voir §3 |
| `index.html` | modifié (en-tête et bandeau uniquement) | Icône Apple 180 px, balises iOS, `theme-color` aligné ; bandeau « hors ligne » ajouté au bloc d'installation existant |
| `apple-touch-icon.png` | nouveau | 180 × 180, RVB sans transparence, généré depuis `logo.png` |
| `icon-192-maskable.png` | nouveau | 192 × 192, logo à 80 % (zone de sécurité) sur fond de marque |
| `icon-512-maskable.png` | nouveau | 512 × 512, logo à 80 % sur fond de marque |
| `offline.html` | nouveau | Page de secours hors ligne, français, thème clair et sombre |
| `worker/test/pwa-static.test.mjs` | nouveau | 12 tests statiques (manifeste, icônes, service worker, en-tête, page hors ligne) |

`logo.png` et `favicon-192.png` ne sont pas modifiés : ils restent utilisés par les balises Open Graph et le favicon.

Aucun autre fichier n'est touché. `cases_202.js`, le moteur médical et `worker/patient-worker.js` sont inchangés.

## 2. Ce qui change pour l'utilisateur

- **Android** : l'icône adaptative ne sera plus recadrée de façon aléatoire grâce aux versions maskable ; l'écran de lancement
  utilise la couleur réelle de l'application.
- **iOS** : l'icône de l'écran d'accueil est en 180 × 180 (au lieu du logo 512 px, que iOS réduisait). Le titre
  affiché sous l'icône est « Salle de Garde ».
- **Hors ligne** : après une première visite en ligne, l'interface se recharge sans réseau. Un bandeau discret en bas
  indique le mode hors ligne. Le moteur local continue de répondre. Les réponses avancées (IA) reviennent au retour de
  la connexion.
- **Première visite hors ligne** : une page de secours explique la situation, au lieu de la page d'erreur du navigateur.
- **Connexion instable** : le service worker répond à partir de la copie locale si le réseau ne répond pas en
  4 secondes.

## 3. Service worker : règles

| Requête | Traitement |
|---|---|
| Hors `GET` (appels IA vers le Worker, écritures Firestore) | **Non interceptée** |
| Origine du site (pages, `cases_202.js`, manifeste, icônes) | Réseau d'abord ; copie locale si le réseau ne répond pas en 4 s ou échoue ; page de secours pour une navigation sans copie |
| SDK Firebase versionnés (`www.gstatic.com/firebasejs/11.0.2/…`) | Cache d'abord (URL immuable) |
| Polices Google | Cache d'abord |
| Worker IA, Firebase Auth, Firestore, publicité, analytics | **Non interceptés** : réseau direct |

Installation : chaque fichier est tenté seul, un échec ne bloque pas l'installation. Activation : les caches des
versions précédentes sont supprimés.

**Règle de maintenance** : à chaque modification de `sw.js` ou de la coquille, changer `VERSION` (commentaire en tête
du fichier). Sans cela, les anciens fichiers restent en cache.

## 4. Vérifications réalisées

### 4.1 Tests automatisés

- `npm test` dans `worker/` : **70 tests, 70 réussis** (58 existants, 12 nouveaux).
- Les tests existants de cohérence (politique des quotas, client statique, pas de quota en dur dans `index.html`) passent.

### 4.2 Navigateur (Chromium, émulations)

Serveur local sur le dépôt, quatre profils : Pixel 7, iPhone 13, iPad (7e génération), téléphone étroit 360 × 740.

| Profil | Service worker | Défilement horizontal | Hors ligne : interface rechargée | Bandeau hors ligne | Page de secours |
|---|---|---|---|---|---|
| Pixel 7 | actif | 0 px | oui | affiché | « Hors ligne » |
| iPhone 13 | actif | 0 px | oui | affiché | « Hors ligne » |
| iPad 7e gén. | actif | 0 px | oui | affiché | « Hors ligne » |
| 360 × 740 | actif | 0 px | oui | affiché | « Hors ligne » |

Le manifeste est lu correctement sur les quatre profils, avec les icônes any et maskable.

### 4.3 Ce qui n'a PAS pu être vérifié

1. **Démarrage hors ligne complet de l'application Firebase.** Le CDN `www.gstatic.com` est bloqué depuis l'environnement
   de test (refus du proxy). Les SDK Firebase ne se chargent donc pas dans les tests, en ligne comme hors ligne. Le
   rechargement hors ligne vérifié ci-dessus porte sur la coquille HTML, pas sur l'authentification ni la synchronisation.
   À vérifier sur un appareil réel, après une première visite en ligne.
2. **Safari iOS et Firefox Android.** Seul Chromium est disponible. Le comportement d'installation (« Sur l'écran
   d'accueil » sur iOS), les notifications et le stockage hors ligne propres à Safari doivent être testés sur un iPhone
   et un iPad réels.
3. **Invite d'installation Android** (`beforeinstallprompt`) : non déclenchée dans l'émulation. À tester sur un Android réel.
4. **Lancement en mode autonome** : non vérifié visuellement sur appareil.
5. **Écrans de démarrage iOS** (images de lancement par taille d'appareil) : non créés. Sans elles, iOS affiche un écran
   blanc ou noir bref au lancement. C'est une limite connue de la phase 0.

## 5. Problèmes existants relevés (non corrigés)

- **Images manquantes** : `index.html` référence `images/ecg-bg.webp` et `images/hero-ia.webp`, mais le dossier `images/`
  n'existe pas dans le dépôt, et ce n'est pas nouveau (déjà présent sur `main`). Conséquence : deux 404 à chaque
  chargement, et le fond décoratif de l'accueil n'apparaît pas. L'image du bloc « patient virtuel » a déjà un repli
  (`onerror`). Correction à décider : fournir les images, ou retirer les références.
- **Publicité AdSense** : toujours présente (hors périmètre de cette phase, décision M8 du document multiplateforme).

## 6. Risques

| Risque | Gravité | Mesure |
|---|---|---|
| Coquille servie depuis le cache alors que le réseau est lent (plus de 4 s) : une version antérieure peut s'afficher brièvement | Faible | Mise à jour au chargement suivant ; `VERSION` à changer à chaque release |
| Oubli de changer `VERSION` : des fichiers anciens restent en cache | Moyen | Règle écrite en tête de `sw.js` ; à ajouter à la procédure de release |
| Cache des SDK Firebase : une version corrompue resterait en cache | Faible | URLs versionnées (11.0.2), `res.ok` requis |
| Cache d'une page contenant des données personnelles | Faible | Aucune donnée personnelle n'est dans le HTML ; Firebase Auth et Firestore ne sont pas interceptés |
| Bandeau qui masque la zone de saisie sur petit écran | Faible | Bandeau réduit à une ligne, affiché uniquement hors ligne |
| Safari iOS réduit le stockage des service workers | Moyen | Pas de stockage critique ; le moteur local fonctionne sans cache |
| Confusion avec l'authentification : la session Firebase n'est pas garantie hors ligne | Moyen | La page de secours et le bandeau l'indiquent ; à tester sur appareil |

## 7. Procédure de retour arrière

1. Restaurer l'ancien `sw.js` (version sans cache : seulement `install`, `activate` et un `fetch` vide), ou le remplacer
   par un fichier qui se désinstalle lui-même.
2. Restaurer `manifest.webmanifest` et l'en-tête de `index.html` depuis `main`.
3. Les icônes ajoutées peuvent rester : elles ne sont référencées par rien une fois le manifeste restauré.

Aucun retour arrière n'est nécessaire côté Firebase ou Cloudflare : rien n'a été modifié dans ces services.

## 8. Procédure de mise en production (non réalisée)

1. Vérifier les tests (`npm test` dans `worker/`) et la liste des fichiers modifiés (§1).
2. Test sur appareils réels : Android (Chrome) et iPhone (Safari), installation, lancement, hors ligne après une
   première visite.
3. Revue de la branche par vous.
4. Fusion dans `main` et déploiement GitHub Pages : **uniquement sur votre autorisation écrite**.

## 9. Hors périmètre de la phase 0

- Écrans de démarrage iOS.
- Notifications push.
- Connexion Apple et connexion native (phase 4 de la migration).
- Correction des images manquantes.
- Tout changement des quotas, du moteur médical, des 302 cas ou de l'abonnement.
