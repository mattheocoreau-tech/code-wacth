import { DAY, HOUR, iso } from './util.js';
import { TYPES } from './sources/index.js';

export const keyOf = (gameId, code) => `${gameId}:${code.toLowerCase()}`;
const TRUST = { high: 2, medium: 1, low: 0.5 };

export const sourceKey = (gameId, sourceId) => `${gameId}/${sourceId}`;

export function isDue(lastCheck, intervalMin, now, force = false) {
  if (force || !lastCheck) return true;
  return now - Date.parse(lastCheck) >= intervalMin * 60_000 - 60_000; // 1 min de tolérance (retards du planificateur)
}

/** Intègre les résultats d'UNE source dans la base. Retourne les événements générés. */
export function integrateSource(db, game, source, items, now, { baseline, countMisses }) {
  const events = [];
  const seen = new Set();
  const listing = source.listing ?? TYPES[source.type].listing;
  for (const it of items) {
    const key = keyOf(game.id, it.code);
    if (seen.has(key)) continue;
    seen.add(key);
    let rec = db.codes[key] || db.archive[key];
    if (db.archive[key]) { db.codes[key] = db.archive[key]; delete db.archive[key]; } // un code archivé qui réapparaît revient
    if (!rec) {
      rec = db.codes[key] = {
        id: key, gameId: game.id, code: it.code, rewards: it.rewards || null,
        firstSeen: iso(now), lastSeen: iso(now), expiresAt: it.expiresAt || null,
        baseline: !!baseline, status: null, statusReason: '', statusSince: iso(now), confidence: 'unconfirmed',
        sightings: {}, variants: [], history: [],
      };
      if (!baseline) events.push({ at: iso(now), type: 'new_code', gameId: game.id, code: it.code, rewards: it.rewards || null, source: source.id, url: it.url });
    } else {
      rec.lastSeen = iso(now);
      if (rec.code !== it.code && !rec.variants.includes(it.code)) rec.variants.push(it.code);
      if (!rec.rewards && it.rewards) rec.rewards = it.rewards;
      if (it.expiresAt) rec.expiresAt = it.expiresAt;
    }
    const s = (rec.sightings[source.id] ||= { firstSeen: iso(now) });
    Object.assign(s, { url: it.url || source.url, lastSeen: iso(now), statedStatus: it.statedStatus || null, misses: 0, confidence: it.confidence, listing });
    delete s.missingSince;
  }
  if (countMisses && listing) {
    for (const rec of Object.values(db.codes)) {
      const s = rec.sightings[source.id];
      if (rec.gameId === game.id && s && !seen.has(rec.id)) {
        s.misses = (s.misses || 0) + 1;
        if (s.misses === 1) s.missingSince = iso(now); // le délai d'expiration court depuis la 1re absence constatée sur une liste saine
      }
    }
  }
  return events;
}

/**
 * Calcule le statut d'un code. Règles (aucun test en jeu n'est possible) :
 *  - expiré : date atteinte, signalé expiré par les sources à jour, ou disparu de toutes les listes pendant assez longtemps ;
 *  - nouveau : découvert récemment (hors initialisation d'une source) ;
 *  - actif : seulement si le poids cumulé des sources à jour atteint le seuil (2 sources moyennes, ou 1 source « high ») ;
 *  - vérification nécessaire : sinon ; inconnu : aucune de ses sources n'est joignable.
 */
export function computeStatus(rec, ctx) {
  const { now, settings, sources } = ctx; // sources: Map<sourceId, {trust, healthy}>
  const all = Object.entries(rec.sightings).filter(([id]) => sources.has(id));
  const fresh = all.filter(([, s]) => (s.listing ? (s.misses || 0) === 0 : now - Date.parse(s.lastSeen) < 7 * DAY));
  const expiredBy = fresh.filter(([, s]) => s.statedStatus === 'expired').map(([id]) => id);
  const ok = fresh.filter(([, s]) => s.statedStatus !== 'expired');
  const score = ok.reduce((n, [id, s]) => n + (TRUST[sources.get(id).trust] ?? 1) * (s.confidence === 'structured' ? 1 : 0.5), 0);
  const confidence = score >= settings.activeScoreThreshold ? 'confirmed' : 'unconfirmed';
  const out = (status, statusReason) => ({ status, statusReason, confidence });

  if (rec.expiresAt && Date.parse(rec.expiresAt) <= now) return out('expired', "date d'expiration atteinte");
  if (expiredBy.length && !ok.length) return out('expired', `signalé expiré par ${expiredBy.join(', ')}`);
  if (expiredBy.length && ok.length) return out('check', `sources contradictoires (expiré selon ${expiredBy.join(', ')})`);

  const listings = all.filter(([, s]) => s.listing);
  const gone = listings.length && !ok.length &&
    listings.every(([, s]) => (s.misses || 0) >= settings.missingChecksBeforeExpired &&
      now - Date.parse(s.missingSince || rec.lastSeen) >= settings.expireAfterMissingHours * HOUR);
  if (gone) return out('expired', 'disparu des listes de toutes ses sources');

  if (!rec.baseline && now - Date.parse(rec.firstSeen) < settings.newCodeWindowHours * HOUR) return out('new', 'découvert récemment');
  if (confidence === 'confirmed') return out('active', `confirmé par ${ok.length} source(s) à jour`);
  if (!all.some(([id]) => sources.get(id).healthy)) return out('unknown', 'aucune source de ce code n’est joignable');
  return out('check', ok.length ? 'une seule source à jour, non confirmée ailleurs' : 'plus listé actuellement, non marqué expiré');
}

/** Recalcule tous les statuts ; archive les expirés anciens. Retourne les événements de changement. */
export function recomputeAll(db, ctxFor, now, settings) {
  const events = [];
  for (const rec of Object.values(db.codes)) {
    const r = computeStatus(rec, ctxFor(rec.gameId));
    rec.confidence = r.confidence;
    if (rec.status !== r.status) {
      if (rec.status) events.push({ at: iso(now), type: 'status_change', gameId: rec.gameId, code: rec.code, from: rec.status, to: r.status, reason: r.statusReason });
      rec.history.push({ at: iso(now), status: r.status, reason: r.statusReason });
      if (rec.history.length > 20) rec.history.shift();
      rec.status = r.status;
      rec.statusSince = iso(now);
    }
    rec.statusReason = r.statusReason;
  }
  for (const [k, rec] of Object.entries(db.codes)) {
    if (rec.status === 'expired' && now - Date.parse(rec.statusSince) > settings.archiveAfterDays * DAY) {
      db.archive[k] = rec;
      delete db.codes[k];
    }
  }
  return events;
}
