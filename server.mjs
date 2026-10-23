// Tableau de bord local de consommation de tokens Claude Code.
// Lit les journaux de session dans ~/.claude/projects/**/*.jsonl, aucune dépendance.
// Lancement : node server.mjs   puis http://localhost:4317
//
// Supprimer une session dans l'app efface aussi son journal. Pour ne pas perdre ses stats,
// le serveur recopie chaque appel vu dans un historique à lui (HISTORY_DIR, hors de ~/.claude).
// Les appels qui ne sont plus dans les journaux restent comptés, marqués « archived ».
//
// Cowork (mode agent de Claude Desktop) écrit, pour une session locale, un journal au même format
// sous <données de l'app Claude>/local-agent-mode-sessions : il est lu aussi, avec source « cowork ».
// Une session Cowork exécutée dans le cloud ne laisse rien sur le disque : seule la courbe
// d'utilisation du forfait (plan-usage-history.json, relevée par l'app) en garde une trace.
import { createServer } from 'node:http';
import { readdir, readFile, stat, appendFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
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
const PLAN_ARCHIVE = join(HISTORY_DIR, 'plan.jsonl');    // relevés du forfait, en ajout seulement

// Dossier de données de l'app Claude Desktop, selon le système.
const APP_DATA = process.env.CLAUDE_APP_DIR || (
  platform() === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'Claude')
  : platform() === 'win32' ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude')
  : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Claude'));
const COWORK_ROOT = process.env.COWORK_SESSIONS_DIR || join(APP_DATA, 'local-agent-mode-sessions');
const PLAN_FILE = process.env.CLAUDE_PLAN_USAGE_FILE || join(APP_DATA, 'plan-usage-history.json');
// Nom de « projet » des sessions Cowork, choisi pour ne pas se confondre avec un dossier nommé Cowork.
const COWORK_PROJECT = 'Cowork (Claude Desktop)';

// Cache par fichier : on ne relit un .jsonl que si sa taille ou sa date a changé.
const fileCache = new Map(); // path -> { key, entries, titles }

async function walk(dir, keep = name => name.endsWith('.jsonl')) {
  const out = [];
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await walk(p, keep)));
    else if (keep(d.name)) out.push(p);
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

// Champs dont le nom varie selon l'outil qui a écrit le journal (Claude Code ou Cowork).
const sessionOf = (r, fallback) => r.sessionId ?? r.session_id ?? fallback;
const timeOf = r => Date.parse(r.timestamp ?? r._audit_timestamp ?? r.created_at ?? '');

