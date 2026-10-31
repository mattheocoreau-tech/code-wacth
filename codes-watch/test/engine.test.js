import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStatus, integrateSource, isDue } from '../src/engine.js';
import { HOUR, iso } from '../src/util.js';
import { parseRobots, isAllowedByRules } from '../src/robots.js';
import { buildMessages, sendNotifications } from '../src/notify.js';

const settings = { newCodeWindowHours: 48, activeScoreThreshold: 2, missingChecksBeforeExpired: 3, expireAfterMissingHours: 24 };
const T0 = Date.parse('2026-10-30T00:00:00Z');
const game = { id: 'g', name: 'G' };
const srcA = { id: 'a', type: 'html' };
const srcB = { id: 'b', type: 'html' };
const srcR = { id: 'r', type: 'rss' };
const mk = () => ({ codes: {}, archive: {}, events: [], sources: {} });
const item = (code, extra = {}) => ({ code, rewards: null, statedStatus: null, confidence: 'structured', url: 'u', ...extra });
const sources = (h = true) => new Map([['a', { trust: 'medium', healthy: h }], ['b', { trust: 'medium', healthy: h }], ['r', { trust: 'medium', healthy: h }]]);
const st = (db, code, now, h = true) => computeStatus(db.codes[`g:${code.toLowerCase()}`], { now, settings, sources: sources(h) });

test('initialisation d\'une source : aucun événement « nouveau », jamais « new »', () => {
  const db = mk();
  assert.deepEqual(integrateSource(db, game, srcA, [item('TESTAAA1')], T0, { baseline: true, countMisses: true }), []);
  assert.equal(st(db, 'TESTAAA1', T0).status, 'check'); // une seule source : non confirmé
});

test('nouveau code → new puis, confirmé par 2 sources → active après la fenêtre', () => {
  const db = mk();
  const ev = integrateSource(db, game, srcA, [item('TESTBBB2')], T0, { baseline: false, countMisses: true });
  assert.equal(ev[0].type, 'new_code');
  assert.equal(st(db, 'TESTBBB2', T0).status, 'new');
  integrateSource(db, game, srcB, [item('TESTBBB2')], T0 + HOUR, { baseline: true, countMisses: true });
  assert.equal(st(db, 'TESTBBB2', T0 + HOUR).confidence, 'confirmed');
  assert.equal(st(db, 'TESTBBB2', T0 + 49 * HOUR).status, 'active');
});

test('doublons : même code, casse différente → un seul enregistrement', () => {
  const db = mk();
  integrateSource(db, game, srcA, [item('TestCode9')], T0, { baseline: false, countMisses: true });
  integrateSource(db, game, srcB, [item('TESTCODE9')], T0, { baseline: false, countMisses: true });
  assert.equal(Object.keys(db.codes).length, 1);
  assert.deepEqual(db.codes['g:testcode9'].variants, ['TESTCODE9']);
});

test('expiré : annoncé par la source, contradiction → vérification, date atteinte', () => {
  const db = mk();
  integrateSource(db, game, srcA, [item('TESTEXP1', { statedStatus: 'expired' })], T0, { baseline: true, countMisses: true });
  assert.equal(st(db, 'TESTEXP1', T0).status, 'expired');
  integrateSource(db, game, srcB, [item('TESTEXP1')], T0, { baseline: true, countMisses: true });
  assert.equal(st(db, 'TESTEXP1', T0).status, 'check');
  integrateSource(db, game, srcA, [item('TESTDATE2', { expiresAt: iso(T0 - 1) })], T0, { baseline: true, countMisses: true });
  assert.equal(st(db, 'TESTDATE2', T0).status, 'expired');
});

test('disparition : expiré seulement après N contrôles ET délai ; jamais pour une source « annonces »', () => {
  const db = mk();
  integrateSource(db, game, srcA, [item('TESTGONE1')], T0, { baseline: true, countMisses: true });
  integrateSource(db, game, srcR, [item('TESTPOST2', { confidence: 'text' })], T0, { baseline: true, countMisses: true });
  for (let i = 1; i <= 3; i++) integrateSource(db, game, srcA, [item('OTHERCODE')], T0 + i * 10 * 60_000, { baseline: true, countMisses: true });
  assert.notEqual(st(db, 'TESTGONE1', T0 + 40 * 60_000).status, 'expired'); // < 24 h
  assert.equal(st(db, 'TESTGONE1', T0 + 25 * HOUR).status, 'expired');
  assert.notEqual(st(db, 'TESTPOST2', T0 + 6 * 24 * HOUR).status, 'expired'); // jamais d'expiration par disparition d'un flux
});

test('aucune source joignable → inconnu', () => {
  const db = mk();
  integrateSource(db, game, srcA, [item('TESTUNK1')], T0, { baseline: true, countMisses: true });
  assert.equal(st(db, 'TESTUNK1', T0 + HOUR, false).status, 'unknown');
});

test('isDue : fréquence respectée, tolérance d\'une minute, forcé', () => {
  assert.equal(isDue(undefined, 10, T0), true);
  assert.equal(isDue(iso(T0 - 5 * 60_000), 10, T0), false);
  assert.equal(isDue(iso(T0 - 9.5 * 60_000), 10, T0), true);
  assert.equal(isDue(iso(T0 - 60_000), 30, T0, true), true);
});

test('robots.txt : groupes, priorité du plus long motif, jokers', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.json$\n');
  assert.equal(isAllowedByRules(rules, '/codes'), true);
  assert.equal(isAllowedByRules(rules, '/private/x'), false);
  assert.equal(isAllowedByRules(rules, '/private/ok'), true);
  assert.equal(isAllowedByRules(rules, '/a.json'), false);
  assert.equal(isAllowedByRules(parseRobots('User-agent: codes-watch\nDisallow: /\n\nUser-agent: *\nAllow: /\n', 'codes-watch'), '/x'), false);
});

test('notifications : message honnête, canaux indépendants, secrets masqués', async () => {
  const msgs = buildMessages([{ type: 'new_code', gameId: 'g', code: 'TESTNOTIF1', rewards: '5 gems', source: 'a', url: 'https://x/y' }], [game], () => 'unconfirmed');
  assert.match(msgs[0].text, /validité NON vérifiée/);
  const calls = [];
  const fake = async (url, o) => { calls.push(url); return { ok: !url.includes('discord') , status: 500 }; };
  const cfg = { enabled: true, discord: { enabled: true, webhookEnv: 'D' }, telegram: { enabled: true, tokenEnv: 'T', chatIdEnv: 'C' }, ntfy: { enabled: true, topicEnv: 'N' } };
  const r = await sendNotifications(msgs, cfg, { D: 'https://discord.test/hook', T: '123:SECRET', C: '1', N: 'topic' }, fake);
  assert.equal(calls.length, 3);
  assert.equal(r.sent, 2); // discord a échoué, les deux autres sont partis
  assert.equal(r.errors.length, 1);
  assert.deepEqual(await sendNotifications(msgs, { enabled: false }, {}, fake), { sent: 0, errors: [] });
});
