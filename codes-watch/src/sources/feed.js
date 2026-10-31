import { XMLParser } from 'fast-xml-parser';
import { extractFromText, htmlToText } from '../extract.js';

const txt = (v) => (v == null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v));
const linkOf = (l) => {
  const arr = [].concat(l || []);
  const alt = arr.find((x) => x?.['@_rel'] === 'alternate') || arr[0];
  return alt?.['@_href'] || txt(alt) || '';
};

/** Lit un flux RSS 2.0 ou Atom (y compris les flux YouTube et Reddit). */
export function parseFeed(xml) {
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' }).parse(xml);
  if (doc.rss?.channel) {
    return [].concat(doc.rss.channel.item || []).map((i) => ({
      title: txt(i.title), link: txt(i.link), html: txt(i['content:encoded']) || txt(i.description), published: txt(i.pubDate),
    }));
  }
  if (doc.feed) {
    return [].concat(doc.feed.entry || []).map((e) => ({
      title: txt(e.title),
      link: linkOf(e.link),
      html: txt(e.content) || txt(e.summary) || txt(e['media:group']?.['media:description']),
      published: txt(e.published || e.updated),
    }));
  }
  throw new Error('format de flux non reconnu (ni RSS ni Atom)');
}

export function itemsFromFeed(xml, source, now = Date.now()) {
  const maxAge = (source.maxAgeDays ?? 14) * 86_400_000;
  const out = [];
  for (const e of parseFeed(xml)) {
    const t = Date.parse(e.published);
    if (!Number.isNaN(t) && now - t > maxAge) continue;
    const text = `${e.title}\n${htmlToText(e.html)}`;
    for (const it of extractFromText(text, source.extract || {})) out.push({ ...it, url: e.link || source.url });
  }
  return out;
}