function parseFile(text, fileSession, source = 'code', fileTime = Date.now()) {
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
      const t = (titles[sessionOf(r, fileSession)] ??= {});
      if (r.customTitle) t.custom = r.customTitle;
      if (r.aiTitle) t.ai = r.aiTitle;
      continue;
    }
    const m = r.message;
    // Cowork n'écrit pas toujours `type` : on se fie alors au rôle du message, mais seulement pour lui.
    const isAssistant = r.type === 'assistant' || (source === 'cowork' && m?.role === 'assistant');
    if (!isAssistant || !m?.usage || m.model === '<synthetic>') continue;
    const u = m.usage;
    const session = sessionOf(r, fileSession);
    const t = timeOf(r);
    entries.push({
      // Un même message API est écrit sur plusieurs lignes (une par bloc de contenu)
      // avec la même usage : on dédoublonne par id de message + requête.
      // Cowork peut écrire le même message deux fois (copie d'audit + transcription) : même clé,
      // donc dédoublonné, et keepMax garde la copie au compteur le plus complet.
      key: `${m.id}:${r.requestId ?? r.request_id ?? ''}`,
      // Sans date lisible, l'appel est placé à la date du fichier, et signalé (undated) sur la page.
      t: Number.isFinite(t) ? t : fileTime,
      ...(Number.isFinite(t) ? {} : { undated: true }),
      model: m.model,
      // Le cwd d'une session Cowork est un dossier de sa machine virtuelle : il ne dit rien d'utile.
      project: source === 'cowork' ? COWORK_PROJECT : (sessionProject[session] ??= projectName(r.cwd)),
      session,
      source,
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

// Fichiers Cowork utiles : les transcriptions (…/.claude/projects/…/*.jsonl), la copie d'audit
// (audit.jsonl) et les fiches de session (local_<id>.json). Le reste du dossier contient des plugins,
// dont des fichiers de test qu'il ne faut surtout pas compter comme de la consommation.
const isCoworkLog = f => { const p = f.replace(/\\/g, '/'); return p.includes('/.claude/projects/') || p.endsWith('/audit.jsonl'); };
const isCoworkCard = name => /^local_.+\.json$/.test(name);

// Titres des sessions Cowork : la fiche local_<id>.json relie le titre à l'identifiant de la
// transcription (cliSessionId, plus les anciens en cas de reprise) et à local_<id> lui-même,
// qui sert d'identifiant aux lignes d'audit sans session_id. Relue seulement si elle a changé.
const cardCache = new Map(); // path -> { key, titles, alias }
// Renvoie les titres, et `alias` : local_<id> -> cliSessionId, pour ranger les lignes d'audit
// dans la même session que leur transcription.
async function coworkTitles(cards) {
  const titles = {}, alias = {};
  for (const f of cards) {
    const s = await stat(f).catch(() => null);
    if (!s) continue;
    const key = `${s.size}:${s.mtimeMs}`;
    let c = cardCache.get(f);
    if (!c || c.key !== key) {
      c = { key, titles: {}, alias: {} };
      try {
        const o = JSON.parse(await readFile(f, 'utf8'));
        if (o.cliSessionId) for (const id of [o.sessionId, basename(f, '.json')]) if (id) c.alias[id] = o.cliSessionId;
        if (o.title) for (const id of [o.cliSessionId, o.sessionId, basename(f, '.json'), ...(o.priorCliSessionIds ?? [])])
          if (id) c.titles[id] = { custom: o.title };
      } catch { c.key = null; } // fiche en cours d'écriture : on la relira au prochain balayage
      cardCache.set(f, c);
    }
    Object.assign(titles, c.titles);
    Object.assign(alias, c.alias);
  }
  for (const f of cardCache.keys()) if (!cards.includes(f)) cardCache.delete(f);
  return { titles, alias };
}

// --- Utilisation du forfait (tous produits Claude, Cowork compris) ---
// L'app Claude Desktop relève régulièrement le % utilisé des limites de 5 h (fh) et de 7 jours (sd),
// mais ne garde qu'environ 30 jours : on archive chaque relevé pour ne rien perdre.
const plan = new Map(); // `${org}:${t}` -> { t, org, fh, sd }
let planLoaded = false;

async function refreshPlan() {
  if (!planLoaded) {
    const text = await readFile(PLAN_ARCHIVE, 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      try { const p = JSON.parse(line); plan.set(`${p.org}:${p.t}`, p); } catch {}
    }
    planLoaded = true;
  }
  let samples = [];
  try { samples = JSON.parse(await readFile(PLAN_FILE, 'utf8')).samples ?? []; }
  catch { return; } // pas d'app Claude Desktop ici, ou fichier en cours d'écriture
  const fresh = [];
  for (const s of samples) {
    if (!Number.isFinite(s?.t) || !s.u) continue;
    const p = { t: s.t, org: s.org ?? '', fh: s.u.fh ?? null, sd: s.u.sd ?? null };
    if (!plan.has(`${p.org}:${p.t}`)) fresh.push(p);
  }
  if (fresh.length) await appendFile(PLAN_ARCHIVE, fresh.map(p => JSON.stringify(p)).join('\n') + '\n');
  for (const p of fresh) plan.set(`${p.org}:${p.t}`, p);
}

// Relevés de la période, pour l'organisation du relevé le plus récent (un compte = une courbe).
function planSummary(since) {
  const all = [...plan.values()].sort((a, b) => a.t - b.t);
  if (!all.length) return { available: false, samples: [] };
  const org = all.at(-1).org;
  const mine = all.filter(p => p.org === org);
  const samples = mine.filter(p => p.t >= since).map(({ t, fh, sd }) => ({ t, fh, sd }));
  return { available: true, samples, current: mine.at(-1), first: mine[0].t };
}

// Plusieurs requêtes simultanées partagent le même balayage au lieu d'en lancer un chacune.
function refresh() {
  return (inflight ??= (async () => {
    await loadHistory();
    const codeFiles = await walk(ROOT);
    const coworkAll = await walk(COWORK_ROOT, name => name.endsWith('.jsonl') || isCoworkCard(name));
    const coworkFiles = coworkAll.filter(f => f.endsWith('.jsonl') && isCoworkLog(f));
    const files = [...codeFiles, ...coworkFiles];
    const isCowork = new Set(coworkFiles);
    const { titles, alias } = await coworkTitles(coworkAll.filter(f => f.endsWith('.json')));
    const byKey = new Map();
    for (const f of files) {
      const s = await stat(f).catch(() => null);
      if (!s) continue;
      const key = `${s.size}:${s.mtimeMs}`;
      let c = fileCache.get(f);
      if (!c || c.key !== key) {
        const source = isCowork.has(f) ? 'cowork' : 'code';
        // audit.jsonl est rangé dans le dossier local_<id> de sa session : c'est son identifiant par défaut.
        const fileSession = basename(f) === 'audit.jsonl' ? basename(dirname(f)) : basename(f, '.jsonl');
        c = { key, ...parseFile(await readFile(f, 'utf8'), fileSession, source, s.mtimeMs) };
        fileCache.set(f, c);
      }
      for (const [id, t] of Object.entries(c.titles)) Object.assign(titles[id] ??= {}, t);
      // Pendant le streaming, les premières lignes d'un message portent un compteur provisoire :
      // on garde la version la plus complète (la plus grande).
      for (const e of c.entries) {
        if (e.source === 'cowork' && alias[e.session]) e.session = alias[e.session];
        keepMax(byKey, e);
      }
    }
    // Journaux supprimés : leurs appels vivent désormais dans l'historique, inutile de les garder ici.
    const present = new Set(files);
    for (const f of fileCache.keys()) if (!present.has(f)) fileCache.delete(f);
    const added = await saveToHistory(byKey.values(), titles);
    if (added) console.log(`Historique : ${added} appels ajoutés`);
    // Le forfait est accessoire : son échec ne doit pas faire tomber le tableau des tokens.
    await refreshPlan().catch(err => console.error('Forfait :', err));
    // Vue finale = tout l'historique ; ce qui n'est plus dans les journaux est « archived ».
    const entries = [...history.values()].map(e => byKey.has(e.key) ? e : { ...e, archived: true });
    snapshot = { entries, titles: { ...historyTitles, ...titles }, scannedAt: Date.now() };
    return snapshot;
  })().finally(() => { inflight = null; }));
}

const blank = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, calls: 0, sideCalls: 0, archivedCalls: 0, archivedTokens: 0,
  undatedCalls: 0, coworkBillable: 0, cost: 0, costKnown: true });
function add(acc, e) {
  acc.input += e.input; acc.output += e.output;
  acc.cacheWrite += e.cacheWrite; acc.cacheRead += e.cacheRead;
  acc.calls++;
  if (e.sidechain) acc.sideCalls++;
  if (e.archived) { acc.archivedCalls++; acc.archivedTokens += total(e); }
  if (e.undated) acc.undatedCalls++;
  if (e.source === 'cowork') acc.coworkBillable += e.input + e.output + e.cacheWrite;
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
  const byDay = {}, byModel = {}, byProject = {}, bySession = {}, bySource = { code: blank(), cowork: blank() };
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0)); // [lundi..dimanche][heure]

  for (const e of entries) {
    if (e.t < prevSince) continue;
    if (e.t < since) { if (inScope(e)) add(previous, e); continue; }
    // La liste des projets reste complète même filtrée, pour pouvoir changer de projet.
    add(byProject[e.project] ??= blank(), e);
    if (!inScope(e)) continue;
    add(total, e);
    add(bySource[e.source ?? 'code'], e); // les appels archivés avant l'ajout de Cowork n'ont pas de source
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
    days, project: project || null, total, previous, sources: bySource, plan: planSummary(since),
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
