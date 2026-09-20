import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { HttpError } from './errors.js';

export function publicAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b)));
  }
  return isIP(ip) === 6 && /^[23]/.test(ip) && !ip.toLowerCase().startsWith('2001:db8:');
}

export async function safeFetch(input, options = {}) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new HttpError(400, 'Only public HTTPS upstreams are allowed');
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new HttpError(400, 'Private or reserved upstream addresses are not allowed');
  const chosen = addresses.find(a => a.family === 4) || addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: options.method || 'GET', headers: options.headers, signal: options.signal,
      lookup: (_host, opts, cb) => opts.all ? cb(null, [chosen]) : cb(null, chosen.address, chosen.family),
    }, res => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const status = res.statusCode;
      const response = new Response([204, 205, 304].includes(status) ? null : Readable.toWeb(res), { status, headers });
      Object.defineProperty(response, 'url', { value: url.href });
      resolve(response);
    });
    req.once('error', reject);
    req.end(options.body);
  });
}

export async function discoverOrigin(config, fetcher = safeFetch) {
  let url = new URL(config.publicUrl);
  for (let hop = 0; hop < 6; hop++) {
    const response = await fetcher(url.href, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "sec-ch-ua": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "Upgrade-Insecure-Requests": "1"
      },
      signal: AbortSignal.timeout(15000)
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new HttpError(502, 'Entry redirect has no Location');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, `Entry HTTP ${response.status}`); }
    let html = '';
    for await (const chunk of response.body) {
      html += Buffer.from(chunk).toString('utf8');
      if (html.length > 2_000_000) throw new HttpError(502, 'Entry page too large');
    }
    const encoded = /"dd"\s*:\s*"([A-Za-z0-9+/=]+)"/.exec(html)?.[1];
    if (encoded && encoded.length > 10) {
      const host = Buffer.from(encoded.slice(5, -5), 'base64').toString('utf8');
      if (/^[a-z0-9.-]+$/i.test(host) && host !== url.hostname) { url = new URL(`https://${host}/`); continue; }
    }
    return url.origin;
  }
  throw new HttpError(502, 'Too many entry redirects');
}
