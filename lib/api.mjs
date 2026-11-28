import { districts, INDEX, loadBooths } from './vec.mjs';

export const pending = { status: 'waiting', at: null, results: [], source: INDEX };

export function api(readSnapshot, { readBooths, saveBooths, fetchBooths = loadBooths } = {}) {
  const requests = new Map();
  const lastGood = new Map();
  async function districtBooths(id, row, stale = false) {
    let detail;
    try { if (!stale && !row?.stale) detail = await fetchBooths(row); }
    catch (err) { console.warn(`VEC booths ${id}: ${err.message}`); }
    const cached = lastGood.get(id) ?? await readBooths?.(id).catch(err => {
      console.warn(`Booth backup ${id}: ${err.message}`);
    });
    const oldTcp = cached?.tcp;
    const samePair = row?.two?.length === 2 && oldTcp?.pair?.length === 2 && row.two.every(c => oldTcp.pair.some(p => p.name === c.name));
    if (detail?.status === 'ok') {
      // A separately failing TCP page must not erase the last count for the same pair.
      if (detail.tcp?.status === 'unavailable' && oldTcp?.status === 'ok' && samePair) {
        detail = {...detail, tcp:{...oldTcp, at:oldTcp.at ?? cached.at, stale:true}};
      }
      lastGood.set(id,detail);
      await saveBooths?.(id,detail).catch(err => console.warn(`Booth backup ${id}: ${err.message}`));
      return detail;
    }
    if (cached) {
      const tcp = row?.twoStatus === 'withheld' ? {status:'withheld'} : row?.two?.length === 2 && oldTcp?.status === 'ok' && !samePair ? {status:'unavailable'} : oldTcp;
      return {...cached, tcp, stale:true};
    }
    return detail ?? {status:stale || row?.stale ? 'stale' : 'unavailable', booths:[]};
  }
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
      const row = snapshot.results.find(r => r.id === id);
      const reply = detail => json(detail, detail.stale || detail.tcp?.stale || detail.status !== 'ok' ? 30 : 90);
      if (requests.has(id)) return reply(await requests.get(id));
      const promise = districtBooths(id,row,stale);
      requests.set(id, promise);
      try { return reply(await promise); }
      finally { requests.delete(id); }
    } catch (err) {
      console.error(err.message);
      return json({ status: 'unavailable' }, 0, 502);
    }
  };
}
