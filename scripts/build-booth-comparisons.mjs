import { readFile, writeFile } from 'node:fs/promises';
import { INDEX, loadBooths, parseDistrict, readPage } from '../lib/vec.mjs';
import { boothKey } from '../public/model.js';

const fromRoot = name => new URL(`../${name}`, import.meta.url);
const json = async name => JSON.parse(await readFile(fromRoot(name), 'utf8'));
const hybrid = await json('booth-match-estimates.json');
const spatial = await json('booth-match-estimates-coordinates.json');
const audit = await readFile(fromRoot('booth-match-audit.csv'), 'utf8');
// Parse CSV cells, including quoted venue names and commas in street addresses.
const rows = [...audit.matchAll(/(?:^|\n)((?:"(?:[^"]|"")*"|[^\r\n,]*)(?:,(?:"(?:[^"]|"")*"|[^\r\n,]*))*)/g)]
  .slice(1).map(([,line]) => [...line.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)].map(([,quoted,plain]) => quoted?.replaceAll('""','"') ?? plain));
const districts = {};
for (const [id, entries] of Object.entries(hybrid.districts)) districts[id] = { estimates:entries };
for (const [id, name,,,,,outcome] of rows) {
  if (outcome !== 'review moved same label') continue;
  const d = districts[id] ??= {estimates:[]};
  (d.moved ??= []).push(name);
  const estimate = spatial.districts[id]?.find(b => boothKey(b) === boothKey({name,kind:'ordinary'}));
  if (estimate) d.estimates.push(estimate);
}

const source = `${INDEX}/state-by-elections-timeline/narracan-district-supplementary-election-results`;
const page = await readPage(source);
if (!page) throw new Error('Narracan supplementary result unavailable');
const data = await loadBooths(parseDistrict(page, source));
if (!data.booths.length || !data.tcp?.booths?.length) throw new Error('Narracan supplementary booth data missing');
const partyTotals = counts => {
  const votes = new Map();
  data.candidates.forEach((c,i) => votes.set(c.party,(votes.get(c.party) ?? 0) + counts[i]));
  return Object.fromEntries(votes);
};
districts.narracan = { year:2023, source, estimates:[], fp:data.booths.map(b => [b.kind,b.name,partyTotals(b.votes)]),
  pooled:Object.fromEntries(data.pooled.map(b => [b.kind,partyTotals(b.votes)])),
  ...(data.earlyPool ? {fpEarlyPool:partyTotals(data.earlyPool)} : {}), tcp:{pair:data.tcp.pair,booths:data.tcp.booths,earlyPool:data.tcp.earlyPool,pooled:data.tcp.pooled,districtTotal:data.tcp.districtTotal} };
const sorted = Object.fromEntries(Object.entries(districts).sort(([a],[b]) => a.localeCompare(b)));
await writeFile(fromRoot('public/data/booth-comparisons.json'), `${JSON.stringify({districts:sorted})}\n`);
console.log(`${Object.values(districts).reduce((n,d) => n+d.estimates.length,0)} spatial baselines; ${Object.values(districts).reduce((n,d) => n+(d.moved?.length ?? 0),0)} moved labels; ${data.booths.length} Narracan booths.`);
