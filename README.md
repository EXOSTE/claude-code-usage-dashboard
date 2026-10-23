# Token Follow

Tableau de bord local qui suit ta consommation de tokens **Claude Code**, et ce qu'elle aurait coûté au tarif de l'API Anthropic.

Tout reste sur ton ordinateur : le serveur lit les journaux que Claude Code écrit déjà dans `~/.claude/projects`, et n'envoie rien nulle part.

**Ce que tu y vois :**
- les tokens par type (entrée, sortie, écriture et lecture de cache) et par jour, comparés à la période précédente ;
- l'**équivalent en prix API** (en dollars) par modèle, par projet et par session ;
- le taux de cache, la part des sous-agents, ton jour le plus chargé ;
- une carte de chaleur des jours et heures où tu utilises Claude ;
- les sessions les plus gourmandes, avec leur titre ;
- un filtre par projet, les périodes 24 h / 7 j / 30 j / 90 j / Tout, et un export CSV.

## Installation

Il te faut [Node.js](https://nodejs.org) 18 ou plus récent (rien d'autre à installer).

```bash
git clone https://github.com/EXOSTE/Token-follow.git
cd Token-follow
npm run setup
```

C'est tout : le tableau de bord s'ouvre sur **http://localhost:4317** et le serveur démarrera tout seul à chaque ouverture de session.

> Ne déplace pas et ne supprime pas le dossier `Token-follow` après l'installation : le démarrage automatique pointe dessus. Si tu le déplaces, relance `npm run setup` depuis son nouvel emplacement.

**Autre port :** `npm run setup -- --port 4318`

| Système | Démarrage automatique |
|---|---|
| macOS | agent `launchd`, relancé automatiquement s'il s'arrête |
| Linux | service `systemd --user` (sinon, entrée de démarrage du bureau) |
| Windows | script dans le dossier Démarrage, lancé sans fenêtre |

## Commandes

| Commande | Effet |
|---|---|
| `npm run setup` | installe (ou réinstalle) le démarrage automatique et lance le serveur |
| `npm run status` | dit si le service est installé et si le serveur répond |
| `npm run remove` | supprime le démarrage automatique et arrête le serveur |
| `npm start` | lance le serveur une seule fois, sans rien installer |

## Bon à savoir

- **Supprimer une session dans Claude efface aussi son journal.** Pour ne pas perdre ses stats, Token Follow recopie chaque appel dans un historique à lui : `~/.claude-tokens-history/`. Il le complète toutes les 5 minutes, page ouverte ou non. Les sessions supprimées *avant* l'installation, en revanche, ne peuvent pas être récupérées.
- **L'équivalent API n'est pas ta facture.** Avec un abonnement Claude, tu ne paies pas à l'appel. C'est ce que ces appels auraient coûté au tarif public de l'API.
- **Les tarifs sont dans [`pricing.mjs`](pricing.mjs)**, relevés le 6 octobre 2026. Si un nouveau modèle sort, ajoute-le là, sinon le coût de ses appels n'est pas calculé.
- Seul Claude Code est compté : les conversations sur claude.ai ou sur d'autres ordinateurs ne laissent pas de journal local.
- Le serveur n'écoute que sur `127.0.0.1` : il n'est pas accessible depuis le réseau.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `4317` | port du tableau de bord |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | dossier des journaux Claude Code |
| `TOKENS_HISTORY_DIR` | `~/.claude-tokens-history` | historique permanent |

Si tu les définis avant `npm run setup`, l'installeur les transmet au service.

## Désinstaller complètement

```bash
npm run remove
```

Puis supprime le dossier `Token-follow`, et `~/.claude-tokens-history` si tu ne veux pas garder l'historique.

---

## English

**Token Follow** is a local dashboard for your **Claude Code** token usage and its equivalent cost at Anthropic API prices. It reads the logs Claude Code already writes to `~/.claude/projects`; nothing leaves your computer. The UI is in French.

```bash
git clone https://github.com/EXOSTE/Token-follow.git
cd Token-follow
npm run setup        # Node.js 18+; opens http://localhost:4317 and starts at every login
```

`npm run remove` uninstalls the auto-start. Usage history is kept in `~/.claude-tokens-history` so deleting a session in Claude doesn't erase its stats.

## Licence

MIT
