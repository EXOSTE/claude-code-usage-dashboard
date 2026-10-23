# Token Follow

Tableau de bord local (http://localhost:4317) de la consommation de tokens Claude Code.
Node ≥ 18 sans dépendance : `server.mjs` (lecture + agrégation), `index.html` (page), `scripts/demo.mjs` (données fictives),
`pricing.mjs` (équivalent API), `scripts/service.mjs` (installation du démarrage auto).

## Données
- Source : `~/.claude/projects/**/*.jsonl` (surchargeable par `CLAUDE_PROJECTS_DIR`).
- Cowork : `<app Claude Desktop>/local-agent-mode-sessions/**/*.jsonl` (source `cowork`, projet « Cowork (Claude Desktop) »), seulement sous `.claude/projects/` ou `audit.jsonl` (le reste = plugins),
  titres dans les `local_<id>.json` voisins (`cliSessionId`). Format observé, non documenté : `session_id` ou
  `sessionId`, date parfois hors de `timestamp`, copie `audit.jsonl` en double (dédoublonnée par keepMax).
  Jamais vérifié sur une vraie session Cowork (l'auteur ne l'utilise pas) : seulement sur des journaux fabriqués.
- Forfait : `<app Claude Desktop>/plan-usage-history.json` (`samples[].u.fh` = % limite 5 h, `.sd` = % 7 jours),
  archivé dans `plan.jsonl` de l'historique (l'app ne garde qu'environ 30 jours).
- Historique permanent : `~/.claude-tokens-history/` (`calls.jsonl` en ajout seul, `titles.json`, `plan.jsonl`),
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
- macOS testé en conditions réelles. Linux (systemd et .desktop) et Windows : installation/désinstallation vérifiées en CI (`.github/workflows/install.yml`), mais pas le démarrage après une vraie ouverture de session.

## Journal des améliorations (ajout seul, le plus récent en haut)
- 2026-10-23 : sessions Cowork locales comptées (tuile + projet « Cowork (Claude Desktop) ») ; courbe d'utilisation du forfait 5 h / 7 jours ; démo avec Cowork et forfait.
- 2026-10-23 : tableaux sans colonne coupée de 1280 à 1600 px (« Par modèle » sur 3/5 de ligne, projets et sessions en pleine largeur) ; captures regénérées.
- 2026-10-23 : dépôt renommé `claude-code-usage-dashboard` (trouvable par recherche) ; `npm run demo` (données fictives, sert aussi aux captures du README) ; README vitrine ; CI de l'installeur sur 3 OS + variante sans systemd ; `main` protégée (7 tests requis).
- 2026-10-23 : dépôt GitHub public, installeur multiplateforme, chemins Windows.
- 2026-10-19 : balayage auto toutes les 5 min (sans visiteur, l'historique ne se remplissait pas).
- 2026-10-19 : création ; historique permanent ; démarrage auto ; équivalent API ; période « Tout ».
