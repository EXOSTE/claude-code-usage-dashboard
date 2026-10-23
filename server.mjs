// Tableau de bord local de consommation de tokens Claude Code.
// Lit les journaux de session dans ~/.claude/projects/**/*.jsonl, aucune dépendance.
// Lancement : node server.mjs   puis http://localhost:4317
//
// Supprimer une session dans l'app efface aussi son journal. Pour ne pas perdre ses stats,
// le serveur recopie chaque appel vu dans un historique à lui (HISTORY_DIR, hors de ~/.claude).
// Les appels qui ne sont plus dans les journaux restent comptés, marqués « archived ».
import { createServer } from 'node:http';
import { readdir, readFile, stat, appendFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateCost } from './pricing.mjs';

const PORT = Number(process.env.PORT) || 4317;
const ROOT = process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects');
const HERE = dirname(fileURLToPath(import.meta.url));
const DAY = 86400_000;
const HISTORY_DIR = process.env.TOKENS_HISTORY_DIR || join(homedir(), '.claude-tokens-history');
const CALLS_FILE = join(HISTORY_DIR, 'calls.jsonl');   // un appel par ligne, en ajout seulement
const TITLES_FILE = join(HISTORY_DIR, 'titles.json');  // titres de session, réécrit en entier

// Cache par fichier : on ne relit un .jsonl que si sa taille ou sa date a changé.
const fileCache = new Map(); // path -> { key, entries, titles }

async function walk(dir) {
  const out = [];
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await walk(p)));
    else if (d.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function projectName(cwd) {
  if (!cwd) return 'inconnu';
  // Sous Windows, le cwd utilise des « \ » : on normalise avant de découper.
  const p = cwd.replace(/\\/g, '/');
  if (p.includes('/scratch-workspaces/')) return '(sessions sans dossier)';
  return p.split('/.claude/worktrees/')[0].split('/').filter(Boolean).pop() ?? cwd;
}

function parseFile(text, fileSession) {
  const entries = [];
  const titles = {}; // sessionId -> { custom, ai }
  // Le projet d'une session = le dossier où elle a été lancée. Le cwd des lignes suivantes
  // change dès que Claude fait un `cd` dans un sous-dossier (src, lib…), on ne le suit donc pas.
  const sessionProject = {};
  for (const line of text.split('\n')) {
    const isUsage = line.includes('"usage"');
    const isTitle = !isUsage && line.includes('-title"');
    if (!isUsage && !isTitle) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type === 'custom-title' || r.type === 'ai-title') {
      const t = (titles[r.sessionId ?? fileSession] ??= {});
      if (r.customTitle) t.custom = r.customTitle;
      if (r.aiTitle) t.ai = r.aiTitle;
      continue;
    }
    const m = r.message;
    if (r.type !== 'assistant' || !m?.usage || m.model === '<synthetic>') continue;
    const u = m.usage;
    entries.push({
      // Un même message API est écrit sur plusieurs lignes (une par bloc de contenu)
      // avec la même usage : on dédoublonne par id de message + requête.
      key: `${m.id}:${r.requestId ?? ''}`,
      t: Date.parse(r.timestamp),
      model: m.model,
      project: (sessionProject[r.sessionId ?? fileSession] ??= projectName(r.cwd)),
      session: r.sessionId ?? fileSession,
      sidechain: !!r.isSidechain,
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      // Part de l'écriture de cache à 1 h (facturée 2 × l'entrée au lieu de 1,25 × pour 5 min).
      cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      speed: u.speed ?? 'standard',
    });
  }
  return { entries, titles };
}

const total = e => e.input + e.output + e.cacheWrite + e.cacheRead;

// Un même appel peut être vu plusieurs fois (lignes de streaming, historique) :
// on garde la version la plus complète. Renvoie true si `e` a remplacé l'existant.
function keepMax(map, e) {
  const prev = map.get(e.key);
  if (prev && total(prev) >= total(e)) return false;
  map.set(e.key, e);
  return true;
}

let snapshot = { entries: [], titles: {}, scannedAt: 0 };
let inflight = null;

// --- Historique permanent ---
const history = new Map();   // key -> entrée, telle qu'enregistrée
let historyTitles = {};
let historyLoaded = null;

