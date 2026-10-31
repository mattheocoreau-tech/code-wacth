// Lecture minimale de robots.txt (User-agent, Allow, Disallow, * et $). En cas de doute, on autorise
// uniquement si le fichier est absent ou illisible ; si une règle l'interdit, la source est refusée.
const toRegex = (p) =>
  new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));

export function parseRobots(txt, uaToken = '*') {
  const groups = [];
  let cur = null;
  let lastWasUA = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === 'user-agent') {
      if (!lastWasUA) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastWasUA = true;
    } else if (cur && (k === 'allow' || k === 'disallow')) {
      lastWasUA = false;
      if (v) cur.rules.push({ allow: k === 'allow', pattern: v });
    } else lastWasUA = false;
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== '*' && uaToken.toLowerCase().includes(a)))
    || groups.find((g) => g.agents.includes('*'));
  return mine ? mine.rules : [];
}

export function isAllowedByRules(rules, pathAndQuery) {
  let best = null;
  for (const r of rules) {
    if (!toRegex(r.pattern).test(pathAndQuery)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

export class RobotsChecker {
  constructor(get, uaToken) {
    this.get = get;
    this.uaToken = uaToken;
    this.cache = new Map();
  }
  async allowed(url) {
    const u = new URL(url);
    if (!this.cache.has(u.origin)) {
      this.cache.set(u.origin, this.get(`${u.origin}/robots.txt`).then((r) => parseRobots(r.text, this.uaToken)).catch(() => []));
    }
    return isAllowedByRules(await this.cache.get(u.origin), u.pathname + u.search);
  }
}
