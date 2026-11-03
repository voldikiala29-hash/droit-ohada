# Worker du patient virtuel : configuration

## Liaisons Cloudflare requises
- `AI` : Workers AI.
- `STATE` : espace Workers KV, **obligatoire**. Sans lui, le Worker répond 503 et le navigateur bascule sur le moteur local.
- `RATE` : espace KV optionnel, limite par adresse IP.

## Variables optionnelles
- `ALLOWED_ORIGIN` : `https://salledegarde.online` (défaut).
- `FIREBASE_PROJECT_ID` : `salledegarde-89dae` (défaut).

## Attribuer une formule Premium (provisoire, avant la Phase 3)
L'identifiant d'un utilisateur est visible dans son profil (champ « Identifiant »).

```bash
wrangler kv key put --binding=STATE "plan:<UID>" \
  '{"plan":"premium","until":"2026-12-31T23:59:59Z"}'
```

Pour revenir à la formule gratuite, supprimer la clé :

```bash
wrangler kv key delete --binding=STATE "plan:<UID>"
```

## Quotas (valeurs à valider)
- Gratuit : 5 cas distincts par mois (UTC).
- Premium : 60 cas distincts par mois (indicatif).
- Un cas déjà compté reste accessible sans nouveau décompte.
- Le quota n'est décompté qu'après une réponse réussie de l'IA.
- Une fois le quota atteint, le navigateur passe au moteur local (règles, sans IA). C'est un choix de produit à confirmer.

## Tests
```bash
cd worker && npm test
```
