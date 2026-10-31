// Fonctions pures du tableau de bord (testées avec Node, utilisées telles quelles dans le navigateur).

export const STATUS = {
  new: 'Nouveau',
  active: 'Actif',
  check: 'Vérification nécessaire',
  unknown: 'Statut inconnu',
  expired: 'Expiré',
};
export const STATUS_ORDER = ['new', 'active', 'check', 'unknown', 'expired'];

export function relTime(isoStr, now = Date.now()) {
  if (!isoStr) return 'jamais';
  const s = Math.max(0, Math.round((now - Date.parse(isoStr)) / 1000));
  if (s < 60) return "à l'instant";
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

export function shortDate(isoStr) {
  if (!isoStr) return '';
  return new Date(isoStr).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function filterCodes(codes, { gameId = null, status = 'all', q = '' } = {}) {
  const needle = q.trim().toLowerCase();
  return codes
    .filter((c) => (!gameId || c.gameId === gameId) && (status === 'all' || c.status === status))
    .filter((c) => !needle || c.code.toLowerCase().includes(needle) || (c.rewards || '').toLowerCase().includes(needle))
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || b.firstSeen.localeCompare(a.firstSeen));
}

export const countByStatus = (codes) => {
  const n = { all: codes.length };
  for (const s of STATUS_ORDER) n[s] = 0;
  for (const c of codes) n[c.status] = (n[c.status] || 0) + 1;
  return n;
};

export const activeCodesText = (codes) => codes.filter((c) => c.status === 'active' || c.status === 'new').map((c) => c.code).join('\n');

export const newEventsSince = (events, sinceIso) =>
  events.filter((e) => e.type === 'new_code' && (!sinceIso || e.at > sinceIso)).sort((a, b) => a.at.localeCompare(b.at));

export const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };

export function sourceHealth(st) {
  if (!st) return { level: 'warn', text: 'Pas encore interrogée' };
  if (st.ok === false) return { level: 'bad', text: st.lastError || 'Erreur' };
  if (st.suspect) return { level: 'warn', text: st.warning || 'Résultat suspect ignoré' };
  if (st.warning) return { level: 'warn', text: st.warning };
  return { level: 'ok', text: `${st.lastCount ?? 0} code(s) lu(s)` };
}

// ---------- Modification de la configuration depuis le tableau de bord (API GitHub) ----------

export const slugify = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function repoFromLocation(hostname, pathname) {
  const m = hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  if (!m) return null;
  const repo = pathname.split('/').filter(Boolean)[0];
  return repo ? { owner: m[1], repo } : null;
}

export function validateNewSource(s) {
  if (!['html', 'rss', 'youtube', 'reddit'].includes(s.type)) return 'Type de source inconnu.';
  if ((s.type === 'html' || s.type === 'rss') && !safeUrl(s.url)) return 'Adresse web (http ou https) requise.';
  if (s.type === 'youtube' && !/^UC[\w-]{20,}$/.test(s.channelId || '')) return "Identifiant de chaîne YouTube attendu (commence par UC).";
  if (s.type === 'reddit' && !/^\w{2,21}$/.test(s.subreddit || '')) return 'Nom de subreddit invalide.';
  return null;
}

export const configOps = {
  addGame(cfg, name) {
    const id = slugify(name);
    if (!id) throw new Error('Nom de jeu invalide.');
    if (cfg.games.some((g) => g.id === id)) throw new Error('Ce jeu existe déjà.');
    cfg.games.push({ id, name: name.trim(), enabled: true, notify: true, sources: [] });
  },
  removeGame(cfg, id) { cfg.games = cfg.games.filter((g) => g.id !== id); },
  setEnabled(cfg, id, enabled) { const g = cfg.games.find((x) => x.id === id); if (g) g.enabled = !!enabled; },
  addSource(cfg, gameId, src) {
    const err = validateNewSource(src);
    if (err) throw new Error(err);
    const g = cfg.games.find((x) => x.id === gameId);
    if (!g) throw new Error('Jeu introuvable.');
    let id = slugify(src.label || new URL(src.url || 'https://x.invalid').hostname.replace(/^www\./, '') || src.type) || src.type;
    while (g.sources.some((s) => s.id === id)) id += '-2';
    const { label, ...rest } = src;
    g.sources.push({ id, ...rest, trust: rest.trust || 'medium' });
  },
  removeSource(cfg, gameId, sourceId) { const g = cfg.games.find((x) => x.id === gameId); if (g) g.sources = g.sources.filter((s) => s.id !== sourceId); },
};

const b64 = {
  enc: (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))),
  dec: (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), (c) => c.charCodeAt(0))),
};

/** Lit, modifie et réécrit un fichier JSON du dépôt. En cas de conflit (modification simultanée), relit et réapplique. */
export async function updateRepoJson(fetchImpl, { owner, repo, token }, file, mutate, message) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${file}`;
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const g = await fetchImpl(url, { headers });
    if (g.status === 401 || g.status === 403) throw new Error("Jeton refusé : il doit avoir l'accès « Contents : lecture et écriture » sur ce dépôt.");
    if (!g.ok) throw new Error(`Lecture de ${file} impossible (HTTP ${g.status}).`);
    const meta = await g.json();
    const data = JSON.parse(b64.dec(meta.content));
    mutate(data);
    const p = await fetchImpl(url, { method: 'PUT', headers, body: JSON.stringify({ message, content: b64.enc(JSON.stringify(data, null, 2) + '\n'), sha: meta.sha }) });
    if (p.ok) return data;
    if (p.status === 409 || p.status === 422) continue;
    if (p.status === 401 || p.status === 403 || p.status === 404) throw new Error("Écriture refusée : vérifie que le jeton a l'accès « Contents : lecture et écriture » sur ce dépôt.");
    throw new Error(`Écriture de ${file} impossible (HTTP ${p.status}).`);
  }
  throw new Error('Conflit de modification : réessaie dans un instant.');
}
