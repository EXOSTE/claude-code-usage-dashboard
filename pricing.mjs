// Ce que chaque appel aurait coûté au tarif public de l'API Anthropic (en dollars).
// Ce n'est pas ce que tu paies avec un abonnement : c'est l'équivalent « à l'usage ».
//
// Tarifs en $ par million de tokens, relevés le 2026-10-06 (référence claude-api).
// À revérifier sur https://www.anthropic.com/pricing quand de nouveaux modèles sortent.
//   in / out     : entrée et sortie
//   read         : lecture de cache (≈ 0,1 × l'entrée, mais moins cher sur certains modèles)
// L'écriture de cache vaut 1,25 × l'entrée pour une durée de 5 min et 2 × pour 1 h.
const PRICES = {
  'claude-fable-5-1':  { in: 10,   out: 50,   read: 0.25 },
  'claude-mythos-5-1': { in: 10,   out: 50,   read: 0.25 },
  'claude-fable-5':    { in: 10,   out: 50,   read: 1 },
  'claude-mythos-5':   { in: 10,   out: 50,   read: 1 },
  'claude-opus-5-5':   { in: 4,    out: 20,   read: 0.20 },
  'claude-opus-5':     { in: 5,    out: 25,   read: 0.50 },
  'claude-opus-4-8':   { in: 5,    out: 25,   read: 0.50 },
  'claude-opus-4-7':   { in: 5,    out: 25,   read: 0.50 },
  'claude-opus-4-6':   { in: 5,    out: 25,   read: 0.50 },
  'claude-sonnet-5-5': { in: 2,    out: 10,   read: 0.20 },
  'claude-sonnet-5':   { in: 2,    out: 10,   read: 0.20 },
  'claude-sonnet-4-6': { in: 3,    out: 15,   read: 0.30 },
  // Haiku 5.5 : tarif ×5 au-delà de 100 k tokens de prompt (voir plus bas).
  'claude-haiku-5-5':  { in: 0.10, out: 0.50, read: 0.01, longIn: 0.50, longOut: 2.50, longFrom: 100_000 },
  'claude-haiku-4-5':  { in: 1,    out: 5,    read: 0.10 },
};

// Le mode rapide (« fast ») d'Opus coûte 2 × le tarif standard.
const FAST_MULTIPLIER = 2;

// Les ids peuvent porter un suffixe (date, « [1m] »…) : on prend la clé connue la plus longue
// qui en est le début, pour que « claude-opus-5-5-xxx » ne tombe pas sur « claude-opus-5 ».
const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);
const lookup = model => PRICES[model] ?? PRICES[KEYS.find(k => model.startsWith(k))];

// usage = { input, output, cacheWrite, cacheWrite1h, cacheRead, speed }
export function estimateCost(model, usage) {
  const p = lookup(model);
  if (!p) return null;

  let { in: inRate, out: outRate, read: readRate } = p;
  const promptSize = usage.input + usage.cacheWrite + usage.cacheRead;
  if (p.longFrom && promptSize > p.longFrom) {
    const k = p.longIn / p.in; // le cache suit le même multiplicateur que l'entrée
    inRate = p.longIn; outRate = p.longOut; readRate *= k;
  }

  const write1h = usage.cacheWrite1h ?? 0;
  const write5m = usage.cacheWrite - write1h;
  const dollars = (
    usage.input * inRate +
    usage.output * outRate +
    write5m * inRate * 1.25 +
    write1h * inRate * 2 +
    usage.cacheRead * readRate
  ) / 1e6;

  return usage.speed === 'fast' ? dollars * FAST_MULTIPLIER : dollars;
}
