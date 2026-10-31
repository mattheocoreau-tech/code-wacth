import { STATUS, relTime, shortDate, filterCodes, countByStatus, activeCodesText, newEventsSince, safeUrl, sourceHealth, repoFromLocation, configOps, updateRepoJson } from './lib.js';

const REFRESH_MS = 45_000;
const $ = (s) => document.querySelector(s);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } } };
const S = { status: null, codes: [], archive: [], events: [], offline: false, tab: 'all', search: '' };

// Construit du DOM sans jamais interpréter de HTML : les codes viennent de sites tiers.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

function toast(msg) {
  const t = h('div', { class: 'toast', text: msg });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 6000);
}

async function copy(text, label = text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = h('textarea', { 'aria-hidden': 'true' }); ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* ignoré */ } ta.remove();
  }
  toast(`Copié : ${label}`);
}

// ---------- Données ----------
async function load(name) {
  const r = await fetch(`data/${name}?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${name} : HTTP ${r.status}`);
  return r.json();
}

async function refresh() {
  try {
    const [status, codes, archive, events] = await Promise.all([load('status.json'), load('codes.json'), load('archive.json').catch(() => ({ codes: [] })), load('events.json').catch(() => ({ events: [] }))]);
    Object.assign(S, { status, codes: codes.codes || [], archive: archive.codes || [], events: events.events || [], offline: false });
    announceNew();
  } catch (e) {
    S.offline = !S.status ? false : true;
    S.loadError = !S.status ? "Aucune donnée pour l'instant : la première surveillance n'a pas encore tourné. Lance-la depuis l'onglet Actions du dépôt." : null;
  }
  const b = $('#banner');
  b.hidden = !S.offline;
  b.textContent = 'Connexion perdue : nouvelle tentative automatique…';
  render();
}

function announceNew() {
  const last = store.get('cw.lastEvent');
  const evs = S.events.filter((e) => e.type === 'new_code');
  const newest = evs.reduce((m, e) => (e.at > m ? e.at : m), '');
  if (last === null) { store.set('cw.lastEvent', newest || new Date().toISOString()); return; }
  const fresh = newEventsSince(evs, last);
  if (!fresh.length) return;
  store.set('cw.lastEvent', newest);
  for (const e of fresh) {
    const game = S.status?.games.find((g) => g.id === e.gameId)?.name || e.gameId;
    toast(`${game} : nouveau code ${e.code}`);
    if (store.get('cw.notify') === '1' && 'Notification' in window && Notification.permission === 'granted') new Notification(`${game} : nouveau code`, { body: e.code });
  }
}

// ---------- Rendu ----------
const gameName = (id) => S.status?.games.find((g) => g.id === id)?.name || id;
const badge = (st) => h('span', { class: `badge ${st}`, text: STATUS[st] || st });
const trustNote = (c) => (c.confidence === 'confirmed' ? 'Listé par plusieurs sources à jour' : 'Validité non vérifiée');

function renderNav() {
  const q = S.search.trim().toLowerCase();
  const route = location.hash;
  const nav = $('#gameNav');
  nav.replaceChildren(h('a', { href: '#/', 'aria-current': route === '' || route === '#/' ? 'page' : null }, h('span', { text: 'Accueil' })));
  for (const g of S.status?.games || []) {
    if (q && !g.name.toLowerCase().includes(q)) continue;
    nav.append(h('a', { href: `#/jeu/${g.id}`, class: g.enabled ? '' : 'off', 'aria-current': route === `#/jeu/${g.id}` ? 'page' : null },
      h('span', { text: g.name }), h('span', { class: 'count', text: String(g.counts.active + g.counts.new) })));
  }
}

