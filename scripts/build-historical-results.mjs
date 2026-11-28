import { writeFile } from 'node:fs/promises';
import { ARCHIVE, INDEX, districtLinks, parseFinalResult, readPage } from '../lib/vec.mjs';

const index = await readPage(ARCHIVE, 8000);
if (!index) throw new Error('VEC archive unavailable');
const links = [...districtLinks(index, ARCHIVE)];
if (links.length !== 87) throw new Error(`Unexpected size of archive district index: ${links.length}`);
links.push(['narracan', `${INDEX}/state-by-elections-timeline/narracan-district-supplementary-election-results`]);

const results = {};
let next = 0;
await Promise.all(Array.from({length:5}, async () => {
  while (next < links.length) {
    const [id, source] = links[next++];
    const page = await readPage(source, 8000).catch(() => readPage(source, 8000));
    const result = page && parseFinalResult(page);
    if (!result) throw new Error(`Missing or unverified historical result for ${id}`);
    results[id] = { year:id === 'narracan' ? 2023 : 2022, source, ...result };
  }
}));
const sorted = Object.fromEntries(Object.entries(results).sort(([a],[b]) => a.localeCompare(b)));
await writeFile(new URL('../public/data/historical-results.json', import.meta.url), `{\n${Object.entries(sorted).map(([id, result]) => `  ${JSON.stringify(id)}: ${JSON.stringify(result)}`).join(',\n')}\n}\n`);
console.log(`Verified final results for ${Object.keys(sorted).length} districts.`);
