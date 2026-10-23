<div align="center">

# Token Follow

**Tableau de bord local de ta consommation Claude Code : tokens, cache, et ce que ça coûterait au prix de l'API.**

[![Tests de l'installeur](https://github.com/EXOSTE/claude-code-usage-dashboard/actions/workflows/install.yml/badge.svg)](https://github.com/EXOSTE/claude-code-usage-dashboard/actions/workflows/install.yml)
![Node 18+](https://img.shields.io/badge/node-%E2%89%A5%2018-339933?logo=node.js&logoColor=white)
![Zéro dépendance](https://img.shields.io/badge/d%C3%A9pendances-0-brightgreen)
![macOS · Linux · Windows](https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-lightgrey)
[![Licence MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/apercu-sombre.png">
  <img src="docs/apercu-clair.png" alt="Le tableau de bord : chiffres clés, tokens par jour, carte de chaleur, répartition par modèle et par projet" width="900">
</picture>

<sub>Données fictives, générées par <code>npm run demo</code>.</sub>

</div>

## Pourquoi

Claude Code n'affiche pas ce que tu consommes au fil des jours. Pourtant chaque appel est noté dans `~/.claude/projects`. Token Follow lit ces journaux et te montre :

- **combien de tokens** tu utilises par jour, par modèle, par projet et par session, comparé à la période précédente ;
- **l'équivalent en dollars au tarif de l'API**, utile pour juger ce que ton abonnement t'apporte ;
- **ton taux de cache**, la part des sous-agents et tes sessions les plus gourmandes ;
- **quand tu travailles**, avec une carte de chaleur jour × heure.

Et trois choses qu'on apprécie vite :

| | |
|---|---|
| 🔒 **100 % local** | Le serveur n'écoute que sur `127.0.0.1` et n'envoie rien nulle part. Aucun compte, aucune clé API. |
| 🗂 **Rien ne se perd** | Supprimer une session dans Claude efface son journal. Token Follow garde sa propre copie de chaque appel, pour que tes stats survivent. |
| ⚡ **Une commande, zéro dépendance** | Node 18 suffit. Pas de `node_modules`, pas de base de données, pas de build. |

## Essayer en 10 secondes, sans rien installer

```bash
git clone https://github.com/EXOSTE/claude-code-usage-dashboard.git
cd claude-code-usage-dashboard
npm run demo
```

Le tableau de bord s'ouvre sur des données fictives (60 jours, cinq projets). Tes vrais journaux ne sont pas lus. `Ctrl+C` pour arrêter.

## Installation

Il te faut [Node.js](https://nodejs.org) 18 ou plus récent.

```bash
git clone https://github.com/EXOSTE/claude-code-usage-dashboard.git
cd claude-code-usage-dashboard
npm run setup
```

C'est tout : le tableau de bord s'ouvre sur **http://localhost:4317** et le serveur redémarre tout seul à chaque ouverture de session.

> **Encore plus simple :** demande à Claude Code
> *« Installe-moi https://github.com/EXOSTE/claude-code-usage-dashboard »*.

Ne déplace pas le dossier après l'installation, le démarrage automatique pointe dessus. Si tu le déplaces, relance `npm run setup` depuis son nouvel emplacement.

| Système | Démarrage automatique |
|---|---|
| macOS | agent `launchd`, relancé s'il s'arrête |
| Linux | service `systemd --user` (sinon, entrée de démarrage du bureau) |
| Windows | script dans le dossier Démarrage, lancé sans fenêtre |

L'installation et la désinstallation sont testées à chaque modification sur les trois systèmes, avec Node 18 et 22.

## Commandes

| Commande | Effet |
|---|---|
| `npm run setup` | installe (ou réinstalle) le démarrage automatique et lance le serveur |
| `npm run status` | dit si le service est installé et si le serveur répond |
| `npm run remove` | supprime le démarrage automatique et arrête le serveur |
| `npm start` | lance le serveur une seule fois, sans rien installer |
| `npm run demo` | lance le tableau de bord sur des données fictives |

Autre port : `npm run setup -- --port 4318`

## Bon à savoir

- **L'équivalent API n'est pas ta facture.** Avec un abonnement Claude, tu ne paies pas à l'appel : c'est ce que ces appels auraient coûté au tarif public de l'API.
- **L'historique** est dans `~/.claude-tokens-history/`, complété toutes les 5 minutes, page ouverte ou non. Les sessions supprimées *avant* l'installation ne peuvent pas être récupérées.
- **Les tarifs sont dans [`pricing.mjs`](pricing.mjs)**, relevés le 6 octobre 2026. Si un nouveau modèle sort, ajoute-le là, sinon le coût de ses appels n'est pas calculé.
- Seul Claude Code est compté : les conversations sur claude.ai ou sur d'autres ordinateurs ne laissent pas de journal local.

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

Puis supprime le dossier du dépôt, et `~/.claude-tokens-history` si tu ne veux pas garder l'historique.

---

## English

**Token Follow** is a local **Claude Code usage dashboard**: daily token usage, cache hit rate, sub-agent share, per-model / per-project / per-session breakdowns, an activity heatmap, and the **equivalent cost at Anthropic API prices**. It reads the logs Claude Code already writes to `~/.claude/projects`; nothing leaves your machine. No dependencies, Node 18+, macOS / Linux / Windows. The UI is in French.

```bash
git clone https://github.com/EXOSTE/claude-code-usage-dashboard.git
cd claude-code-usage-dashboard
npm run demo         # try it on fake data, nothing installed
npm run setup        # install: opens http://localhost:4317 and starts at every login
```

`npm run remove` uninstalls the auto-start. Usage history is kept in `~/.claude-tokens-history`, so deleting a session in Claude doesn't erase its stats.

## Licence

MIT
