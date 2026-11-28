import { load } from 'cheerio';
import roster from '../public/data/districts.json' with { type: 'json' };
import tcpHistory from '../public/data/tcp-2022.json' with { type: 'json' };
import comparisonHistory from '../public/data/booth-comparisons.json' with { type: 'json' };
import districtHistory from '../public/data/district-totals-2022.json' with { type: 'json' };
import { boothKey, finalTcp, historicalBoothTcp, venueKey } from '../public/model.js';
import { projectDistrict } from '../public/projection.js';

export const districts = roster;
export const VEC = 'https://www.vec.vic.gov.au';
const BASE = '/results/state-election-results';
export const INDEX = `${VEC}${BASE}`;
export const ARCHIVE = `${INDEX}/2022-state-election-results`;
const LIVE_BASE = '/results/2026-results';
export const EXPECTED = `${VEC}${LIVE_BASE}/district-election-page`;
const clean = s => s.replace(/\s+/g, ' ').trim();
const count = s => /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(s) && Number.isSafeInteger(Number(s.replaceAll(',', ''))) ? Number(s.replaceAll(',', '')) : null;
const nameKey = s => clean(s).toLowerCase();

function publicUrl(href, from) {
  try {
    const u = new URL(href, from);
    const allowed = u.pathname.startsWith(`${BASE}/`) || u.pathname.startsWith(`${LIVE_BASE}/district-election-page/`) || u.pathname === `${LIVE_BASE}/district-election-page`;
    return u.origin === VEC && allowed && !u.username && !u.password && !u.search && !/%|\\/.test(u.pathname)
      ? `${u.origin}${u.pathname.replace(/\/$/, '')}` : null;
  } catch { return null; }
}

export async function readPage(url, timeout = 4000) {
  if (url !== INDEX && publicUrl(url, VEC) !== url) throw new Error('Not an allowed VEC results URL');
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'VicElectionResults/1.0 (periodic public election results reader)', Accept: 'text/html' } });
  if (res.status === 404) return null;
  if (!res.ok || !res.headers.get('content-type')?.includes('text/html')) throw new Error(`Unexpected VEC response: ${res.status}`);
  return res.text();
}

export async function electionIndex(get = readPage) {
  if (process.env.VEC_RESULTS_PATH) {
    const configured = publicUrl(process.env.VEC_RESULTS_PATH, VEC);
    if (!configured || !/2026/.test(new URL(configured).pathname)) throw new Error('Invalid VEC_RESULTS_PATH');
    return [configured, await get(configured)];
  }
  const expected = await get(EXPECTED);
  if (expected !== null) return [EXPECTED, expected];
  const $ = load(await get(INDEX) ?? '');
  const links = $('main a[href]').map((_, a) => publicUrl($(a).attr('href'), INDEX)).get();
  const discovered = links.find(u => u !== EXPECTED && /\/2026[^/]*state[^/]*election[^/]*$/i.test(u));
  return discovered ? [discovered, await get(discovered)] : [EXPECTED, null];
}

export function districtLinks(html, index) {
  const $ = load(html);
  const found = new Map();
  for (const a of $('main a[href]').toArray()) {
    const url = publicUrl($(a).attr('href'), index);
    if (!url?.startsWith(`${index}/results-by-district/`)) continue;
    const id = url.slice(`${index}/results-by-district/`.length).match(/^([a-z0-9-]+)-district-results$/i)?.[1].toLowerCase();
    if (id && Object.hasOwn(districts, id)) found.set(id, url);
  }
  return found;
}

function tableByHeader($, predicate) {
  return $('main table').toArray().find(t => predicate($(t).find('thead tr').first().find('th').map((_, th) => clean($(th).text()).toLowerCase()).get()));
}

function candidateRows($, table, partyFirst = false) {
  if (!table) return [];
  const rows = [];
  for (const tr of $(table).find('tbody tr').toArray()) {
    const cells = $(tr).children('td').map((_, td) => clean($(td).text())).get();
    const [name, party] = partyFirst ? [cells[1], cells[0]] : cells;
    if (cells.length !== 4 || !name) continue;
    const votes = count(cells[2]);
    // The VEC may show empty cells or dashes before the count. These are not zeros.
    if (votes === null && !/^(?:[-—–]|n\/a)?$/i.test(cells[2])) throw new Error('Unrecognised candidate-vote cell');
    rows.push({ name, party: party || 'Independent', votes });
  }
  if (new Set(rows.map(r => nameKey(r.name))).size !== rows.length) throw new Error('Duplicate candidate names');
  return rows;
}

