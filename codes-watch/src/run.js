import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { loadDb, saveDb, saveStatus } from './store.js';
import { httpGet } from './http.js';
import { RobotsChecker } from './robots.js';
import { fetchSource, TYPES } from './sources/index.js';
import { integrateSource, recomputeAll, isDue, sourceKey } from './engine.js';
import { buildMessages, sendNotifications } from './notify.js';
import { iso, sleep, log } from './util.js';

const healthy = (st) => !!st && st.ok !== false && (st.consecutiveFailures || 0) < 3 && !st.suspect;

export async function runOnce(opts = {}) {
  const root = opts.root || process.cwd();
  const configDir = opts.configDir || path.join(root, 'config');
  const dataDir = opts.dataDir || path.join(root, 'site', 'data');
  const runtimeDir = opts.runtimeDir || path.join(root, '.runtime');
  const env = opts.env || process.env;
  const now = opts.now || Date.now();
  const force = opts.force ?? env.FORCE === '1';
  const dry = opts.dry ?? env.DRY_RUN === '1';

  const { settings, games, problems } = loadConfig(configDir);
  problems.forEach((p) => log('WARN', `configuration ignorée : ${p}`));
  const db = loadDb(dataDir);
  const before = JSON.stringify(sigOf(db.sources));
  let lastChecks = {};
  try { lastChecks = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'lastcheck.json'), 'utf8')); } catch { /* premier passage */ }

  const get = (url, o) => httpGet(url, { ...settings.http, ...o });
  const robots = new RobotsChecker((u) => get(u, { retries: 0, timeoutMs: 8000 }), 'codes-watch');
  const ctx = { get, robots, now };

  // 1) quelles sources sont à interroger maintenant ?
  const tasks = [];
  for (const g of games.filter((x) => x.enabled)) {
    for (const s of g.sources.filter((x) => x.enabled !== false)) {
      const key = sourceKey(g.id, s.id);
      const interval = Math.max(5, s.intervalMinutes ?? settings.checkIntervalMinutes);
      const st = (db.sources[key] ||= {});
      Object.assign(st, { gameId: g.id, sourceId: s.id, type: s.type, trust: s.trust || 'medium' });
      if (isDue(lastChecks[key], interval, now, force)) tasks.push({ g, s, key, st });
    }
  }

  // 2) interrogation (en parallèle, avec une pause entre deux requêtes vers le même site)
  const chains = new Map();
  const results = [];
  const runTask = (t) => {
    const host = new URL(t.s.url || 'https://x.invalid').host;
    const prev = chains.get(host) || Promise.resolve();
    const p = prev.then(async () => {
      let out;
      try { out = { ...t, res: await fetchSource(t.s, ctx) }; } catch (e) { out = { ...t, err: e }; }
      await sleep(settings.hostDelayMs);
      return out;
    });
    chains.set(host, p.catch(() => {}));
    return p;
  };
  const queue = [...tasks];
  await Promise.all(Array.from({ length: Math.min(settings.concurrency, queue.length) }, async () => {
    while (queue.length) results.push(await runTask(queue.shift()));
  }));

  // 3) intégration des résultats (une source en erreur n'empêche jamais les autres)
  const events = [];
  for (const r of results) {
    const { g, s, key, st } = r;
    st.lastCheck = iso(now);
    lastChecks[key] = iso(now);
    if (r.err) {
      st.ok = false;
      st.consecutiveFailures = (st.consecutiveFailures || 0) + 1;
      st.lastError = String(r.err.message || r.err).slice(0, 200);
      log('ERROR', `${key} : ${st.lastError} (échecs consécutifs : ${st.consecutiveFailures})`);
      if (st.consecutiveFailures === 3) events.push({ at: iso(now), type: 'source_down', gameId: g.id, source: s.id, reason: st.lastError });
      continue;
    }
    if (st.consecutiveFailures >= 3) events.push({ at: iso(now), type: 'source_recovered', gameId: g.id, source: s.id });
    Object.assign(st, { ok: true, lastOk: iso(now), consecutiveFailures: 0, lastError: null });
    const items = r.res.items;
    if (!items.length) {
      if (st.lastCount > 0) {
        st.suspect = true;
        st.warning = `0 code détecté alors que ${st.lastCount} l'étaient avant : résultat ignoré (mise en page modifiée ?)`;
        log('WARN', `${key} : ${st.warning}`);
      } else st.warning = 'aucun code détecté sur cette source';
      continue;
    }
    st.suspect = false;
    st.warning = null;
    events.push(...integrateSource(db, g, s, items, now, { baseline: !st.baselinedAt, countMisses: true }));
    st.baselinedAt ||= iso(now);
    st.lastCount = items.length;
    log('INFO', `${key} : ${items.length} code(s) lu(s)`);
  }

  // 4) statuts
  const ctxFor = (gameId) => {
    const g = games.find((x) => x.id === gameId);
    const m = new Map();
    for (const s of g?.sources || []) if (s.enabled !== false) m.set(s.id, { trust: s.trust || 'medium', healthy: healthy(db.sources[sourceKey(gameId, s.id)]) });
    return { now, settings, sources: m };
  };
  events.push(...recomputeAll(db, ctxFor, now, settings));
  db.events = [...events.reverse(), ...db.events].slice(0, settings.maxEvents);

  // 5) écriture (fichiers modifiés uniquement) puis notifications
  const counts = { new: 0, active: 0, expired: 0, check: 0, unknown: 0 };
  const perGame = {};
  for (const c of Object.values(db.codes)) {
    counts[c.status]++;
    (perGame[c.gameId] ||= { new: 0, active: 0, expired: 0, check: 0, unknown: 0 })[c.status]++;
  }
  const enabledSrc = Object.entries(db.sources).filter(([k]) => games.some((g) => g.enabled && g.sources.some((s) => s.enabled !== false && sourceKey(g.id, s.id) === k)));
  const failing = enabledSrc.filter(([, st]) => !healthy(st)).length;
  const system = !enabledSrc.length ? { state: 'idle', message: 'Aucune source configurée.' }
    : failing === enabledSrc.length ? { state: 'down', message: 'Toutes les sources sont en erreur.' }
    : failing ? { state: 'degraded', message: `${failing} source(s) sur ${enabledSrc.length} en difficulté.` }
    : { state: 'ok', message: 'Toutes les sources répondent.' };
  const status = {
    schema: 1,
    lastRunAt: iso(now),
    writtenAt: iso(now),
    system,
    counts: { games: games.filter((g) => g.enabled).length, ...counts },
    games: games.map((g) => ({ id: g.id, name: g.name, enabled: g.enabled, sources: g.sources.length, counts: perGame[g.id] || { new: 0, active: 0, expired: 0, check: 0, unknown: 0 } })),
    sources: db.sources,
    configProblems: problems,
    settings: { checkIntervalMinutes: settings.checkIntervalMinutes, newCodeWindowHours: settings.newCodeWindowHours, activeScoreThreshold: settings.activeScoreThreshold, notificationsEnabled: !!settings.notifications.enabled },
  };
  let changed = false;
  if (!dry) {
    changed = saveDb(dataDir, db);
    const stale = !db.writtenAt || now - Date.parse(db.writtenAt) >= settings.statusRefreshMinutes * 60_000;
    if (changed || stale || before !== JSON.stringify(sigOf(db.sources))) changed = saveStatus(dataDir, status) || changed;
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'lastcheck.json'), JSON.stringify(lastChecks));
  }
  const newEvents = events.filter((e) => e.type === 'new_code');
  let notif = { sent: 0, errors: [] };
  if (!dry && newEvents.length) {
    const msgs = buildMessages(newEvents, games, (e) => db.codes[`${e.gameId}:${e.code.toLowerCase()}`]?.confidence);
    notif = await sendNotifications(msgs, settings.notifications, env);
    notif.errors.forEach((e) => log('WARN', `notification : ${e}`));
  }
  log('INFO', `terminé : ${tasks.length} source(s) interrogée(s), ${newEvents.length} nouveau(x) code(s), système ${system.state}`);
  return { checked: tasks.length, newCodes: newEvents.map((e) => e.code), changed, system, notif, db, status };
}

function sigOf(sources) {
  return Object.fromEntries(Object.entries(sources).map(([k, s]) => [k, [s.ok, s.lastCount, s.consecutiveFailures, s.suspect, s.lastError, s.warning, s.baselinedAt]]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runOnce().then((r) => {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${r.changed}\n`);
  }).catch((e) => { log('FATAL', e.stack || e.message); process.exit(1); });
}
