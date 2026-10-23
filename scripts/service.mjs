#!/usr/bin/env node
// Installe / désinstalle Token Follow comme service lancé à l'ouverture de session.
//   node scripts/service.mjs install [--port 4317] [--no-open]
//   node scripts/service.mjs uninstall
//   node scripts/service.mjs status
// macOS : launchd (relance auto) · Linux : systemd --user, sinon autostart XDG · Windows : dossier Démarrage.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'token-follow';
const LABEL = 'com.token-follow';
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(APP_DIR, 'server.mjs');
const LOG = join(APP_DIR, 'server.log');
const NODE = process.execPath;
const OS = platform();

const args = process.argv.slice(2);
const cmd = args[0];
const flag = name => args.includes(name);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const PORT = Number(opt('--port', process.env.PORT || 4317));
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
  console.error(`✖ Port invalide : « ${opt('--port', process.env.PORT)} ». Choisis un nombre entre 1024 et 65535.`);
  process.exit(1);
}

// Variables transmises au service (PORT + surcharges éventuelles des dossiers).
const ENV = { PORT: String(PORT) };
for (const k of ['CLAUDE_PROJECTS_DIR', 'TOKENS_HISTORY_DIR']) if (process.env[k]) ENV[k] = process.env[k];

const run = (file, argv, opts = {}) => execFileSync(file, argv, { stdio: 'pipe', encoding: 'utf8', ...opts });
const tryRun = (file, argv) => { try { return run(file, argv); } catch { return null; } };
const say = msg => console.log(msg);
const fail = msg => { console.error(`\n✖ ${msg}`); process.exit(1); };

// ---------- macOS ----------
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const uid = () => run('id', ['-u']).trim();
const xml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const mac = {
  install() {
    mkdirSync(dirname(plistPath), { recursive: true });
    const env = Object.entries(ENV).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join('\n');
    writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(NODE)}</string><string>${xml(SERVER)}</string></array>
  <key>WorkingDirectory</key><string>${xml(APP_DIR)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`);
    tryRun('launchctl', ['bootout', `gui/${uid()}/${LABEL}`]); // ancienne version éventuelle
    run('launchctl', ['bootstrap', `gui/${uid()}`, plistPath]);
  },
  uninstall() {
    tryRun('launchctl', ['bootout', `gui/${uid()}/${LABEL}`]);
    rmSync(plistPath, { force: true });
  },
  installed: () => existsSync(plistPath),
  file: () => plistPath,
};

// ---------- Linux ----------
const unitPath = join(homedir(), '.config', 'systemd', 'user', `${NAME}.service`);
const desktopPath = join(homedir(), '.config', 'autostart', `${NAME}.desktop`);
const hasSystemd = () => tryRun('systemctl', ['--user', 'show-environment']) !== null;
const sh = s => `'${s.replace(/'/g, `'\\''`)}'`;
const launcherPath = join(homedir(), '.config', NAME, 'start.sh');
// Spec Desktop Entry : argument entre guillemets, " ` $ \ précédés d'un \, et % doublé.
const desktopQuote = s => `"${s.replace(/["`$\\]/g, '\\$&').replace(/%/g, '%%')}"`;

const linux = {
  install() {
    if (hasSystemd()) {
      mkdirSync(dirname(unitPath), { recursive: true });
      writeFileSync(unitPath, `[Unit]
Description=Token Follow - suivi de la consommation de tokens Claude Code

[Service]
WorkingDirectory=${APP_DIR}
ExecStart="${NODE}" "${SERVER}"
${Object.entries(ENV).map(([k, v]) => `Environment="${k}=${v}"`).join('\n')}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`);
      run('systemctl', ['--user', 'daemon-reload']);
      run('systemctl', ['--user', 'enable', '--now', `${NAME}.service`]);
      tryRun('systemctl', ['--user', 'restart', `${NAME}.service`]);
    } else {
      // Pas de systemd utilisateur : entrée de démarrage auto du bureau + lancement immédiat.
      // La commande vit dans un petit script shell : la ligne Exec du .desktop n'a plus qu'un
      // chemin à citer, selon les règles de la spécification Desktop Entry.
      mkdirSync(dirname(launcherPath), { recursive: true });
      writeFileSync(launcherPath, `#!/bin/sh
cd ${sh(APP_DIR)} || exit 1
${Object.entries(ENV).map(([k, v]) => `export ${k}=${sh(v)}`).join('\n')}
exec ${sh(NODE)} ${sh(SERVER)} >> ${sh(LOG)} 2>&1
`, { mode: 0o755 });
      mkdirSync(dirname(desktopPath), { recursive: true });
      writeFileSync(desktopPath, `[Desktop Entry]
Type=Application
Name=Token Follow
Exec=/bin/sh ${desktopQuote(launcherPath)}
X-GNOME-Autostart-enabled=true
NoDisplay=true
`);
      startDetached();
    }
  },
  uninstall() {
    if (existsSync(unitPath)) {
      tryRun('systemctl', ['--user', 'disable', '--now', `${NAME}.service`]);
      rmSync(unitPath, { force: true });
      tryRun('systemctl', ['--user', 'daemon-reload']);
    }
    if (existsSync(desktopPath)) {
      const port = installedPort(launcherPath);
      rmSync(desktopPath, { force: true });
      rmSync(dirname(launcherPath), { recursive: true, force: true });
      killPort(port);
    }
  },
  installed: () => existsSync(unitPath) || existsSync(desktopPath),
  file: () => existsSync(unitPath) ? unitPath : desktopPath,
};

