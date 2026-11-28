import { getStore } from '@netlify/blobs';
import { collect } from '../../lib/vec.mjs';

const pollsClose = Date.parse('2026-11-28T18:00:00+11:00');
const sunday = Date.parse('2026-11-29T00:00:00+11:00');
const monday = Date.parse('2026-11-30T00:00:00+11:00');

export default async function () {
  const now = Date.now();
  const interval = now < sunday ? 1 : now < monday ? 5 : 15;
  if (now < pollsClose || new Date(now).getUTCMinutes() % interval !== 0) return new Response(null, { status: 204 });
  const store = getStore({ name: 'vic-count', consistency: 'strong' });
  const previous = await store.get('latest', { type: 'json' });
  try {
    const snapshot = await collect(previous);
    await store.setJSON('latest', snapshot);
    console.log(`VEC collection: ${snapshot.status}; ${snapshot.loaded ?? 0}/${snapshot.listed ?? 0} matched districts`);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (!previous) await store.setJSON('latest', { status: 'unverified', at: new Date().toISOString(), results: [] });
    throw err;
  }
}

export const config = { schedule: '* * * * *' };