function renderStub(c) {
  return h('article', { class: 'stub' },
    h('div', { class: 'main' },
      h('div', { class: 'game', text: gameName(c.gameId) }),
      h('div', { class: 'code', text: c.code }),
      c.rewards && h('div', { text: c.rewards }),
      h('div', { class: 'note', text: `Découvert ${relTime(c.firstSeen)}. ${trustNote(c)}.` })),
    h('div', { class: 'tear' }, h('button', { class: 'btn', type: 'button', onclick: () => copy(c.code), 'aria-label': `Copier le code ${c.code}` }, 'Copier')));
}

function pulse() {
  const st = S.status;
  const label = { ok: 'Surveillance en marche', degraded: 'Surveillance partielle', down: 'Surveillance en panne', idle: 'Aucune source configurée' }[st.system.state];
  return h('p', { class: 'pulse' }, h('span', { class: `dot ${st.system.state}` }),
    h('span', {}, `${label}. ${st.system.message} Dernière vérification enregistrée ${relTime(st.lastRunAt)} ; chaque source est relue toutes les ${st.settings.checkIntervalMinutes} min.`));
}

function renderHome() {
  const st = S.status;
  const fresh = S.codes.filter((c) => c.status === 'new');
  const n = countByStatus(S.codes);
  const fig = (v, l) => h('div', {}, h('dd', { text: String(v) }), h('dt', { text: l }));
  return [
    h('h1', { text: 'Codes cadeaux' }), pulse(),
    h('dl', { class: 'figures' }, fig(st.counts.games, 'jeux surveillés'), fig(n.active, 'codes actifs'), fig(n.new, 'nouveaux codes'), fig(n.expired, 'codes expirés'), fig(n.check + n.unknown, 'à vérifier')),
    h('section', {}, h('h2', { text: 'Nouveaux codes' }),
      fresh.length ? h('div', { class: 'stubs' }, fresh.map(renderStub))
        : h('p', { class: 'empty', text: 'Aucun nouveau code pour le moment. La surveillance continue sans toi : cette page se met à jour toute seule.' })),
    h('section', {}, h('h2', { text: 'Jeux' }),
      h('ul', { class: 'games' }, st.games.map((g) => h('li', {},
        h('div', {}, h('a', { class: 'name', href: `#/jeu/${g.id}`, text: g.name }),
          h('div', { class: 'meta', text: g.enabled ? (g.sources ? `${g.sources} source(s)` : 'Aucune source configurée') : 'Surveillance désactivée' })),
        h('div', { class: 'meta', text: `${g.counts.active} actifs, ${g.counts.new} nouveaux, ${g.counts.expired} expirés` }))))),
    ...(st.configProblems?.length ? [h('section', {}, h('h2', { text: 'Configuration à corriger' }), h('ul', {}, st.configProblems.map((p) => h('li', { class: 'err', text: p }))))] : []),
  ];
}

function renderRow(c) {
  const srcs = Object.entries(c.sightings || {}).map(([id, s]) => {
    const u = safeUrl(s.url);
    return u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', text: id }) : h('span', { text: id });
  });
  const joined = srcs.flatMap((s, i) => (i ? [', ', s] : [s]));
  return h('li', { class: `row ${c.status}` },
    h('div', { class: 'codecell' }, h('span', { class: 'code', text: c.code }),
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => copy(c.code), 'aria-label': `Copier le code ${c.code}` }, 'Copier')),
    h('div', {}, h('div', { text: c.rewards || 'Récompense inconnue' }),
      h('div', { class: 'meta' }, c.baseline ? `Déjà présent à la première lecture (${shortDate(c.firstSeen)}). ` : `Découvert le ${shortDate(c.firstSeen)}. `, c.expiresAt ? `Expire le ${shortDate(c.expiresAt)}. ` : 'Date d’expiration inconnue. ', 'Sources : ', joined.length ? joined : 'aucune', '.'),
      c.status !== 'expired' && h('div', { class: 'meta', text: `${trustNote(c)} — ${c.statusReason}.` }),
      c.status === 'expired' && h('div', { class: 'meta', text: `${c.statusReason}.` })),
    h('div', {}, badge(c.status)));
}

