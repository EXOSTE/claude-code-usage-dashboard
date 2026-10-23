# Token Follow

Tableau de bord local (http://localhost:4317) de la consommation de tokens Claude Code.
Node ≥ 18 sans dépendance : `server.mjs` (lecture + agrégation), `index.html` (page),
`pricing.mjs` (équivalent API), `scripts/service.mjs` (installation du démarrage auto).

## Données
- Source : `~/.claude/projects/**/*.jsonl` (surchargeable par `CLAUDE_PROJECTS_DIR`).
- Historique permanent : `~/.claude-tokens-history/` (`calls.jsonl` en ajout seul, `titles.json`),
  surchargeable par `TOKENS_HISTORY_DIR`. Supprimer une session dans Claude efface son journal :
  l'historique la garde (marquée `archived`). Ne jamais vider ce dossier sans demander.

## Pièges connus
- Un message API = plusieurs lignes (une par bloc) : dédoublonner par `message.id:requestId`, garder le compteur le plus grand.
- Le projet d'une session = `cwd` de sa première ligne (Claude fait des `cd` dans des sous-dossiers). Normaliser les `\` de Windows.
- Tarifs codés en dur dans `pricing.mjs` (relevés 2026-10-06) : ajouter chaque nouveau modèle, sinon les colonnes de coût disparaissent.
- Le dépôt est public : ne jamais y mettre de journaux, d'historique ni de chemins personnels.

## Exécution
- `npm run setup` installe le démarrage auto : launchd (`com.token-follow`), systemd `--user` (`token-follow.service`)
  ou dossier Démarrage Windows (`token-follow.vbs`). Journal : `server.log` (ignoré par git).
- Après une modif de `server.mjs` ou `pricing.mjs` : relancer `npm run setup` (il remplace l'installation existante).
  `index.html` est relu à chaque requête, un simple rechargement suffit.
- Seule l'installation macOS a été testée en conditions réelles ; Linux et Windows sont écrits mais non vérifiés.

## Journal des améliorations (ajout seul, le plus récent en haut)
- 2026-10-23 : dépôt GitHub public, installeur multiplateforme, chemins Windows.
- 2026-10-19 : balayage auto toutes les 5 min (sans visiteur, l'historique ne se remplissait pas).
- 2026-10-19 : création ; historique permanent ; démarrage auto ; équivalent API ; période « Tout ».
