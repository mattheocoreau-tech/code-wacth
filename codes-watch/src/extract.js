import * as cheerio from 'cheerio';

// Mots qui ressemblent à des codes mais n'en sont pas (comparés en majuscules).
const STOP = new Set(
  `CODE CODES NEW FREE REDEEM REDEEMED UPDATE ACTIVE EXPIRED WORKING INACTIVE REWARD REWARDS GEMS GEM GOLD FAQ TIP TIPS NOTE NOTES
   HOW WHAT WHERE WHEN WHY THE AND FOR YOU YOUR ALL LIST LATEST MORE INFO YES ROBLOX DISCORD TWITTER YOUTUBE REDDIT ANIME GAME GAMES
   PATCH EVENT EVENTS TRAIT REROLLS REROLL CHIPS STAT COINS CASH BOOST BOOSTS LUCK LUCKY HERE NONE NULL TBA TBD NA OFFICIAL
   PLAYERS PLAYER LIKES FAVORITES MEMBERS VISITS WORKS WORK USE USED ENTER CLICK OPEN JOIN FOLLOW READ SEE ALSO NEXT PREVIOUS SHARE
   JANUARY FEBRUARY MARCH APRIL MAY JUNE JULY AUGUST SEPTEMBER OCTOBER NOVEMBER DECEMBER`
    .split(/\s+/).filter(Boolean),
);
const PLACEHOLDER = /^(?:CODE|CODES|REWARD|REWARDS|EXAMPLE|EXEMPLE|XXX+|YYY+|YOURCODE|ENTERCODE|CODEHERE|NEWCODE|SAMPLE|TEST)\d*$/i;
const EXPIRED_RE = /\b(expired|no longer (?:works?|valid|active)|inactive|doesn'?t work|not working)\b|expiré|périmé/i;
const H_EXPIRED = /\b(expired|inactive|old codes?|no longer|ended|outdated|dead)\b|expiré|périmé/i;
const H_ACTIVE = /\b(active|working|valid|latest|current|new codes?|available)\b|actif|valide|nouveau/i;

/** Un jeton ressemble-t-il à un code ? Volontairement strict : mieux vaut en manquer un que d'en inventer un. */
export function looksLikeCode(tok, o = {}) {
  if (typeof tok !== 'string') return false;
  const re = o.allowHyphen ? /^[A-Za-z0-9_!]+(?:-[A-Za-z0-9_!]+)*$/ : /^[A-Za-z0-9_!]+$/;
  if (tok.length < 3 || tok.length > 32 || !re.test(tok)) return false;
  const up = tok.toUpperCase();
  if (STOP.has(up) || PLACEHOLDER.test(tok) || (o.extraStop || []).includes(up)) return false;
  if (!/[A-Za-z]/.test(tok)) return false;
  const hasUpper = /[A-Z]/.test(tok);
  const hasDigit = /\d/.test(tok);
  if (!hasUpper && !hasDigit) return !!o.allowLowercase && tok.length >= 4;
  if (!o.allowCapitalized && /^[A-Z][a-z]+$/.test(tok)) return false;
  return true;
}

export function parseExpiry(s) {
  const m = s.match(
    /expir\w*\s*(?:on|date|:|-)?\s*[:-]?\s*(\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})/i,
  );
  if (!m) return null;
  const raw = m[1].replace(/(\d)(st|nd|rd|th)/i, '$1');
  const t = /^\d{4}-/.test(raw) ? Date.parse(`${raw}T23:59:59Z`) : Date.parse(`${raw} 23:59:59 UTC`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const cleanReward = (s) => {
  const r = norm(s).replace(/^[\s\-–—:|=→>•]+/, '').trim();
  return r ? r.slice(0, 200) : null;
};
const stripEdges = (s) => s.replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_!]+$/g, '');

export function htmlToText(html) {
  const $ = cheerio.load(`<div id="r">${html}</div>`);
  $('br').replaceWith('\n');
  $('p,li,div,h1,h2,h3,h4,h5,tr,dt,dd').each((_, e) => { $(e).append('\n'); });
  return $('#r').text();
}

