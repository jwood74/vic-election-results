import { ARCHIVE, districtLinks, electionIndex, loadBooths, parseDistrict, readPage } from '../lib/vec.mjs';

const [url, html] = await electionIndex();
const index = html ? url : ARCHIVE;
const links = districtLinks(html ?? await readPage(ARCHIVE), index);
console.log(html ? `2026 public index: ${links.size} recognised district links` : '2026 public index not published at the checked URL; testing the 2022 archive.');
if (!links.has('bass') || (!html && links.size !== 87)) throw new Error('Unexpected VEC index format');
const row = parseDistrict(await readPage(links.get('bass')), links.get('bass'));
const booths = await loadBooths(row);
console.log(`Bass: ${row.fp.length} candidates, district TCP ${row.twoStatus}, ${booths.booths.length} first-preference venues, ${booths.tcp?.booths?.length ?? 0} TCP venues`);
if (!html && (row.fp.length !== 10 || row.elected?.name !== 'CRUGNALE, Jordan' || booths.booths.length !== 24 || booths.tcp?.booths?.length !== 24)) throw new Error('Unexpected Bass archive results');
