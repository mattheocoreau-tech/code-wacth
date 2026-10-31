import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOnce } from '../src/run.js';
import { HOUR } from '../src/util.js';

// Faux site local (jetons fictifs de test) dont le contenu change entre les passages.
const page = (codes) => `<article><h2>Active codes</h2><ul>${codes.map((c) => `<li><strong>${c}</strong> – 100 Gems</li>`).join('')}</ul></article>`;
let listA = ['TESTAAA1', 'TESTBBB2'];
let mode = 'normal';
const server = http.createServer((req, res) => {
  if (req.url === '/robots.txt') return res.end('User-agent: *\nDisallow: /secret\n');
  if (req.url === '/blocked') { res.statusCode = 403; return res.end('Just a moment... captcha'); }
  if (req.url.startsWith('/list')) { res.setHeader('content-type', 'text/html'); return res.end(mode === 'empty' ? '<article><p>maintenance</p></article>' : page(listA)); }
  res.statusCode = 404; res.end('nope');
});

test('pipeline complet : initialisation, nouveau code, confirmation, pannes isolées, anti-régression, disparition', async (t) => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-'));
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ hostDelayMs: 0, http: { retries: 0, timeoutMs: 3000 } }));
  fs.writeFileSync(path.join(configDir, 'games.json'), JSON.stringify({ games: [{ id: 'g1', name: 'Jeu Test', sources: [
    { id: 's1', type: 'html', url: `${base}/list1` },
    { id: 's2', type: 'html', url: `${base}/list2` },
    { id: 'down', type: 'html', url: `${base}/blocked` },
    { id: 'robots', type: 'html', url: `${base}/secret` },
    { id: 'bad', type: 'html' },
  ] }, { id: 'g2', name: 'Sans source', sources: [] }] }));
  const T0 = Date.parse('2026-10-30T00:00:00Z');
  const run = (now) => runOnce({ root: dir, now, force: true, env: {} });
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, 'site/data', f), 'utf8'));

  // 1) premier passage = initialisation : codes enregistrés, aucune notification « nouveau »
  let r = await run(T0);
  assert.deepEqual(r.newCodes, []);
  assert.equal(r.status.configProblems.length, 1); // la source invalide est signalée, pas bloquante
  assert.equal(Object.keys(r.db.codes).length, 2);
  assert.match(r.db.sources['g1/down'].lastError, /anti-bot/);
  assert.match(r.db.sources['g1/robots'].lastError, /robots\.txt/);
  assert.equal(r.status.system.state, 'degraded'); // 2 sources saines sur 4 : le reste continue
  assert.equal(r.db.codes['g1:testaaa1'].status, 'active'); // 2 sources concordantes
  assert.equal(r.db.codes['g1:testaaa1'].baseline, true);

  // 2) un nouveau code apparaît → détecté, « new », notifié une seule fois
  listA = ['TESTAAA1', 'TESTBBB2', 'TESTCCC3'];
  r = await run(T0 + 10 * 60_000);
  assert.deepEqual(r.newCodes, ['TESTCCC3']);
  assert.equal(r.db.codes['g1:testccc3'].status, 'new');
  r = await run(T0 + 20 * 60_000);
  assert.deepEqual(r.newCodes, []); // pas de doublon
  assert.equal(Object.keys(read('codes.json').codes).length, 3);
  assert.equal(read('events.json').events.filter((e) => e.type === 'new_code').length, 1);

  // 3) le site est en « maintenance » (0 code) : résultat ignoré, aucun code ne bouge
  mode = 'empty';
  for (let i = 1; i <= 4; i++) r = await run(T0 + 26 * HOUR + i * 600_000);
  assert.equal(r.db.sources['g1/s1'].suspect, true);
  assert.equal(r.db.codes['g1:testaaa1'].status, 'active');
  mode = 'normal';

  // 4) TESTAAA1 disparaît réellement des deux listes → expiré, mais seulement après plusieurs contrôles + délai
  listA = ['TESTBBB2', 'TESTCCC3'];
  for (let i = 1; i <= 3; i++) r = await run(T0 + 30 * HOUR + i * 600_000);
  assert.notEqual(r.db.codes['g1:testaaa1'].status, 'expired'); // dernier vu il y a moins de 24 h
  r = await run(T0 + 60 * HOUR);
  assert.equal(r.db.codes['g1:testaaa1'].status, 'expired');
  assert.match(read('events.json').events.map((e) => `${e.type}:${e.code}:${e.to}`).join('|'), /status_change:TESTAAA1:expired/);
  assert.equal(r.db.codes['g1:testbbb2'].status, 'active'); // un code actif n'est jamais supprimé sans raison

  // 5) reprise : un nouveau processus relit les fichiers (persistance) sans rien perdre
  r = await run(T0 + 61 * HOUR);
  assert.equal(Object.keys(r.db.codes).length, 3);
  assert.equal(read('status.json').counts.expired, 1);
  assert.equal(read('status.json').games.find((g) => g.id === 'g2').sources, 0);
});
