import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFromHtml, extractFromText, looksLikeCode, parseExpiry } from '../src/extract.js';
import { itemsFromFeed, parseFeed } from '../src/sources/feed.js';

// Jetons fictifs de test uniquement (jamais publiés par l'application).
test('looksLikeCode rejette mots courants, espaces réservés, années, minuscules', () => {
  for (const bad of ['Release', 'abc', 'CODE2', 'REWARD', '2025', 'Hello', 'NEW', 'a b']) assert.equal(looksLikeCode(bad), false, bad);
  for (const good of ['TESTALPHA', 'abc123', 'Mixed4Case', 'UPD9']) assert.equal(looksLikeCode(good), true, good);
  assert.equal(looksLikeCode('lowercase'), false);
  assert.equal(looksLikeCode('lowercase', { allowLowercase: true }), true);
});

test('HTML structuré : statut par section, barré, tableau, étapes ignorées, espaces réservés ignorés', () => {
  const html = `<article><h2>Active codes</h2><ul><li><strong>TESTALPHA</strong> – 500 Gems</li><li>TESTBETA2 - 3 Rerolls</li></ul>
  <h2>Expired codes</h2><ul><li><strong>OLDONE</strong> – 100 Gold</li></ul>
  <h2>How to redeem</h2><ol><li>Open the game</li><li>Redeem</li></ol>
  <ul><li><strong>CODE1</strong> - Reward Description</li></ul>
  <h2>All codes: active and expired</h2><ul><li><s>STRUCK9</s></li><li><strong>MIXEDHEAD</strong></li></ul>
  <table><tr><td><strong>TBL42</strong></td><td>2 chips (expires on 2026-12-01)</td></tr></table></article>`;
  const by = Object.fromEntries(extractFromHtml(html).map((i) => [i.code, i]));
  assert.deepEqual(Object.keys(by).sort(), ['MIXEDHEAD', 'OLDONE', 'STRUCK9', 'TBL42', 'TESTALPHA', 'TESTBETA2']);
  assert.equal(by.TESTALPHA.statedStatus, 'active');
  assert.equal(by.TESTALPHA.rewards, '500 Gems');
  assert.equal(by.OLDONE.statedStatus, 'expired');
  assert.equal(by.STRUCK9.statedStatus, 'expired');
  assert.equal(by.MIXEDHEAD.statedStatus, null); // titre ambigu → pas de statut annoncé
  assert.equal(by.TBL42.expiresAt, '2026-12-01T23:59:59.000Z');
});

test('texte libre : listes, guillemets, « use code », statut limité au voisinage du jeton', () => {
  const r = Object.fromEntries(extractFromText("New codes!\nCode: SORRYTEST1, SORRYTEST2\n- BIGTEST3 – 50 gems\nUse code `Mixed4Case` now. The code OLDTEST9 expired.\nit's 'don't' fine").map((i) => [i.code, i]));
  assert.deepEqual(Object.keys(r).sort(), ['BIGTEST3', 'Mixed4Case', 'OLDTEST9', 'SORRYTEST1', 'SORRYTEST2']);
  assert.equal(r.BIGTEST3.rewards, '50 gems');
  assert.equal(r.OLDTEST9.statedStatus, 'expired');
  assert.equal(r.SORRYTEST1.confidence, 'text');
  assert.deepEqual(extractFromText('Nothing to see here ABCDEF1'), []); // pas de mot « code » → rien
});

test('parseExpiry', () => {
  assert.equal(parseExpiry('expires on October 5th, 2026'), '2026-10-05T23:59:59.000Z');
  assert.equal(parseExpiry('no date here'), null);
});

test('flux Atom (YouTube) et RSS : lecture, filtre d\'ancienneté, extraction', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const atom = `<feed xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
   <entry><title>Update video</title><link rel="alternate" href="https://yt.test/v1"/><published>2026-10-29T10:00:00Z</published>
   <media:group><media:description>New code: VIDTEST77 for rewards</media:description></media:group></entry>
   <entry><title>Old</title><link rel="alternate" href="https://yt.test/v0"/><published>2025-01-01T00:00:00Z</published>
   <media:group><media:description>Code: OLDVID88</media:description></media:group></entry></feed>`;
  assert.equal(parseFeed(atom).length, 2);
  const items = itemsFromFeed(atom, { url: 'x' }, now);
  assert.deepEqual(items.map((i) => [i.code, i.url]), [['VIDTEST77', 'https://yt.test/v1']]);
  const rss = `<rss><channel><item><title>Codes</title><link>https://r.test/1</link><pubDate>Thu, 29 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Code: RSSTEST55&lt;/p&gt;</description></item></channel></rss>`;
  assert.equal(itemsFromFeed(rss, { url: 'x' }, now)[0].code, 'RSSTEST55');
  assert.throws(() => parseFeed('<html></html>'), /non reconnu/);
});