function loadHistory() {
  historyLoaded ??= (async () => {
    await mkdir(HISTORY_DIR, { recursive: true });
    const text = await readFile(CALLS_FILE, 'utf8').catch(() => '');
    let lines = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      lines++;
      let e;
      try { e = JSON.parse(line); } catch { continue; } // ligne tronquée par un arrêt brutal
      keepMax(history, e);
    }
    // Les versions intermédiaires d'un même appel s'accumulent : on réécrit le fichier
    // compacté (temporaire puis renommage) quand plus d'un quart des lignes sont périmées.
    if (lines > history.size * 1.25) {
      await writeFile(CALLS_FILE + '.tmp', [...history.values()].map(e => JSON.stringify(e)).join('\n') + '\n');
      await rename(CALLS_FILE + '.tmp', CALLS_FILE);
      console.log(`Historique compacté : ${lines} → ${history.size} lignes`);
    }
    try { historyTitles = JSON.parse(await readFile(TITLES_FILE, 'utf8')); }
    catch { historyTitles = {}; } // absent ou corrompu : les titres se reconstruisent au balayage
    console.log(`Historique : ${history.size} appels chargés depuis ${HISTORY_DIR}`);
  })();
  // Un échec n'est pas mémorisé : le prochain balayage réessaiera au lieu d'échouer pour toujours.
  return historyLoaded.catch(err => { historyLoaded = null; history.clear(); throw err; });
}

// Ajoute à l'historique les appels nouveaux (ou dont le compteur a grandi), puis les titres.
async function saveToHistory(live, titles) {
  const fresh = [];
  for (const e of live) {
    const prev = history.get(e.key);
    if (!prev || total(e) > total(prev)) fresh.push(e);
  }
  // On n'inscrit dans la Map qu'après l'écriture réussie : si le disque refuse,
  // ces appels seront retentés au prochain balayage au lieu d'être crus enregistrés.
  if (fresh.length) await appendFile(CALLS_FILE, fresh.map(e => JSON.stringify(e)).join('\n') + '\n');
  for (const e of fresh) history.set(e.key, e);

  let changed = false;
  for (const [id, t] of Object.entries(titles)) {
    const h = (historyTitles[id] ??= {});
    for (const k of ['custom', 'ai']) if (t[k] && h[k] !== t[k]) { h[k] = t[k]; changed = true; }
  }
  if (changed) {
    // Écriture dans un fichier temporaire puis renommage : jamais de titres.json à moitié écrit.
    await writeFile(TITLES_FILE + '.tmp', JSON.stringify(historyTitles));
    await rename(TITLES_FILE + '.tmp', TITLES_FILE);
  }
  return fresh.length;
}

// Plusieurs requêtes simultanées partagent le même balayage au lieu d'en lancer un chacune.
function refresh() {
  return (inflight ??= (async () => {
    await loadHistory();
    const files = await walk(ROOT);
    const byKey = new Map(), titles = {};
    for (const f of files) {
      const s = await stat(f).catch(() => null);
      if (!s) continue;
      const key = `${s.size}:${s.mtimeMs}`;
      let c = fileCache.get(f);
      if (!c || c.key !== key) {
        c = { key, ...parseFile(await readFile(f, 'utf8'), basename(f, '.jsonl')) };
        fileCache.set(f, c);
      }
      for (const [id, t] of Object.entries(c.titles)) Object.assign(titles[id] ??= {}, t);
      // Pendant le streaming, les premières lignes d'un message portent un compteur provisoire :
      // on garde la version la plus complète (la plus grande).
      for (const e of c.entries) keepMax(byKey, e);
    }
    // Journaux supprimés : leurs appels vivent désormais dans l'historique, inutile de les garder ici.
    const present = new Set(files);
    for (const f of fileCache.keys()) if (!present.has(f)) fileCache.delete(f);
    const added = await saveToHistory(byKey.values(), titles);
    if (added) console.log(`Historique : ${added} appels ajoutés`);
    // Vue finale = tout l'historique ; ce qui n'est plus dans les journaux est « archived ».
    const entries = [...history.values()].map(e => byKey.has(e.key) ? e : { ...e, archived: true });
    snapshot = { entries, titles: { ...historyTitles, ...titles }, scannedAt: Date.now() };
    return snapshot;
  })().finally(() => { inflight = null; }));
}

