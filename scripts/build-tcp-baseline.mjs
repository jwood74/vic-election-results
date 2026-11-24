import { writeFile } from 'node:fs/promises';
import { ARCHIVE, districtLinks, parseDistrict, parseTcpBooths, readPage } from '../lib/vec.mjs';
import history from '../public/data/history-2022.json' with { type: 'json' };

const index = await readPage(ARCHIVE);
if (!index) throw new Error('VEC archive unavailable');
const links = [...districtLinks(index, ARCHIVE)];
if (links.length !== 87) throw new Error(`Unexpected size of archive district index: ${links.length}`);

const districts = {}, missing = [];
let next = 0;
async function fetchWithRetry(url) {
  try { return await readPage(url, 8000); }
  catch { return readPage(url, 8000); }
}
await Promise.all(Array.from({length:5}, async () => {
  while (next < links.length) {
    const [id,url] = links[next++];
    const page = await fetchWithRetry(url);
    if (!page) throw new Error(`Missing archive district page: ${id}`);
    const district = parseDistrict(page,url);
    if (!district.tcpUrl) { missing.push(id); continue; }
    const tcpPage = await fetchWithRetry(district.tcpUrl);
    if (!tcpPage) { missing.push(id); continue; }
    // 2022 reports pooled early TCP, not comparable venue-level early TCP.
    const venues = history.districts[id].filter(([kind]) => kind === 'ordinary').map(([kind,name]) => ({kind,name}));
    const data = parseTcpBooths(tcpPage,district,venues);
    if (!data.booths.length) { missing.push(id); continue; }
    districts[id] = { source:district.tcpUrl, ...data };
  }
}));
const result = { source: ARCHIVE, missing: missing.sort(), districts: Object.fromEntries(Object.entries(districts).sort(([a],[b]) => a.localeCompare(b))) };
await writeFile(new URL('../public/data/tcp-2022.json',import.meta.url), `${JSON.stringify(result)}\n`);
console.log(`${Object.keys(districts).length} districts, ${Object.values(districts).reduce((n,d) => n + d.booths.length,0)} ordinary booths; missing: ${result.missing.join(', ') || 'none'}`);
