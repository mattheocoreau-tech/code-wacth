import { extractFromHtml } from '../extract.js';
import { itemsFromFeed } from './feed.js';

// listing=true : la source présente la liste des codes du moment (la disparition d'un code y est significative).
// listing=false : annonces/posts (un code qui sort du flux n'est pas pour autant expiré).
export const TYPES = {
  html: { listing: true, robots: true },
  rss: { listing: false, robots: true },
  youtube: { listing: false, robots: false }, // flux officiel public de la chaîne
  reddit: { listing: false, robots: false }, // flux RSS officiel de recherche d'un subreddit
};

export function resolveUrl(s) {
  if (s.type === 'youtube') return s.url || `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(s.channelId)}`;
  if (s.type === 'reddit') {
    const q = encodeURIComponent(s.query || 'code OR codes');
    return s.url || `https://www.reddit.com/r/${encodeURIComponent(s.subreddit)}/search.rss?q=${q}&restrict_sr=1&sort=new&t=month`;
  }
  return s.url;
}

export function validateSource(s) {
  if (!s.id || !/^[a-z0-9][a-z0-9-_]*$/i.test(s.id)) return 'id de source manquant ou invalide';
  if (!TYPES[s.type]) return `type inconnu « ${s.type} » (attendu : ${Object.keys(TYPES).join(', ')})`;
  if ((s.type === 'html' || s.type === 'rss') && !/^https?:\/\//.test(s.url || '')) return 'url http(s) requise';
  if (s.type === 'youtube' && !s.url && !s.channelId) return 'channelId (ou url de flux) requis';
  if (s.type === 'reddit' && !s.url && !s.subreddit) return 'subreddit requis';
  return null;
}

export async function fetchSource(source, ctx) {
  const url = resolveUrl(source);
  if (TYPES[source.type].robots && !(await ctx.robots.allowed(url))) throw new Error('adresse interdite par le robots.txt du site (non contourné)');
  const accept = source.type === 'html' ? 'text/html,application/xhtml+xml' : 'application/atom+xml,application/rss+xml,application/xml,text/xml';
  const res = await ctx.get(url, { accept });
  const items = source.type === 'html' ? extractFromHtml(res.text, { ...(source.extract || {}), selector: source.selector, exclude: source.exclude })
    : itemsFromFeed(res.text, source, ctx.now);
  const title = (res.text.match(/<title[^>]*>([^<]{0,80})/i) || [])[1]?.trim() || '';
  return { items: items.map((i) => ({ ...i, url: i.url || url })), info: `page de ${Math.round(res.text.length / 1024)} Ko, titre « ${title || 'aucun'} »` };
}