function electedName($) {
  const heading = $('main h2, main h3, main h4').filter((_, el) => /^(?:elected member|successful candidate)$/i.test(clean($(el).text()))).first();
  const content = heading.next();
  return clean(content.find('b, strong').first().text() || content.text());
}

export function parseFinalResult(html) {
  const $ = load(html);
  const table = tableByHeader($, h => h[0] === 'candidate' && h[1] === 'party' && h[2] === 'votes after distribution');
  const primary = tableByHeader($, h => h[0] === 'candidate' && h[1] === 'party' && /1st pref|first pref/.test(h[2] ?? ''));
  const winner = candidateRows($, primary).find(row => nameKey(row.name) === nameKey(electedName($)));
  if (!winner) return null;
  const validRows = rows => rows.length >= 2 && rows.every(row => row.votes !== null) &&
    rows[0].votes > rows[1].votes && nameKey(rows[0].name) === nameKey(winner.name);
  const sorted = table => candidateRows($, table).sort((a, b) => b.votes - a.votes);
  const rows = sorted(table);
  if (table) return validRows(rows) ? { winner, rows, kind:'distribution' } : null;

  // Some district pages publish a separate indicative TCP tally but no distribution.
  const tcp = $('main h3, main h2, main h4').filter((_, el) => /^two.candidate preferred results$/i.test(clean($(el).text()))).first().parent().find('table').first().get(0);
  const preferred = sorted(tcp);
  return validRows(preferred) && preferred.length === 2 ? { winner, rows:preferred, kind:'published-tcp' } : { winner, rows:[], kind:'declaration' };
}

export function parseDistrict(html, source) {
  const $ = load(html);
  const voteHeaders = h => h[0] === 'candidate' && h[1] === 'party';
  const primary = tableByHeader($, h => voteHeaders(h) && /1st pref|first pref/.test(h[2] ?? ''));
  const heading = $('main h1').text();
  if (!primary && !/district.*results|results.*district/i.test(heading)) throw new Error('Unrecognised district results page');
  const fp = candidateRows($, primary);
  const twoContainer = $('main h2, main h3, main h4').filter((_, el) => /^two.candidate preferred results$/i.test(clean($(el).text()))).first().parent();
  const twoTable = twoContainer.find('table').first().get(0);
  const headings = $(twoTable).find('thead tr').first().find('th').map((_, el) => clean($(el).text()).toLowerCase()).get();
  const statusText = clean(twoContainer.text());
  const replaced = /replaced by (?:the )?preference distribution/i.test(statusText);
  const suppressed = /withheld|not (?:be )?(?:published|available)|not currently (?:published|available)/i.test(statusText);
  const partyFirst = headings[0] === 'party' && headings[1] === 'candidate' && headings[2] === 'preferred votes';
  const two = !replaced && !suppressed && (partyFirst || voteHeaders(headings)) ? candidateRows($, twoTable, partyFirst) : [];
  if (two.length && (two.length !== 2 || two.some(r => !fp.some(f => nameKey(f.name) === nameKey(r.name))))) throw new Error('Invalid 2CP pairing');
  const declaredName = electedName($);
  const elected = fp.find(row => nameKey(row.name) === nameKey(declaredName)) ?? null;
  const enrolment = $('main .list-item-title').filter((_, el) => /^total (?:enrolment as at close of rolls|enrolled voters):?$/i.test(clean($(el).text())));
  const enrolled = enrolment.length === 1 ? count(clean(enrolment.next('.list-item-body').text())) : null;
  const links = $('main a[href]').toArray();
  const booth = links.find(a => $(a).attr('id') === 'FPVResultsLink' || /(?:first preference|primary|recheck|latest).*results by voting cent(?:re|er)/i.test(clean($(a).text())));
  const boothUrl = booth && publicUrl($(booth).attr('href'), source);
  const tcp = links.find(a => $(a).attr('id') === 'TwoCPLink' || /(?:\b(?:2CP|TCP)\b|two[- ]candidate[- ]preferred).*results by voting cent(?:re|er)/i.test(clean($(a).text())));
  const tcpUrl = tcp && publicUrl($(tcp).attr('href'), source);
  return { source, fp, two, twoStatus: replaced ? 'replaced' : suppressed ? 'withheld' : two.some(r => r.votes > 0) ? 'reported' : 'unavailable', elected, enrolled, boothUrl: boothUrl?.startsWith(`${source}/`) ? boothUrl : null, tcpUrl: tcpUrl?.startsWith(`${source}/`) && tcpUrl !== boothUrl ? tcpUrl : null };
}