// ---------- Windows ----------
const startupDir = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const vbsPath = join(startupDir, `${NAME}.vbs`);
const vbq = s => s.replace(/"/g, '""'); // guillemets doublés en VBScript

const windows = {
  install() {
    mkdirSync(startupDir, { recursive: true });
    // Le .vbs lance node sans fenêtre visible à chaque ouverture de session.
    writeFileSync(vbsPath, [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.CurrentDirectory = "${vbq(APP_DIR)}"`,
      ...Object.entries(ENV).map(([k, v]) => `sh.Environment("PROCESS")("${k}") = "${vbq(v)}"`),
      `sh.Run """${vbq(NODE)}"" ""${vbq(SERVER)}""", 0, False`,
      '',
    ].join('\r\n'));
    startDetached();
  },
  uninstall() {
    const port = installedPort(vbsPath);
    rmSync(vbsPath, { force: true });
    killPort(port);
  },
  installed: () => existsSync(vbsPath),
  file: () => vbsPath,
};

// ---------- Commun ----------
function startDetached() {
  spawn(NODE, [SERVER], { cwd: APP_DIR, env: { ...process.env, ...ENV }, detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// Port enregistré dans un fichier de démarrage existant (sinon celui demandé).
function installedPort(file) {
  try { const m = readFileSync(file, 'utf8').match(/PORT\D{1,20}?(\d{2,5})/); return m ? Number(m[1]) : PORT; } catch { return PORT; }
}

// Arrête le serveur qui écoute sur PORT (Windows et Linux sans systemd, qui n'ont pas de gestionnaire de service).
function killPort(port = PORT) {
  let pids = [];
  if (OS === 'win32') {
    const out = tryRun('netstat', ['-ano', '-p', 'TCP']) || '';
    pids = out.split('\n').filter(l => /LISTENING/.test(l) && l.includes(`:${port} `)).map(l => l.trim().split(/\s+/).pop());
    for (const pid of new Set(pids)) tryRun('taskkill', ['/PID', pid, '/F']);
  } else {
    pids = (tryRun('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']) || '').split('\n').filter(Boolean);
    // lsof manque sur beaucoup de distributions Linux : ss (iproute2) est presque toujours là.
    if (!pids.length) pids = [...(tryRun('ss', ['-ltnpH', `sport = :${port}`]) || '').matchAll(/pid=(\d+)/g)].map(m => m[1]);
    for (const pid of new Set(pids)) tryRun('kill', [pid]);
  }
}

const portFree = () => new Promise(ok => {
  const s = createServer().once('error', () => ok(false)).once('listening', () => s.close(() => ok(true)));
  s.listen(PORT, '127.0.0.1');
});

async function waitForServer(seconds = 30, port = PORT) {
  for (let i = 0; i < seconds * 2; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function openBrowser(url) {
  const [file, argv] = OS === 'darwin' ? ['open', [url]] : OS === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(file, argv, { detached: true, stdio: 'ignore' }).unref(); } catch {}
}

const impl = { darwin: mac, linux, win32: windows }[OS];
if (!impl) fail(`Système non pris en charge : ${OS}. Lance simplement « npm start ».`);

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) fail(`Node.js 18 ou plus est requis (version actuelle : ${process.versions.node}).`);

const url = `http://localhost:${PORT}`;

if (cmd === 'install') {
  if (impl.installed()) { say('Ancienne installation trouvée, remplacement…'); impl.uninstall(); await new Promise(r => setTimeout(r, 1000)); }
  if (!(await portFree())) fail(`Le port ${PORT} est déjà utilisé. Choisis-en un autre : npm run setup -- --port 4318`);
  if (!existsSync(join(homedir(), '.claude', 'projects')) && !process.env.CLAUDE_PROJECTS_DIR)
    say('⚠ Aucun dossier ~/.claude/projects : Claude Code n\'a encore jamais été utilisé sur cet ordinateur. Le tableau sera vide pour l\'instant.');
  impl.install();
  say('Démarrage du serveur…');
  if (!(await waitForServer())) fail(`Le service est installé mais ne répond pas sur ${url}. Regarde ${LOG}.`);
  say(`\n✔ Token Follow est installé et démarrera à chaque ouverture de session.\n  Tableau de bord : ${url}\n  Désinstaller : npm run remove`);
  if (!flag('--no-open')) openBrowser(url);
} else if (cmd === 'uninstall') {
  impl.uninstall();
  say(`✔ Service supprimé. L'historique est conservé dans ${process.env.TOKENS_HISTORY_DIR || join(homedir(), '.claude-tokens-history')} (supprime ce dossier toi-même si tu n'en veux plus).`);
} else if (cmd === 'status') {
  // Sans --port explicite, on interroge le port enregistré par l'installation.
  const port = args.includes('--port') || !impl.installed() ? PORT : installedPort(impl.file());
  const up = await waitForServer(1, port);
  say(`Service ${impl.installed() ? 'installé' : 'non installé'} · serveur ${up ? `actif sur http://localhost:${port}` : `arrêté (port ${port})`}`);
} else {
  say('Usage : node scripts/service.mjs install [--port 4317] [--no-open] | uninstall | status');
  process.exit(cmd ? 1 : 0);
}