/** Extraction depuis du texte libre (post, description vidéo…) : confiance « faible ». */
export function extractFromText(text, o = {}) {
  if (!/\bcodes?\b|redeem/i.test(text)) return [];
  const found = new Map();
  const add = (tok, rewards, line) => {
    const code = stripEdges(tok);
    if (!looksLikeCode(code, o)) return;
    const k = code.toLowerCase();
    if (found.has(k)) return;
    // Le statut ne vaut que pour le voisinage immédiat du jeton (une ligne peut citer plusieurs codes).
    const at = line.indexOf(code);
    const near = at < 0 ? line : line.slice(Math.max(0, at - 30), at + code.length + 60);
    const own = rewards ? cleanReward(rewards.split(/(?<=[.!?])\s/)[0]) : null;
    found.set(k, {
      code,
      rewards: own && !EXPIRED_RE.test(own) ? own : null,
      statedStatus: EXPIRED_RE.test(near) ? 'expired' : null,
      confidence: 'text',
      expiresAt: parseExpiry(near),
    });
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = norm(raw);
    if (!line) continue;
    const hasCodeWord = /\bcodes?\b/i.test(line);
    // (a) jeton entre guillemets / backticks / gras markdown
    if (hasCodeWord || /^[•\-–*>▪●·\d.)\s]/.test(raw)) {
      for (const m of line.matchAll(/[`"“”'‘’*_]{1,2}([A-Za-z0-9_!]{3,32})[`"“”'‘’*_]{1,2}/g)) {
        add(m[1], line.slice(m.index + m[0].length), line);
      }
    }
    // (b) « Code(s) : A, B, C »
    const b = line.match(/\bcodes?\b\s*[:：–—-]\s*(.+)$/i);
    if (b) for (const part of b[1].split(/\s*(?:,|;|\/|\||\band\b)\s*/i)) add(part.split(/\s+/)[0] || '', null, line);
    // (c) « CODE – récompense » en début de ligne (jeton en MAJUSCULES ou avec chiffre)
    const c = line.match(/^[•\-–*>▪●·\d.)\s]*([A-Za-z0-9_!]{4,32})\s*(?:[-–—:=|→]|\s{2,})\s*(\S.*)$/);
    if (c && (c[1] === c[1].toUpperCase() || /\d/.test(c[1]))) add(c[1], c[2], line);
    // (d) « use code ABC123 »
    const d = line.match(/\bcodes?\s+([A-Za-z0-9_!]{4,32})\b/i);
    if (d) add(d[1], null, line);
  }
  return [...found.values()];
}

function classifyHeading(t) {
  const e = H_EXPIRED.test(t);
  const a = H_ACTIVE.test(t);
  if (e && a) return null;
  return e ? 'expired' : a ? 'active' : null;
}

/**
 * Extraction depuis une page HTML structurée (liste ou tableau « CODE – récompense »).
 * Le statut annoncé (actif / expiré) est déduit du titre de section le plus proche, d'un texte barré
 * ou d'un mot-clé dans la ligne. Confiance « structurée ».
 */
export function extractFromHtml(html, o = {}) {
  const $ = cheerio.load(html);
  $('script,style,noscript,nav,header,footer,aside,form,iframe,svg,[class*="comment"],[id*="comment"],[class*="related"],[class*="sidebar"],[class*="cookie"]').remove();
  if (o.exclude) $(o.exclude).remove();
  const root = o.selector ? $(o.selector) : $('article').length ? $('article').first() : $('main').length ? $('main').first() : $('body');
  const found = new Map();

  const sectionStatus = (el) => {
    if ($(el).closest('s,del,strike').length || $(el).find('s,del,strike').length) return 'expired';
    let cur = $(el);
    for (let i = 0; i < 8 && cur.length; i++) {
      const h = cur.prevAll('h1,h2,h3,h4,h5').first();
      if (h.length) return classifyHeading(norm(h.text()));
      cur = cur.parent();
    }
    return null;
  };

  const push = (tok, blockText, el, tokenIdx) => {
    const k = tok.toLowerCase();
    if (found.has(k)) return;
    const rewards = cleanReward(blockText.slice(tokenIdx + tok.length));
    let status = sectionStatus(el);
    if (EXPIRED_RE.test(blockText)) status = 'expired';
    found.set(k, { code: tok, rewards, statedStatus: status, confidence: 'structured', expiresAt: parseExpiry(blockText) });
  };

  // 1) jeton mis en évidence (gras, code…) au début d'une ligne de liste / de tableau / d'un paragraphe
  root.find('strong,b,code,kbd,mark').each((_, el) => {
    const tok = stripEdges(norm($(el).text()));
    if (!looksLikeCode(tok, { ...o, structured: true })) return;
    let block = $(el).closest('li,tr,td,dd,p');
    if (block.is('td') && block.closest('tr').length && block.prevAll('td,th').length === 0) block = block.closest('tr');
    if (!block.length) return;
    const text = norm(block.text());
    const idx = text.indexOf(tok);
    if (idx < 0 || idx > 8) return;
    push(tok, text, el, idx);
  });

  // 2) ligne de liste / cellule dont tout le texte est « CODE » ou « CODE – récompense »
  root.find('li,td').each((_, el) => {
    const text = norm($(el).text());
    const m = text.match(/^([A-Za-z0-9_!]{3,32})(?:\s*[-–—:|=→]\s*(.+))?$/);
    if (!m || !looksLikeCode(m[1], o)) return;
    const row = $(el).is('td') && $(el).prevAll('td,th').length === 0 ? $(el).closest('tr') : $(el);
    push(m[1], norm(row.text()), el, 0);
  });

  return [...found.values()];
}