const blank = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, calls: 0, sideCalls: 0, archivedCalls: 0, archivedTokens: 0, cost: 0, costKnown: true });
function add(acc, e) {
  acc.input += e.input; acc.output += e.output;
  acc.cacheWrite += e.cacheWrite; acc.cacheRead += e.cacheRead;
  acc.calls++;
  if (e.sidechain) acc.sideCalls++;
  if (e.archived) { acc.archivedCalls++; acc.archivedTokens += total(e); }
  const c = estimateCost(e.model, e);
  if (c == null) acc.costKnown = false; else acc.cost += c;
}

function localDay(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const billable = r => r.input + r.output + r.cacheWrite;

function summary({ entries, titles, scannedAt }, days, project) {
  const now = Date.now(), since = now - days * DAY, prevSince = since - days * DAY;
  const inScope = e => !project || e.project === project;

  const total = blank(), previous = blank();
  const byDay = {}, byModel = {}, byProject = {}, bySession = {};
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0)); // [lundi..dimanche][heure]

  for (const e of entries) {
    if (e.t < prevSince) continue;
    if (e.t < since) { if (inScope(e)) add(previous, e); continue; }
    // La liste des projets reste complète même filtrée, pour pouvoir changer de projet.
    add(byProject[e.project] ??= blank(), e);
    if (!inScope(e)) continue;
    add(total, e);
    add(byDay[localDay(e.t)] ??= blank(), e);
    add(byModel[e.model] ??= blank(), e);
    const s = (bySession[e.session] ??= { ...blank(), project: e.project, first: e.t, last: e.t });
    add(s, e);
    s.first = Math.min(s.first, e.t); s.last = Math.max(s.last, e.t);
    const d = new Date(e.t);
    heat[(d.getDay() + 6) % 7][d.getHours()] += billable(e);
  }

  // Remplit les jours sans activité pour que le graphique ait un axe continu.
  const daily = [];
  for (let t = since; t <= now; t += DAY) {
    const k = localDay(t);
    if (!daily.length || daily.at(-1).day !== k) daily.push({ day: k, ...(byDay[k] ?? blank()) });
  }
  if (daily.at(-1).day !== localDay(now)) daily.push({ day: localDay(now), ...(byDay[localDay(now)] ?? blank()) });

  const rank = o => Object.entries(o).map(([name, v]) => ({ name, ...v })).sort((a, b) => billable(b) - billable(a));
  const sessions = rank(bySession);
  const topSessions = sessions.slice(0, 15).map(s => ({
    ...s, title: titles[s.name]?.custom ?? titles[s.name]?.ai ?? null,
  }));

  return {
    days, project: project || null, total, previous,
    sessions: sessions.length, daily, heat,
    models: rank(byModel), projects: rank(byProject), topSessions,
    generatedAt: new Date(scannedAt).toISOString(),
  };
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/usage') {
      // « all » = depuis le premier appel présent dans les journaux.
      const all = url.searchParams.get('days') === 'all';
      const snapNow = Date.now() - snapshot.scannedAt < 30_000 ? snapshot : await refresh();
      const oldest = snapNow.entries.reduce((m, e) => Math.min(m, e.t), Date.now());
      const days = all ? Math.max(1, Math.ceil((Date.now() - oldest) / DAY)) + 1
        : Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365);
      const project = url.searchParams.get('project') || '';
      return send(res, 200, 'application/json', JSON.stringify({ ...summary(snapNow, days, project), all, oldest }));
    }
    if (url.pathname === '/') {
      return send(res, 200, 'text/html; charset=utf-8', await readFile(join(HERE, 'index.html')));
    }
    send(res, 404, 'text/plain', 'Introuvable');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'text/plain', String(err));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Tableau de bord : http://localhost:${PORT}`);
  // Préchargement au démarrage : la première visite n'attend plus le balayage complet.
  const t0 = Date.now();
  refresh()
    .then(s => console.log(`${s.entries.length} appels indexés en ${Date.now() - t0} ms`))
    .catch(err => console.error('Premier balayage :', err)); // le suivant réessaiera
  // Balayage régulier même sans visiteur : un appel doit entrer dans l'historique avant
  // que sa session puisse être supprimée, que la page soit ouverte ou non.
  setInterval(() => refresh().catch(err => console.error('Balayage :', err)), 5 * 60_000);
});
