import test from 'node:test';
import assert from 'node:assert/strict';
import { filterCodes, countByStatus, activeCodesText, newEventsSince, relTime, repoFromLocation, configOps, slugify, updateRepoJson, sourceHealth, safeUrl } from '../site/lib.js';

const codes = [
  { id: 'g:a', gameId: 'g', code: 'AAA111', rewards: '5 Gems', status: 'active', firstSeen: '2026-10-01T00:00:00Z' },
  { id: 'g:b', gameId: 'g', code: 'BBB222', rewards: null, status: 'new', firstSeen: '2026-10-29T00:00:00Z' },
  { id: 'g:c', gameId: 'g', code: 'CCC333', rewards: 'Gold', status: 'expired', firstSeen: '2026-09-01T00:00:00Z' },
  { id: 'h:d', gameId: 'h', code: 'DDD444', rewards: null, status: 'check', firstSeen: '2026-10-02T00:00:00Z' },
];

test('filtres, tri par statut, recherche, comptes, copie des codes actifs', () => {
  assert.deepEqual(filterCodes(codes, { gameId: 'g' }).map((c) => c.code), ['BBB222', 'AAA111', 'CCC333']);
  assert.deepEqual(filterCodes(codes, { q: 'gold' }).map((c) => c.code), ['CCC333']);
  assert.equal(countByStatus(codes).expired, 1);
  assert.equal(activeCodesText(filterCodes(codes, { gameId: 'g' })), 'BBB222\nAAA111'); // actifs + nouveaux, pas les expirés
});

test('nouveautés depuis un instant, temps relatif, URL sûres, santé des sources', () => {
  const ev = [{ type: 'new_code', at: '2026-10-30T10:00:00Z', code: 'X' }, { type: 'status_change', at: '2026-10-30T11:00:00Z' }, { type: 'new_code', at: '2026-10-30T12:00:00Z', code: 'Y' }];
  assert.deepEqual(newEventsSince(ev, '2026-10-30T10:00:00Z').map((e) => e.code), ['Y']);
  assert.equal(relTime('2026-10-30T11:55:00Z', Date.parse('2026-10-30T12:00:00Z')), 'il y a 5 min');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.ok(safeUrl('https://a.test/x'));
  assert.equal(sourceHealth({ ok: false, lastError: 'boom' }).level, 'bad');
  assert.equal(sourceHealth({ ok: true, lastCount: 4 }).level, 'ok');
});

test('opérations de configuration : ajout/suppression de jeu et de source, validations', () => {
  const cfg = { games: [] };
  configOps.addGame(cfg, 'Anime Édition 2');
  assert.equal(cfg.games[0].id, 'anime-edition-2');
  assert.throws(() => configOps.addGame(cfg, 'anime edition 2'), /existe déjà/);
  configOps.addSource(cfg, 'anime-edition-2', { type: 'html', url: 'https://www.exemple.test/codes' });
  configOps.addSource(cfg, 'anime-edition-2', { type: 'html', url: 'https://www.exemple.test/autres' });
  assert.deepEqual(cfg.games[0].sources.map((s) => s.id), ['exemple-test', 'exemple-test-2']);
  assert.throws(() => configOps.addSource(cfg, 'anime-edition-2', { type: 'html', url: 'javascript:1' }), /Adresse web/);
  assert.throws(() => configOps.addSource(cfg, 'anime-edition-2', { type: 'youtube', channelId: 'abc' }), /YouTube/);
  configOps.setEnabled(cfg, 'anime-edition-2', false);
  assert.equal(cfg.games[0].enabled, false);
  configOps.removeSource(cfg, 'anime-edition-2', 'exemple-test');
  configOps.removeGame(cfg, 'anime-edition-2');
  assert.deepEqual(cfg.games, []);
  assert.equal(slugify('  Été & Co!! '), 'ete-co');
  assert.deepEqual(repoFromLocation('moi.github.io', '/mon-depot/'), { owner: 'moi', repo: 'mon-depot' });
  assert.equal(repoFromLocation('localhost', '/'), null);
});

test('API GitHub : lecture → modification → écriture, reprise sur conflit, jeton refusé', async () => {
  let remote = { games: [] };
  let sha = 1; let conflicts = 1; const puts = [];
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
  const fake = async (url, o = {}) => {
    if (!o.method) return { ok: true, status: 200, json: async () => ({ content: enc(remote), sha: String(sha) }) };
    if (conflicts-- > 0) { sha++; return { ok: false, status: 409 }; }
    const body = JSON.parse(o.body); puts.push(body);
    remote = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')); return { ok: true, status: 200 };
  };
  const res = await updateRepoJson(fake, { owner: 'o', repo: 'r', token: 't' }, 'config/games.json', (c) => configOps.addGame(c, 'Jeu é'), 'msg');
  assert.equal(res.games[0].name, 'Jeu é');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].sha, '2'); // la relecture a bien repris le nouveau sha
  await assert.rejects(updateRepoJson(async () => ({ ok: false, status: 403 }), { owner: 'o', repo: 'r', token: 'bad' }, 'f', () => {}, 'm'), /Jeton refusé/);
});
