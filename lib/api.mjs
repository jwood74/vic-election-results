import { districts, INDEX, loadBooths } from './vec.mjs';

export const pending = { status: 'waiting', at: null, results: [], source: INDEX };

export function api(readSnapshot) {
  const requests = new Map();
  const json = (body, ttl = 0, status = 200) => Response.json(body, { status, headers: {
    'Cache-Control': 'no-cache',
    'Netlify-Vary': 'query=district',
    'Netlify-CDN-Cache-Control': ttl ? `public, durable, s-maxage=${ttl}, stale-while-revalidate=60, stale-if-error=300` : 'no-store',
  } });
  return async function results(request) {
    const url = new URL(request.url);
    const id = url.searchParams.get('district');
    if (request.method !== 'GET') return json({ status: 'method' }, 0, 405);
    if (id !== null && !Object.hasOwn(districts, id)) return json({ status: 'unknown' }, 0, 404);
    try {
      const snapshot = await readSnapshot() ?? pending;
      const expired = snapshot.at && Date.now() - Date.parse(snapshot.at) > 25 * 60_000;
      const stale = snapshot.status === 'stale' || (expired && snapshot.results.length > 0);
      if (id === null) return json(stale ? { ...snapshot, status: 'stale' } : snapshot, 45);
      if (stale) return json({ status: 'stale', booths: [] }, 45);
      const row = snapshot.results.find(r => r.id === id);
      if (requests.has(id)) return json(await requests.get(id), 90);
      const promise = loadBooths(row);
      requests.set(id, promise);
      try { return json(await promise, 90); }
      finally { requests.delete(id); }
    } catch (err) {
      console.error(err.message);
      return json({ status: 'unavailable' }, 0, 502);
    }
  };
}