function renderGame(id) {
  const g = S.status.games.find((x) => x.id === id);
  if (!g) return [h('h1', { text: 'Jeu introuvable' }), h('p', {}, h('a', { href: '#/', text: 'Retour à l’accueil' }))];
  const all = S.codes.filter((c) => c.gameId === id);
  const arch = S.archive.filter((c) => c.gameId === id);
  const n = countByStatus(all);
  const tabs = [['all', 'Tous', n.all], ['new', 'Nouveaux', n.new], ['active', 'Actifs', n.active], ['check', 'Vérification nécessaire', n.check + n.unknown], ['expired', 'Expirés', n.expired], ['archive', 'Archives', arch.length]];
  let list = S.tab === 'archive' ? arch : S.tab === 'check' ? [...filterCodes(all, { status: 'check' }), ...filterCodes(all, { status: 'unknown' })] : filterCodes(all, { status: S.tab });
  const copyable = activeCodesText(all);
  const srcs = Object.entries(S.status.sources).filter(([, s]) => s.gameId === id);
  const evs = S.events.filter((e) => e.gameId === id).slice(0, 8);
  const evText = (e) => ({ new_code: `Nouveau code ${e.code}`, status_change: `${e.code} : ${STATUS[e.from]} → ${STATUS[e.to]}`, source_down: `Source ${e.source} en panne`, source_recovered: `Source ${e.source} rétablie` }[e.type] || e.type);
  return [
    h('div', { class: 'head' }, h('div', {}, h('h1', { text: g.name }), !g.enabled && h('p', { class: 'meta', text: 'Surveillance désactivée (Réglages).' })),
      h('button', { class: 'btn', type: 'button', disabled: !copyable, onclick: () => copy(copyable, `${copyable.split('\n').length} code(s)`) }, 'Copier tous les codes actifs')),
    pulse(),
    h('p', { class: 'note', text: 'Aucun code n’est testé dans le jeu. « Actif » signifie que plusieurs sources à jour le listent ; un code listé par une seule source reste à vérifier.' }),
    h('div', { class: 'tabs', role: 'group', 'aria-label': 'Filtrer les codes' }, tabs.map(([k, label, c]) => h('button', { type: 'button', 'aria-pressed': S.tab === k ? 'true' : 'false', onclick: () => { S.tab = k; render(); } }, `${label} (${c})`))),
    list.length ? h('ul', { class: 'rows' }, list.map(renderRow))
      : h('p', { class: 'empty', text: g.sources ? 'Aucun code dans cette catégorie.' : 'Aucune source configurée pour ce jeu. Ajoutes-en une dans Réglages.' }),
    h('section', {}, h('h2', { text: 'Sources surveillées' }),
      srcs.length ? h('ul', { class: 'src' }, srcs.map(([key, s]) => { const hs = sourceHealth(s); return h('li', {}, h('span', { class: `dot ${hs.level}` }), h('strong', { text: s.sourceId }), h('span', { class: 'meta', text: `${hs.text}. Vérifiée ${relTime(s.lastCheck)}.` })); })) : h('p', { class: 'meta', text: 'Aucune source.' })),
    evs.length ? h('section', {}, h('h2', { text: 'Activité récente' }), h('ul', { class: 'src' }, evs.map((e) => h('li', {}, h('span', { class: 'meta', text: relTime(e.at) }), h('span', { text: evText(e) }))))) : null,
  ];
}