function venueSection(label) {
  if (/^(?:ordinary votes|election[ -]day voting centres?|voting centres?)$/i.test(label)) return 'ordinary';
  if (/^(?:early votes|early voting centres?|pre[ -]?poll(?: votes| voting centres?)?)$/i.test(label)) return 'early';
  if (/^(?:declaration votes|mobile(?: early)? voting|other votes|postal votes)$/i.test(label)) return 'excluded';
  return null;
}

const nonVenue = /^(?:total\b|percentage\b|all votes\b|other early\b|mobile\b|absent\b|postal\b|provisional\b|marked as voted\b)|\btotal$/i;
const pooledTypes = [
  ['postal', 'Postal votes', /^postal(?: votes?)?(?: total)?$/i],
  ['absent', 'Absent votes', /^absent(?: votes?)?(?: total)?$/i],
  ['provisional', 'Provisional votes', /^provisional(?: votes?)?(?: total)?$/i],
  ['marked', 'Marked as voted', /^marked as voted(?: votes?)?(?: total)?$/i],
  ['mobile', 'Mobile votes', /^mobile(?: voting| votes)?(?: total)?$/i],
  ['mobile-early', 'Mobile prepoll votes', /^mobile early(?: voting| votes)?(?: total)?$/i],
  ['other-early', 'Other prepoll votes', /^other (?:early|pre[ -]?poll)(?: votes)?(?: total)?$/i],
  ['early-total', 'Prepoll total', /^(?:early votes|pre[ -]?poll(?: votes)?)(?: total)?$/i],
  ['declaration', 'Declaration votes', /^declaration votes(?: total)?$/i],
];
const pooledType = name => pooledTypes.find(([, , pattern]) => pattern.test(name));
const declarationParts = ['postal', 'absent', 'provisional', 'marked'];
function pooledRows(rows, booths) {
  if (declarationParts.some(kind => rows.has(kind))) rows.delete('declaration');
  if (booths.some(b => b.kind === 'early')) rows.delete('early-total');
  else if (rows.has('early-total')) rows.delete('other-early');
  return [...rows.values()];
}

function venueHeaders($, table) {
  const rows = $(table).find('thead tr').toArray().map(tr => $(tr).children('th').toArray());
  if (rows.length === 1) {
    // The live site puts the candidate name in the sort link and their party below it.
    const labels = rows[0].map(cell => clean($(cell).children('a').first().text() || $(cell).text()));
    return [labels, labels];
  }
  return rows.map(cells => cells.map(cell => clean($(cell).text())));
}

function venueCandidate(name, candidates, live) {
  const key = nameKey(name);
  const exact = candidates.find(c => nameKey(c.name) === key);
  if (exact || !live || !key) return exact;
  // The live booth pages can shorten compound names, e.g. Hsiang-Han to Hsiang.
  const matches = candidates.filter(c => [' ', '-', ','].some(separator => nameKey(c.name).startsWith(key + separator)));
  return matches.length === 1 ? matches[0] : undefined;
}

export function parseBooths(html, expected) {
  const $ = load(html);
  const table = $('main table').toArray().find(t => venueHeaders($, t)[1]?.at(-1)?.toLowerCase() === 'total votes polled');
  if (!table || !expected.length) throw new Error('Unrecognised first-preference voting-centre table');
  const [cols] = venueHeaders($, table);
  const candidates = cols.slice(1, -2).map(name => venueCandidate(name, expected, $(table).find('thead tr').length === 1));
  if (candidates.length !== expected.length || candidates.some(c => !c) || new Set(candidates).size !== expected.length) throw new Error('Voting-centre candidate headers do not match district totals');
  const booths = [];
  const pooled = new Map();
  let earlyPool;
  let section = null;
  for (const tr of $(table).find('tbody tr').toArray()) {
    const cells = $(tr).children('th, td');
    const name = clean(cells.first().text());
    const kind = venueSection(name);
    if (kind && (cells.length !== cols.length || cells.slice(1).toArray().every(c => !clean($(c).text())))) { section = kind; continue; }
    const pool = pooledType(name);
    if ((!pool && (kind || !section || section === 'excluded' || !name || nonVenue.test(name))) || cells.length !== cols.length) continue;
    const votes = candidates.map((_, i) => count(clean(cells.eq(i + 1).text())));
    const informal = count(clean(cells.eq(-2).text()));
    const total = count(clean(cells.last().text()));
    if (votes.every(v => v === null) && !(total > 0)) {
      if (!pool) booths.push({ name, kind:section, votes });
      continue;
    }
    if (votes.some(v => v === null) || informal === null || total !== votes.reduce((a, b) => a + b, informal)) {
      if (pool) continue;
      throw new Error(`Invalid booth totals: ${name}`);
    }
    if (pool) {
      const [kind, name] = pool;
      pooled.set(kind, {kind,name,votes});
      if (kind === 'early-total') earlyPool = votes;
      continue;
    }
    booths.push({ name, kind: section, votes });
  }
  return { candidates, booths, pooled:pooledRows(pooled,booths), ...(earlyPool ? {earlyPool} : {}) };
}

