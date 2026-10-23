#!/usr/bin/env node
// Lance le tableau de bord sur des données fictives, sans rien installer ni lire tes journaux.
//   npm run demo [-- --port 4318] [-- --no-open]
// Les journaux inventés (60 jours, quelques projets) vont dans un dossier temporaire, recréé à chaque lancement.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateExport } from '../chat-export.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const i = args.indexOf('--port');
const PORT = Number(i >= 0 ? args[i + 1] : 4318);
const DIR = join(tmpdir(), 'token-follow-demo');
const PROJECTS = join(DIR, 'projects'), HISTORY = join(DIR, 'history');
const COWORK = join(DIR, 'cowork'), PLAN = join(DIR, 'plan-usage-history.json');

// Générateur pseudo-aléatoire à graine fixe : la démo est la même à chaque lancement.
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const int = (a, b) => Math.floor(a + rnd() * (b - a + 1));
const pick = weighted => { let r = rnd() * weighted.reduce((s, [, w]) => s + w, 0); for (const [v, w] of weighted) if ((r -= w) < 0) return v; return weighted[0][0]; };
const uuid = () => 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => int(0, 15).toString(16));

const projects = [
  ['boutique-en-ligne', 5, ['Panier : corriger le calcul de la TVA', 'Page produit plus rapide', 'Paiement en trois fois', 'Tests du tunnel de commande']],
  ['api-reservations', 4, ['Ajouter la pagination', 'Migration vers Postgres 17', 'Limiter les requêtes par client', 'Webhooks de confirmation']],
  ['app-mobile', 3, ['Mode hors ligne', 'Notifications push', 'Écran de profil']],
  ['site-vitrine', 2, ['Refonte de l\'accueil', 'Formulaire de contact accessible']],
  ['scripts-data', 1, ['Export mensuel des ventes', 'Nettoyer les doublons clients']],
];
const coworkTitles = ['Synthèse des retours clients', 'Préparer le comité du lundi', 'Tableau des dépenses du trimestre', 'Trier la boîte de réception'];
const models = [['claude-opus-5-5', 55], ['claude-sonnet-5-5', 30], ['claude-haiku-5-5', 10], ['claude-fable-5-1', 5]];

rmSync(DIR, { recursive: true, force: true });
mkdirSync(HISTORY, { recursive: true });

const now = Date.now(), DAY = 86400_000;
let calls = 0;
for (let d = 59; d >= 0; d--) {
  const day = new Date(now - d * DAY);
  const weekend = [0, 6].includes(day.getDay());
  const sessions = weekend ? int(0, 1) : int(1, 4);
  for (let s = 0; s < sessions; s++) {
    const [name, , titles] = pick(projects.map(p => [p, p[1]]));
    const id = uuid(), cwd = `/home/demo/code/${name}`;
    const lines = [JSON.stringify({ type: 'ai-title', aiTitle: titles[int(0, titles.length - 1)], sessionId: id })];
    let t = new Date(day); t.setHours(int(weekend ? 10 : 8, 19), int(0, 59), 0, 0);
    const model = pick(models);
    for (let c = 0, n = int(15, 110); c < n; c++) {
      t = new Date(t.getTime() + int(10, 150) * 1000);
      if (t.getTime() > now) break;
      const side = rnd() < 0.15;
      lines.push(JSON.stringify({
        type: 'assistant', sessionId: id, cwd, isSidechain: side, timestamp: t.toISOString(),
        requestId: `req_demo_${++calls}`,
        message: {
          id: `msg_demo_${calls}`, role: 'assistant', model: side ? 'claude-haiku-5-5' : model,
          usage: {
            input_tokens: int(2, 60), output_tokens: int(80, 2800),
            cache_creation_input_tokens: int(300, 9000), cache_read_input_tokens: int(15_000, 160_000),
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
          },
        },
      }));
    }
    // Une session sur six est une session Cowork : même format, rangée comme le fait Claude Desktop.
    if (rnd() < 1 / 6) {
      const local = `local_${uuid()}`, base = join(COWORK, 'org-demo', 'user-demo');
      const dir = join(base, local, '.claude', 'projects', '-sessions-demo');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.jsonl`), lines.slice(1).join('\n') + '\n');
      writeFileSync(join(base, `${local}.json`), JSON.stringify({ sessionId: local, cliSessionId: id, title: coworkTitles[int(0, coworkTitles.length - 1)] }));
      continue;
    }
    const dir = join(PROJECTS, `-home-demo-code-${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), lines.join('\n') + '\n');
  }
}
// Relevés du forfait comme ceux de Claude Desktop : toutes les 30 min en journée, avec la fenêtre
// de 5 h qui monte puis retombe, et la limite de 7 jours qui grimpe lentement chaque semaine.
const samples = [];
for (let t = now - 30 * DAY; t <= now; t += 1800_000) {
  const d = new Date(t), h = d.getHours();
  if (h < 8 || h > 20) continue;
  const week = (d.getDay() + 6) % 7;
  samples.push({ t, org: 'org-demo', u: { fh: Math.min(100, ((h - 8) % 5) * int(8, 22)), sd: Math.min(100, week * 12 + int(0, 8)) } });
}
writeFileSync(PLAN, JSON.stringify({ version: 2, samples }));

// Conversations du chat claude.ai, au format de l'export, déjà « importées » dans l'historique de la démo.
const chatTitles = ['Idées de menus pour la semaine', 'Relire ma lettre de motivation', 'Expliquer les intérêts composés',
  'Plan de voyage à Lisbonne', 'Traduire un contrat en anglais', 'Résumer un article de recherche', 'Préparer un entretien'];
const conversations = [];
for (let d = 44; d >= 0; d--) {
  for (let k = 0, n = int(0, 3); k < n; k++) {
    let t = now - d * DAY - int(1, 10) * 3600_000;
    const chat_messages = [];
    for (let turn = 0, turns = int(2, 12); turn < turns && t < now; turn++) {
      chat_messages.push({ sender: 'human', text: 'q'.repeat(int(40, 900)), created_at: new Date(t).toISOString() });
      t += int(20, 90) * 1000;
      chat_messages.push({ sender: 'assistant', text: 'r'.repeat(int(300, 6000)), created_at: new Date(t).toISOString() });
      t += int(60, 600) * 1000;
    }
    conversations.push({ uuid: uuid(), name: chatTitles[int(0, chatTitles.length - 1)], chat_messages });
  }
}
writeFileSync(join(HISTORY, 'chat.json'), JSON.stringify({ importedAt: now, conversations: estimateExport(Buffer.from(JSON.stringify(conversations))) }));
console.log(`Démo : ${calls} appels fictifs sur 60 jours (Claude Code + Cowork), ${samples.length} relevés de forfait et ${conversations.length} conversations de chat, dans ${DIR}`);

const server = spawn(process.execPath, [join(APP_DIR, 'server.mjs')], {
  cwd: APP_DIR, stdio: 'inherit',
  env: { ...process.env, PORT: String(PORT), CLAUDE_PROJECTS_DIR: PROJECTS, TOKENS_HISTORY_DIR: HISTORY,
    COWORK_SESSIONS_DIR: COWORK, CLAUDE_PLAN_USAGE_FILE: PLAN },
});
server.on('exit', code => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));

if (!args.includes('--no-open')) setTimeout(() => {
  const url = `http://localhost:${PORT}`;
  const [file, argv] = platform() === 'darwin' ? ['open', [url]] : platform() === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(file, argv, { detached: true, stdio: 'ignore' }).unref(); } catch {}
}, 800);
