// Estimation des tokens du chat claude.ai à partir de l'export de données
// (claude.ai → Paramètres → Confidentialité → Exporter les données : un .zip contenant conversations.json).
//
// L'export ne contient AUCUN compteur de tokens : on les estime à partir de la longueur des textes.
// Ce qui est estimé, par réponse de Claude :
//   - sortie  = le texte de la réponse (et sa réflexion / ses appels d'outils s'ils sont dans l'export) ;
//   - entrée  = tout l'historique de la conversation renvoyé à chaque tour, pièces jointes extraites comprises.
// Ce qui manque : l'invite système de claude.ai, les fichiers non extraits, la recherche web, le cache.
// Le format n'est pas documenté par Anthropic : la lecture est volontairement tolérante.
//
// Seules les estimations sont gardées (dates, rôles, nombres de tokens) : jamais le texte des messages.
import { inflateRawSync } from 'node:zlib';

// ≈ 3,5 caractères par token : moyenne courante pour du texte en français ou en anglais.
// Une estimation, pas un comptage : l'écart réel peut dépasser 20 %.
export const CHARS_PER_TOKEN = 3.5;
const estimate = chars => Math.ceil(chars / CHARS_PER_TOKEN);

// --- Lecture minimale d'un .zip (sans dépendance) : on n'en extrait que conversations.json ---
export function extractConversations(buf) {
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) return buf; // pas un zip : on suppose du JSON brut
  try { return readZip(buf); }
  catch (err) {
    if (err instanceof RangeError) throw new Error('archive .zip incomplète ou abîmée : retélécharge-la');
    throw err;
  }
}

function readZip(buf) {
  // Fin du répertoire central : signature 0x06054b50, dans les 64 Ko de la fin.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('archive .zip illisible');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (/(^|\/)conversations\.json$/.test(name)) {
      if (size === 0xffffffff) throw new Error('archive .zip trop grande (ZIP64) : décompresse-la et importe conversations.json');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`compression .zip non prise en charge (méthode ${method})`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('conversations.json introuvable dans l\'archive');
}

// Longueur de texte d'une valeur quelconque (chaîne, objet d'outil, liste de blocs).
// La réflexion est comptée à part : claude.ai ne la renvoie pas dans l'historique des tours suivants.
function textLength(v, acc = { text: 0, thinking: 0 }) {
  if (v == null) return acc;
  if (typeof v === 'string') { acc.text += v.length; return acc; }
  if (Array.isArray(v)) { for (const x of v) textLength(x, acc); return acc; }
  if (typeof v === 'object') {
    if (typeof v.thinking === 'string') acc.thinking += v.thinking.length;
    else textLength(v.text ?? v.content ?? (v.input ? JSON.stringify(v.input) : null), acc);
  }
  return acc;
}

function messageChars(m) {
  // Le contenu détaillé (blocs) est plus complet que `text` quand il existe : on ne compte pas les deux.
  const { text, thinking } = Array.isArray(m.content) && m.content.length ? textLength(m.content) : textLength(m.text ?? m.content);
  const attached = [...(m.attachments ?? []), ...(m.files ?? [])].reduce((s, a) => s + textLength(a?.extracted_content).text, 0);
  return { text, thinking, attached };
}

const roleOf = m => {
  const r = String(m.sender ?? m.role ?? '').toLowerCase();
  return r === 'assistant' ? 'assistant' : r === 'human' || r === 'user' ? 'user' : null;
};

// Renvoie des conversations normalisées : { id, title, messages: [{ t, role, input, output }] }.
// Pour une réponse de Claude : output = sa longueur estimée, input = tout l'historique qui la précède.
export function estimateExport(json) {
  let raw;
  try { raw = JSON.parse(json.toString('utf8')); }
  catch { throw new Error('ce fichier n\'est ni le .zip de l\'export claude.ai, ni son conversations.json'); }
  const list = Array.isArray(raw) ? raw : raw.conversations ?? [];
  const out = [];
  for (const c of list) {
    const msgs = c.chat_messages ?? c.messages ?? [];
    if (!Array.isArray(msgs) || !msgs.length) continue;
    // Historique vu par Claude avant chaque message. Quand l'export donne les parents
    // (parent_message_uuid : messages modifiés ou réponses régénérées), on suit la branche du message,
    // sinon on cumule dans l'ordre. Additionner toutes les branches surestimerait l'entrée.
    const branched = msgs.some(m => m?.parent_message_uuid);
    const cum = new Map(); // uuid -> tokens d'historique jusqu'à ce message inclus
    let flat = 0;
    const messages = [];
    for (const m of msgs) {
      const role = roleOf(m);
      if (!role) continue;
      const { text, thinking, attached } = messageChars(m);
      const before = branched ? (cum.get(m.parent_message_uuid) ?? 0) : flat;
      const after = before + estimate(text + attached);
      if (branched && m.uuid) cum.set(m.uuid, after); else flat = after;
      // Un message sans date compte quand même dans l'historique ; seul le relevé daté est omis.
      const t = Date.parse(m.created_at ?? m.timestamp ?? m.updated_at ?? c.updated_at ?? c.created_at ?? '');
      if (!Number.isFinite(t)) continue;
      messages.push(role === 'assistant'
        ? { t, role, input: before, output: estimate(text + thinking) }
        : { t, role, input: 0, output: 0 });
    }
    if (!messages.length) continue;
    const title = String(c.name ?? c.title ?? '') || null;
    // Sans identifiant dans l'export, titre + date du premier message restent stables d'un export à l'autre.
    const id = String(c.uuid ?? c.id ?? `${title ?? ''}|${messages[0].t}`);
    out.push({ id, title, messages });
  }
  return out;
}
