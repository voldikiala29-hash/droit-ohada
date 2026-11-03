# Prompts de génération (ChatGPT)

Ces prompts servent à produire les images de base. Générez **une image par ligne du tableau**, puis appliquez le même bloc de style à chacune pour garder une cohérence visuelle.

## Bloc de style commun (à coller en tête de chaque prompt)

```
Photorealistic professional photograph of a fictional patient, modern hospital room in West Africa,
soft natural clinical light from a window, cool blue and teal tones, realistic skin texture,
shallow depth of field, 50mm lens, vertical 4:5 crop, subject centered with some space above,
modern medical equipment in the background (patient monitor, IV stand), no visible text, no logos,
no blood, no open wounds, no gore, no celebrity, no real identifiable person.
```

## Prompts par scène

| Fichier | Scène | Prompt (partie spécifique, à ajouter après le bloc commun) |
|---|---|---|
| `enfant-320/640/960` | Enfant accompagné | A young African child aged about 7, lying in a hospital bed under a light blue blanket, holding a small teddy bear, a small IV line taped to the hand, calm and slightly worried expression. |
| `ventre-F` | Touche son ventre | An African woman in her thirties in a colourful wax-print dress, seated on a hospital bed, one hand on her lower abdomen, slightly grimacing, looking at the camera. |
| `ventre-M` | Touche son ventre | An African man in his thirties in a hospital gown, seated on the bed, hand pressed on his lower abdomen, uncomfortable expression. |
| `plaie-F` | Montre sa plaie | An African woman in her thirties, wearing a clean white dressing on her forearm, looking at it with a concerned expression, no visible blood. |
| `plaie-M` | Montre sa plaie | An African man in his twenties, a clean white bandage on his lower leg, gesturing towards it, serious expression, no visible blood. |
| `tete-F` | Touche sa tête | An African woman in her twenties, both hands on her temples, tired and pained expression, eyes half closed, headscarf optional. |
| `tete-M` | Touche sa tête | An African man in his forties, one hand on his forehead, tired expression, hospital gown. |
| `poitrine-F` | Touche sa poitrine | An African woman in her forties, one hand on her chest, breathing slightly hard, a light nasal oxygen cannula, sitting up in bed. |
| `poitrine-M` | Touche sa poitrine | An African man in his fifties, one hand flat on his chest, short breath, a light nasal oxygen cannula, sitting up in bed. |
| `neutre-F` | En attente | An African woman in her thirties, sitting calmly in a hospital chair, hands resting in her lap, attentive and patient expression. |
| `neutre-M` | En attente | An African man in his thirties, sitting calmly on a hospital bench, hands clasped, attentive and patient expression. |

## Variantes d'humeur (facultatives)

Ne les produire que si l'expression change vraiment la lecture du cas. Ajoutez simplement l'émotion au prompt de base :

- **douleur** : « clearly in pain, eyes squeezed, jaw tight »
- **anxieux** : « worried and tense, looking away from the camera »
- **triste** : « tired, downcast expression, shoulders dropped »
- **frustre** : « impatient and exhausted, frowning slightly »

## Consignes de sélection

- Gardez la même lumière, la même palette et le même type de chambre pour toutes les images.
- Rejetez toute image avec texte lisible, logo, sang visible, ou visage ressemblant à une personnalité connue.
- Vérifiez les mains et les équipements (perfusions, masque, moniteur) : les erreurs fréquentes des générateurs d'images y sont visibles.
- Enregistrez le master en PNG, hors du dépôt, puis suivez la procédure de `README.md`.

## Vérification juridique

Avant usage commercial, vérifiez les conditions d'utilisation de ChatGPT (droits sur les images générées, usage en production). Conservez une capture de ces conditions à la date de génération.