function render() {
  const main = $('#main');
  if (!S.status) { main.replaceChildren(h('h1', { text: 'Codes cadeaux' }), h('p', { class: 'empty', text: S.loadError || 'Chargement…' })); renderNav(); return; }
  renderNav();
  const m = location.hash.match(/^#\/jeu\/([\w-]+)/);
  main.replaceChildren(...(m ? renderGame(m[1]) : renderHome()).filter(Boolean));
}

// ---------- Réglages ----------
async function openSettings() {
  const dlg = $('#settings');
  const detected = repoFromLocation(location.hostname, location.pathname);
  const saved = JSON.parse(store.get('cw.gh') || 'null') || {};
  const repo = { owner: saved.owner || detected?.owner || '', repo: saved.repo || detected?.repo || '', token: saved.token || '' };
  const msg = h('p', { 'aria-live': 'polite' });
  const body = h('div');
  const say = (t, bad) => { msg.className = bad ? 'err' : 'note'; msg.textContent = t; };
  const fOwner = h('input', { id: 'gOwner', value: repo.owner, autocomplete: 'off' });
  const fRepo = h('input', { id: 'gRepo', value: repo.repo, autocomplete: 'off' });
  const fTok = h('input', { id: 'gTok', type: 'password', value: repo.token, autocomplete: 'off' });
  const cur = () => ({ owner: fOwner.value.trim(), repo: fRepo.value.trim(), token: fTok.value.trim() });
  const persist = () => store.set('cw.gh', JSON.stringify(cur()));

  const apiRead = async (file) => {
    const c = cur();
    const r = await fetch(`https://api.github.com/repos/${c.owner}/${c.repo}/contents/${file}`, { headers: { accept: 'application/vnd.github+json', ...(c.token ? { authorization: `Bearer ${c.token}` } : {}) } });
    if (!r.ok) throw new Error(`Lecture de ${file} impossible (HTTP ${r.status}). Vérifie le nom du dépôt.`);
    const j = await r.json();
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\n/g, '')), (x) => x.charCodeAt(0))));
  };
  const change = async (file, mutate, label) => {
    const c = cur();
    if (!c.owner || !c.repo || !c.token) { say('Renseigne le dépôt et le jeton GitHub pour enregistrer.', true); return; }
    try { await updateRepoJson(fetch, c, file, mutate, `réglages : ${label}`); persist(); say(`${label} : enregistré. Pris en compte au prochain passage (quelques minutes).`); await draw(); }
    catch (e) { say(e.message, true); }
  };

  async function draw() {
    let games = [], settings = {};
    try { [{ games }, settings] = await Promise.all([apiRead('config/games.json'), apiRead('config/settings.json')]); } catch (e) { say(e.message, true); }
    const newName = h('input', { id: 'newGame', placeholder: 'Nom du jeu' });
    body.replaceChildren(
      h('fieldset', {}, h('legend', { text: 'Fréquence de vérification' }),
        h('label', { for: 'freq', text: 'Chaque source est relue toutes les' }),
        (() => { const s = h('select', { id: 'freq' }, [5, 10, 15, 30].map((m) => h('option', { value: m, selected: (settings.checkIntervalMinutes ?? 10) === m ? true : null, text: `${m} minutes` }))); s.addEventListener('change', () => change('config/settings.json', (c) => { c.checkIntervalMinutes = Number(s.value); }, 'fréquence')); return s; })()),
      h('fieldset', {}, h('legend', { text: 'Jeux' }),
        games.length ? games.map((g) => {
          const type = h('select', { 'aria-label': `Type de source pour ${g.name}` }, ['html', 'rss', 'youtube', 'reddit'].map((t) => h('option', { value: t, text: t })));
          const val = h('input', { 'aria-label': `Adresse ou identifiant de la source pour ${g.name}`, placeholder: 'Adresse de la page / chaîne UC… / subreddit' });
          return h('div', { class: 'gamecfg' },
            h('div', { class: 'inline' }, h('strong', { text: g.name }),
              h('button', { class: 'btn ghost small', type: 'button', onclick: () => change('config/games.json', (c) => configOps.setEnabled(c, g.id, !g.enabled), `${g.name} ${g.enabled ? 'désactivé' : 'activé'}`) }, g.enabled ? 'Désactiver' : 'Activer'),
              h('button', { class: 'btn ghost small', type: 'button', onclick: () => confirm(`Supprimer ${g.name} de la surveillance ? Son historique de codes est conservé.`) && change('config/games.json', (c) => configOps.removeGame(c, g.id), `${g.name} supprimé`) }, 'Supprimer')),
            h('ul', { class: 'src' }, g.sources.map((s) => h('li', {}, h('span', { text: `${s.id} (${s.type})` }), h('button', { class: 'btn ghost small', type: 'button', onclick: () => change('config/games.json', (c) => configOps.removeSource(c, g.id, s.id), `source ${s.id} retirée`) }, 'Retirer')))),
            h('div', { class: 'inline' }, type, val, h('button', { class: 'btn small', type: 'button', onclick: () => change('config/games.json', (c) => {
              const t = type.value; const v = val.value.trim();
              configOps.addSource(c, g.id, t === 'html' || t === 'rss' ? { type: t, url: v } : t === 'youtube' ? { type: t, channelId: v } : { type: t, subreddit: v.replace(/^r\//, '') });
            }, 'source ajoutée') }, 'Ajouter la source')));
        }) : h('p', { class: 'meta', text: 'Configuration non chargée : renseigne le dépôt ci-dessous.' }),
        h('div', { class: 'inline' }, newName, h('button', { class: 'btn', type: 'button', onclick: () => newName.value.trim() && change('config/games.json', (c) => configOps.addGame(c, newName.value), `jeu « ${newName.value.trim()} » ajouté`) }, 'Ajouter un jeu'))),
    );
  }

  const notifBox = h('input', { type: 'checkbox', id: 'nb', checked: store.get('cw.notify') === '1' ? true : null });
  notifBox.addEventListener('change', async () => {
    if (notifBox.checked && 'Notification' in window && Notification.permission !== 'granted') { const p = await Notification.requestPermission(); if (p !== 'granted') { notifBox.checked = false; say('Autorisation refusée par le navigateur.', true); } }
    store.set('cw.notify', notifBox.checked ? '1' : '0');
  });
  dlg.replaceChildren(
    h('h2', { id: 'settingsTitle', text: 'Réglages' }),
    h('fieldset', {}, h('legend', { text: 'Notifications' }),
      h('label', {}, notifBox, ' Alerter dans ce navigateur quand un nouveau code apparaît (page ouverte).'),
      h('p', { class: 'note', text: 'Pour être prévenu page fermée, active Discord, Telegram ou ntfy dans config/settings.json (guide d’installation).' })),
    h('fieldset', {}, h('legend', { text: 'Connexion au dépôt GitHub' }),
      h('p', { class: 'note', text: 'Nécessaire pour modifier les jeux et sources depuis cette page. Le jeton reste dans ce navigateur uniquement.' }),
      h('div', { class: 'inline' }, h('div', {}, h('label', { for: 'gOwner', text: 'Compte' }), fOwner), h('div', {}, h('label', { for: 'gRepo', text: 'Dépôt' }), fRepo)),
      h('label', { for: 'gTok', text: 'Jeton GitHub (accès Contents : lecture et écriture)' }), fTok,
      h('button', { class: 'btn ghost small', type: 'button', style: 'margin-top:.6rem', onclick: () => { persist(); draw(); } }, 'Charger la configuration')),
    body, msg,
    h('div', { class: 'inline' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Fermer')));
  dlg.showModal();
  if (repo.owner && repo.repo) draw();
}

// ---------- Démarrage ----------
$('#openSettings').addEventListener('click', openSettings);
$('#gameSearch').addEventListener('input', (e) => { S.search = e.target.value; renderNav(); });
addEventListener('hashchange', () => { S.tab = 'all'; render(); $('#main').focus(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
refresh();
setInterval(refresh, REFRESH_MS); // actualisation automatique : aucune action nécessaire