export function parseTcpBooths(html, row, venues) {
  const $ = load(html);
  const header = t => {
    const [names, labels] = venueHeaders($, t);
    return [names?.map(name => /^(?:miss?[- ]?sorts|informal votes|total votes(?: polled)?)$/i.test(name) ? '' : name), labels];
  };
  const table = $('main table').toArray().find(t => {
    const [first, second] = header(t);
    return first?.length >= 5 && second?.length === first.length && /^(?:total votes polled|total votes)$/i.test(second.at(-1)) && first.slice(1).filter(Boolean).length === 2;
  });
  if (!table) throw new Error('Unrecognised TCP voting-centre table');
  const [headers, labels] = header(table);
  const positions = headers.map((name, i) => name && i > 0 ? i : -1).filter(i => i > 0);
  const pair = positions.map(i => venueCandidate(headers[i], row.fp, $(table).find('thead tr').length === 1));
  if (pair.some(c => !c) || new Set(pair).size !== 2) throw new Error('TCP voting-centre candidate headers do not match district candidates');
  if (row.two?.length && !row.two.every(c => pair.some(p => nameKey(p.name) === nameKey(c.name)))) throw new Error('TCP voting-centre pair differs from the district pair');
  const byName = new Map();
  for (const venue of venues) {
    const key = venueKey(venue.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(venue);
  }
  const found = new Map();
  const pooled = new Map();
  let earlyPool, districtTotal;
  let section = null;
  for (const tr of $(table).find('tbody tr').toArray()) {
    const cells = $(tr).children('th, td').map((_, td) => clean($(td).text())).get();
    const name = cells[0];
    if (!name) continue;
    const kind = venueSection(name);
    if (kind && (cells.length !== headers.length || cells.slice(1).every(s => !s))) { section = kind; continue; }
    const pool = pooledType(name);
    const isTotal = /^(?:total(?: two[- ]candidate[- ]preferred votes)?|all votes)$/i.test(name);
    if ((!pool && !isTotal && (kind || section === 'excluded' || nonVenue.test(name))) || cells.length !== headers.length) continue;
    const matches = (byName.get(venueKey(name)) ?? []).filter(v => !section || v.kind === section);
    if (!pool && !isTotal && matches.length !== 1) continue;
    const votes = positions.map(i => count(cells[i]));
    const total = count(cells.at(-1));
    if (votes.some(v => v === null) || (!pool && !votes.some(v => v > 0))) continue;
    const extras = labels.map((label, i) => /^(?:miss?[- ]?sorts|informal votes)$/i.test(label) ? count(cells[i]) : 0);
    if (total === null || extras.some(v => v === null) || votes.reduce((a,b) => a+b, 0) + extras.reduce((a,b) => a+b, 0) !== total) continue;
    if (isTotal) { districtTotal = votes; continue; }
    if (pool) {
      const [kind,name] = pool;
      pooled.set(kind, {kind,name,votes});
      if (kind === 'early-total') earlyPool = votes;
      continue;
    }
    const key = boothKey(matches[0]);
    found.set(key, found.has(key) ? null : { name: matches[0].name, kind: matches[0].kind, votes });
  }
  const booths = [...found.values()].filter(Boolean);
  return { pair: pair.map(({name, party}) => ({name, party})), booths, pooled:pooledRows(pooled,booths), ...(earlyPool ? {earlyPool} : {}), ...(districtTotal ? {districtTotal} : {}) };
}

export async function collect(previous, get = readPage, now = () => new Date().toISOString()) {
  const at = now();
  const started = Date.now();
  const [source, html] = await electionIndex(get);
  if (!html) return previous?.results?.length ? { ...previous, status: 'stale' } : { status: 'waiting', at, source: INDEX, results: [] };
  const links = [...districtLinks(html, source)];
  if (!links.length) return previous?.results?.length ? { ...previous, status: 'stale' } : { status: 'unverified', at, source, results: [] };
  const retained = new Map(previous?.results?.filter(r => r.fp.some(c => c.votes > 0) || r.elected).map(r => [r.id, r]));
  const results = [];
  let failures = 0;
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(12, links.length) }, async () => {
    while (cursor < links.length && Date.now() - started < 20_000) {
      const [id, url] = links[cursor++];
      try {
        const page = await get(url, 2800);
        if (!page) throw new Error('District results page missing');
        const row = parseDistrict(page, url);
        if (!row.fp.length && retained.has(id)) throw new Error('Previously published first preferences are missing');
        results.push({ id, ...row, at });
      } catch (err) {
        failures++;
        console.warn(`VEC ${id}: ${err.message}`);
      }
    }
  }));
  await collectProjections(results,retained,get,at,started+26_000);
  for (const row of results) retained.delete(row.id);
  const loaded = results.length;
  for (const row of retained.values()) results.push({ ...row, stale: true });
  return { status: loaded === links.length && links.length === 88 ? 'ok' : loaded || results.length ? 'partial' : 'unverified', at, source, loaded, listed: links.length, missing: failures + links.length - cursor, results: results.sort((a, b) => a.id.localeCompare(b.id)) };
}

