# Impact financier de l'IA (Premium à 150 consultations par mois)

Statut : **estimation.** Les hypothèses sur les tokens doivent être mesurées sur un échantillon réel avant de
fixer un prix ou un plafond. Aucun tarif, aucun paramètre et aucune facturation n'ont été modifiés.

Méthode : un seul modèle de calcul est utilisé dans ce document (script de vérification de la session du
4 novembre 2026, qui lit le prompt système réel dans `worker/patient-worker.js`). Les fourchettes couvrent
3 à 4 caractères par token.

## 1. Tarifs utilisés

Source : documentation Cloudflare Workers AI, page « Pricing » (dernière mise à jour affichée : 20 octobre 2026),
modèle `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.

| Élément | Tarif |
|---|---|
| Tokens d'entrée | 0,293 USD par million |
| Tokens de sortie | 2,253 USD par million |
| Neurone | 0,011 USD pour 1 000 neurones |
| Quota gratuit | 10 000 neurones par jour |

**À vérifier avant décision** : le plan Workers payant et l'allocation incluse, qui modifient le coût réel.

## 2. Taille des requêtes

- Prompt système (texte fixe du Worker) : **1 897 caractères**, mesuré dans `worker/patient-worker.js`.
- Persona et faits : environ 680 + 600 caractères (estimation d'une consultation typique).
- Historique transmis : jusqu'à 12 messages, environ 150 caractères chacun.
- Message du médecin : environ 80 caractères.
- Réponse du patient : environ 60 tokens (plafond technique : 220 tokens).

Conséquence importante : chaque message renvoie tout le prompt et tout l'historique. **Le coût croît avec la
longueur de la consultation**, donc le plafond de 40 messages par cas a un effet direct sur le coût.

## 3. Coût par consultation (un cas, n messages)

| Messages dans le cas | Coût (fourchette) | Coût central |
|---|---|---|
| 5 | 0,0020 à 0,0024 USD | 0,0022 USD |
| 15 (consultation typique) | 0,0067 à 0,0083 USD | **0,0075 USD** |
| 25 | 0,0118 à 0,0146 USD | 0,0132 USD |
| 40 (plafond par cas) | 0,0194 à 0,0240 USD | **0,0217 USD** |

Soit environ **0,00054 USD par message** en moyenne sur une consultation de 40 messages (environ 49 neurones).

## 4. Coût mensuel par utilisateur

| Profil | Cas × messages | Coût mensuel (central) | Fourchette |
|---|---|---|---|
| Gratuit, maximum | 5 × 40 | **0,11 USD** | 0,11 à 0,12 |
| Premium, usage très léger | 150 × 5 | 0,33 USD | |
| Premium, usage typique | 150 × 15 | **1,13 USD** | 1,01 à 1,24 |
| Premium, usage maximal | 150 × 40 | **3,25 USD** | 2,91 à 3,60 |

## 5. Revenu par abonné Premium, comparé au coût

Prix indicatifs : mensuel 3 USD ; trimestriel 8 USD soit 2,67 USD par mois ; annuel 25 USD soit 2,08 USD par mois.

Marge = revenu mensuel effectif − coût IA mensuel.

| Formule | Revenu mensuel | Marge, usage typique (1,13) | Marge, usage maximal (3,25) |
|---|---|---|---|
| Mensuelle (3 USD) | 3,00 | **+1,87** | **−0,25** |
| Trimestrielle (2,67 USD / mois) | 2,67 | **+1,54** | **−0,58** |
| Annuelle (2,08 USD / mois) | 2,08 | **+0,95** | **−1,17** |

**Ces marges sont avant** :
- les frais de paiement (cartes et Mobile Money : pourcentage et frais fixes, à vérifier auprès de chaque fournisseur) ;
- la TVA éventuelle ;
- le coût fixe du Worker payant (environ 5 USD par mois, à vérifier) ;
- les coûts Durable Objects et KV, non chiffrés ici ;
- les coûts d'hébergement et de support.

## 6. Coût global à l'échelle

| Nombre de Premium actifs | Usage typique (150 × 15) | Usage maximal (150 × 40) |
|---|---|---|
| 100 | environ 113 USD / mois | environ 325 USD / mois |
| 1 000 | environ 1 130 USD / mois | environ 3 250 USD / mois |

Pour le gratuit, à 10 000 utilisateurs (usage maximal, 5 × 40) : environ 1 085 USD / mois de coût IA, sans aucun
revenu. **Le gratuit n'est pas gratuit à grande échelle.** Il faut un plafond global ou une conversion vers le payant.

## 7. Quota gratuit de Cloudflare

10 000 neurones par jour ≈ 200 messages par jour pour **toute la plateforme** (49 neurones par message, valeur
centrale sur une consultation longue). Le plafond gratuit est donc dépassé dès que la plateforme a quelques dizaines
d'utilisateurs actifs. Le coût est alors facturé au tarif indiqué plus haut.

## 8. Sensibilité aux hypothèses

- Si un token de français représente 3 caractères au lieu de 4, le coût augmente d'environ 24 % pour une
  consultation de 15 messages (la fourchette de la section 3 le couvre).
- Si la moyenne réelle est de 25 messages par consultation au lieu de 15, le coût d'un cas augmente d'environ 76 %.
- **Le facteur le plus important est le nombre de messages par consultation**, pas le nombre de cas. Un Premium qui
  fait 150 cas en 5 messages chacun coûte environ 0,33 USD ; le même avec 40 messages chacun coûte 3,25 USD.

**Donnée manquante** : la distribution réelle du nombre de messages par consultation. Elle doit être mesurée en
préproduction (journaux du Worker : nombre de messages par `cas.id` et par mois).

## 9. Options pour borner le coût (à décider, non appliquées)

1. **Plafond mensuel de messages par utilisateur Premium** (par exemple 1 000 messages par mois). Coût maximal
   estimé : environ 0,54 USD, quel que soit le nombre de cas. Pour 1 500 messages : environ 0,81 USD.
2. **Plafond de tokens par consultation** : réduire l'historique transmis (6 messages au lieu de 12). Réduit le coût
   d'environ 11 % pour une consultation de 40 messages, avec un risque de perte de cohérence du patient : le gain est
   modeste, donc ce levier seul ne suffit pas.
3. **Prix révisé** : à usage maximal (3,25 USD par mois), aucune formule actuelle ne couvre le coût IA. Un prix
   annuel d'environ 40 USD (3,33 USD par mois) couvrirait l'usage maximal, avant frais de paiement.
4. **Usage équitable** : affichage de la consommation et avertissement avant le plafond.

Ces options sont **des propositions**. Aucune n'est appliquée.

## 10. Conclusion

- À 150 cas avec un usage typique (15 messages par cas), le Premium reste rentable dans toutes les formules, avant
  frais de paiement : la marge la plus faible est celle de l'annuel, à environ +0,95 USD par mois.
- À 150 cas avec 40 messages chacun, le Premium est **déficitaire dans toutes les formules**, y compris la mensuelle.
- Le gratuit coûte peu par utilisateur (environ 0,11 USD), mais de façon non bornée à grande échelle sans plafond global.
- Avant lancement : mesurer le nombre réel de messages par consultation, puis choisir entre plafond mensuel de
  messages, révision du prix et usage équitable.
