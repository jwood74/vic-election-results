import { load } from 'cheerio';
import { writeFile } from 'node:fs/promises';
import districts from '../public/data/districts.json' with { type: 'json' };
import { candidateKey } from '../public/predictions.js';

const ids = Object.keys(districts);
const entries = [];
for (let i = 0; i < ids.length; i += 6) {
  entries.push(...await Promise.all(ids.slice(i, i + 6).map(async id => {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid district: ${id}`);
    const response = await fetch(`https://www.vec.vic.gov.au/electoral-boundaries/state-districts/${id}-district/nominations`, {
      redirect:'error', signal:AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`Nominations for ${id}: HTTP ${response.status}`);
    const $ = load(await response.text());
    const candidates = $('main table').filter((_, el) => $(el).find('thead').text().includes('Contact details'))
      .find('tbody tr').toArray().map(tr => {
        const cell = $(tr).children('td').first();
        const party = cell.children('p').first().text().trim() || 'Independent';
        const name = cell.clone().children().remove().end().text().replace(/\s+/g, ' ').trim();
        if (!name) throw new Error(`Incomplete nomination in ${id}`);
        return { name, party };
      });
    if (!candidates.length || new Set(candidates.map(candidateKey)).size !== candidates.length) throw new Error(`Missing or duplicate nominations in ${id}`);
    return [id, candidates];
  })));
}
const data = Object.fromEntries(entries);
await writeFile(new URL('../public/data/candidates-2026.json', import.meta.url), `{
${entries.map(([id, candidates]) => `  ${JSON.stringify(id)}: ${JSON.stringify(candidates)}`).join(',\n')}
}\n`);
console.log(`Saved ${Object.values(data).flat().length} candidates across ${entries.length} districts.`);