async function collectProjections(rows, previous, get, at, deadline) {
  const {default: historicalResults} = await import('../public/data/historical-results.json', {with:{type:'json'}});
  const queue = [];
  const countKey = r => JSON.stringify([r.fp,r.two,r.twoStatus,r.enrolled,r.boothUrl,r.tcpUrl]);
  for (const row of rows) {
    if (!row.boothUrl || row.elected || ['withheld','replaced'].includes(row.twoStatus) || !row.fp.some(c => c.votes > 0)) continue;
    const old = previous.get(row.id);
    const data = comparisonHistory.districts[row.id];
    const result = historicalResults[row.id];
    const tcp = historicalBoothTcp(result, data?.tcp ?? tcpHistory.districts[row.id]);
    if (!tcp) continue;
    if (old?.projectionCheckedAt) row.projectionCheckedAt = old.projectionCheckedAt;
    // Reuse a recent projection only while all of its published district inputs still match.
    if (!old?.stale && old?.projection?.baseline === 'final-results-v2' && countKey(old) === countKey(row) && Date.parse(at)-Date.parse(old.projectionCheckedAt) < 10*60_000) {
      row.projection = old.projection;
      continue;
    }
    const fp = districtHistory.districts[row.id] ?? (data?.fp && [...data.fp.map(b => b[2]),...Object.values(data.pooled ?? {})].reduce((totals,votes) => {
      for (const [party,v] of Object.entries(votes)) totals[party] = (totals[party] ?? 0) + v;
      return totals;
    },{}));
    queue.push({row,baseline:{tcp,final:finalTcp(result),fp,moved:data?.moved}});
  }
  // Rotate by last attempt so the same slow or late-listed districts don't monopolise the budget.
  queue.sort((a,b) => (a.row.projectionCheckedAt ?? '').localeCompare(b.row.projectionCheckedAt ?? ''));
  let next = 0;
  await Promise.all(Array.from({length:Math.min(12,queue.length)},async () => {
    while (next < queue.length && deadline-Date.now() >= 500) {
      const {row,baseline} = queue[next++];
      row.projectionCheckedAt = at;
      try {
        const detail = await loadBooths(row,url => get(url,Math.min(2000,Math.max(1,deadline-Date.now()))));
        const projection = projectDistrict(row,detail,baseline);
        if (projection) row.projection = {...projection,baseline:'final-results-v2'};
      } catch (err) { console.warn(`VEC projection ${row.id}: ${err.message}`); }
    }
  }));
}

export async function loadBooths(row, get = readPage) {
  if (!row?.boothUrl || row.stale) return { status: 'waiting', booths: [] };
  const mayReadTcp = row.tcpUrl && row.twoStatus !== 'withheld';
  const [html, tcpPage] = await Promise.all([get(row.boothUrl), mayReadTcp ? get(row.tcpUrl).catch(() => undefined) : null]);
  if (!html) return { status: 'waiting', booths: [] };
  const parsed = parseBooths(html, row.fp);
  let tcp = { status: row.twoStatus === 'withheld' ? 'withheld' : tcpPage === undefined ? 'unavailable' : 'waiting' };
  if (tcpPage) {
    try { tcp = { status: 'ok', ...parseTcpBooths(tcpPage, row, parsed.booths), source: row.tcpUrl }; }
    catch (err) { console.warn(`VEC TCP ${row.id ?? row.source}: ${err.message}`); tcp = { status: 'unavailable' }; }
  }
  return { status: 'ok', ...parsed, tcp, source: row.boothUrl, at: new Date().toISOString() };
}
