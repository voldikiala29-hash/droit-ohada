# Images patients (fictifs)

Ce dossier accueille les images des patients virtuels de Salle de Garde.

## Principe

- **Une image par catégorie de cas**, et non une image par cas. Les 302 cas partagent des images selon leur scène clinique (`enfant`, `ventre`, `plaie`, `tete`, `poitrine`, `neutre`) et leur sexe (`F`, `M`).
- Le fichier `manifest.json` décrit cette association. Il ne modifie pas `cases_202.js`.
- Si une image est absente, la carte affiche l'illustration SVG existante (`ptSvg`). Rien ne disparaît.

## Ordre de recherche

1. `scène + sexe + humeur` (variante facultative, par exemple `ventre-M-douleur`)
2. `scène + sexe` (image de base)
3. `scène` seule (enfants)
4. Illustration SVG existante

## Nommage des fichiers

```
{scène}-{sexe}[-{humeur}]-{taille}.{format}
```

Exemples :

- `ventre-F-320.avif`, `ventre-F-320.webp`
- `ventre-F-640.avif`, `ventre-F-640.webp`
- `ventre-F-960.avif`, `ventre-F-960.webp`
- `enfant-320.webp` (sans sexe)

Le nom est en minuscules, sans accents ni espaces.

## Spécifications techniques

| Élément | Valeur |
|---|---|
| Ratio | 4:5 (portrait), sujet centré, marge au-dessus |
| Tailles | 320, 640 et 960 px de large |
| Formats | AVIF (prioritaire), WebP (repli) |
| Poids cible | 60 Ko max en 960 px, 25 Ko en 640 px, 10 Ko en 320 px |
| Espace colorimétrique | sRGB |
| Métadonnées | supprimées (EXIF, XMP, nom du fichier source) |

Les masters (PNG ou fichiers ChatGPT d'origine) ne sont **pas** versionnés dans le dépôt. Ils restent en dehors du dépôt.

## Conversion (exemple)

```bash
# Depuis le master (hors dépôt), à exécuter pour chaque image
convert master.png -resize 960x -strip -quality 80 ventre-F-960.webp
convert master.png -resize 640x -strip -quality 78 ventre-F-640.webp
convert master.png -resize 320x -strip -quality 75 ventre-F-320.webp
# AVIF si l'outil est disponible (avifenc, ou convert avec libavif)
```

## Règles de contenu

- **Patients fictifs.** Chaque image représente une personne inventée. Ne jamais utiliser le visage ou le nom d'une personne réelle.
- **Mention dans le texte alternatif.** Commencer par « Patient fictif », par exemple : « Patient fictif, touche son ventre, visage douloureux ».
- **Pas de sang, pas de plaie ouverte, pas de scène choquante.** L'application est destinée aux étudiants.
- **Pas de texte ni de logo lisible** sur les écrans, les vêtements ou les badges.
- **Diversité** d'âge, de sexe, de carnation et de tenues, sans stéréotypes.
- **Cohérence clinique.** Un médecin doit valider l'expression et les équipements pour chaque scène avant intégration.

## Processus de validation

1. Génération des images (voir `PROMPTS.md`).
2. Relecture visuelle : conformité au cadrage, aux règles de contenu et à la scène.
3. Validation clinique par un médecin.
4. Conversion en AVIF et WebP aux trois tailles.
5. Vérification du poids et du rendu sur mobile.
6. Intégration (étape distincte, après accord).

## Statut

Structure préparée. Aucune image n'est encore intégrée. Le code de rendu n'a pas été modifié.
