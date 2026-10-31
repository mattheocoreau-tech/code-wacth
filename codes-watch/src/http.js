import { sleep } from './util.js';

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const BLOCK = /(cf-chl|challenge-platform|just a moment|captcha|are you human|attention required)/i;

/**
 * GET avec délai maximum, nouvelles tentatives (réseau, 429, 5xx) et détection
 * des protections anti-bot (qui ne sont JAMAIS contournées : la source est signalée en erreur).
 */
export async function httpGet(url, { timeoutMs = 15000, retries = 2, userAgent, accept = '*/*', maxBytes = 3_000_000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res, text;
    try {
      res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'user-agent': userAgent, accept, 'accept-language': 'en,fr;q=0.8' },
      });
      text = await res.text();
    } catch (e) {
      const err = e?.name === 'AbortError' ? new Error(`délai dépassé (${timeoutMs} ms)`) : e;
      if (attempt < retries) { await sleep(1000 * 2 ** attempt); continue; }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return { status: res.status, text: text.slice(0, maxBytes), url: res.url };
    const blocked = BLOCK.test(text.slice(0, 4000));
    if (res.status === 401 || res.status === 403 || (res.status === 503 && blocked)) {
      throw new HttpError(`accès refusé (${res.status})${blocked ? ' – protection anti-bot détectée, non contournée' : ''}`, res.status);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt, 10_000));
      continue;
    }
    throw new HttpError(`HTTP ${res.status}`, res.status);
  }
}
