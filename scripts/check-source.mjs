import { ARCHIVE, districtLinks, electionIndex, loadBooths, parseDistrict, readPage } from '../lib/vec.mjs';

const [url, html] = await electionIndex();
const index = html ? url : ARCHIVE;
const links = districtLinks(html ?? await readPage(ARCHIVE), index);
console.log(html ? `2026 public index: ${links.size} recognised district links` : '2026 public index not published at the checked URL; testing the 2022 archive.');
if (links.size !== (html ? 88 : 87)) throw new Error('Unexpected VEC index format');
for (const id of html ? ['caulfield', 'bass'] : ['bass']) {
  const source = links.get(id);
  const row = parseDistrict(await readPage(source), source);
  const booths = await loadBooths(row);
  console.log(`${id}: ${row.fp.length} candidates, ${row.fp.reduce((n,c) => n + (c.votes ?? 0),0)} formal votes, district TCP ${row.twoStatus}, ${booths.booths.length} first-preference venues, ${booths.tcp?.booths?.length ?? 0} TCP venues`);
  if (!row.fp.length || !row.enrolled || !booths.booths.length || booths.tcp?.status === 'unavailable') throw new Error(`Unexpected VEC results for ${id}`);
  if (!html && (row.fp.length !== 10 || row.elected?.name !== 'CRUGNALE, Jordan' || booths.booths.length !== 24 || booths.tcp?.booths?.length !== 24)) throw new Error('Unexpected Bass archive results');
}
