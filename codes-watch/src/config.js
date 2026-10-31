import fs from 'node:fs';
import path from 'node:path';
import { validateSource } from './sources/index.js';

export const DEFAULTS = {
  checkIntervalMinutes: 10,
  newCodeWindowHours: 48,
  activeScoreThreshold: 2,
  missingChecksBeforeExpired: 3,
  expireAfterMissingHours: 24,
  archiveAfterDays: 90,
  statusRefreshMinutes: 60,
  maxEvents: 300,
  concurrency: 3,
  hostDelayMs: 1500,
  http: { timeoutMs: 15000, retries: 2, userAgent: 'codes-watch/0.1 (+veille de codes cadeaux; respecte robots.txt)' },
  notifications: {
    enabled: false,
    discord: { enabled: false, webhookEnv: 'DISCORD_WEBHOOK_URL' },
    telegram: { enabled: false, tokenEnv: 'TELEGRAM_BOT_TOKEN', chatIdEnv: 'TELEGRAM_CHAT_ID' },
    ntfy: { enabled: false, server: 'https://ntfy.sh', topicEnv: 'NTFY_TOPIC' },
  },
};

const merge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof a[k] === 'object' ? merge(a[k], v) : v;
  return out;
};
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`${file} : ${e.code === 'ENOENT' ? 'fichier introuvable' : 'JSON invalide (' + e.message + ')'}`); }
};

/** Charge et valide la configuration. Une source invalide est écartée (et signalée) sans bloquer les autres. */
export function loadConfig(dir) {
  const settings = merge(DEFAULTS, readJson(path.join(dir, 'settings.json')));
  if (!(settings.checkIntervalMinutes >= 5)) throw new Error('settings.json : checkIntervalMinutes doit être ≥ 5');
  const raw = readJson(path.join(dir, 'games.json'));
  const problems = [];
  const games = [];
  for (const g of raw.games || []) {
    if (!g.id || !/^[a-z0-9][a-z0-9-]*$/.test(g.id) || !g.name) { problems.push(`jeu invalide : ${JSON.stringify(g).slice(0, 80)}`); continue; }
    if (games.some((x) => x.id === g.id)) { problems.push(`jeu en double : ${g.id}`); continue; }
    const sources = [];
    for (const s of g.sources || []) {
      const err = validateSource(s) || (sources.some((x) => x.id === s.id) ? 'id de source en double' : null);
      if (err) problems.push(`${g.id}/${s.id ?? '?'} : ${err}`); else sources.push(s);
    }
    games.push({ enabled: true, notify: true, ...g, sources });
  }
  return { settings, games, problems };
}
