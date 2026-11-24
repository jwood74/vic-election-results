const norm = s => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[’‘]/g, "'");
export const venueKey = norm;
export const boothKey = ({ kind, name }) => `${kind}:${venueKey(name)}`;
const aliases = new Map([
  ['australian labor party - victorian branch', 'Labor'], ['australian labor party', 'Labor'], ['labor', 'Labor'],
  ['australian greens', 'Greens'], ['the greens', 'Greens'], ['greens', 'Greens'],
  ['liberal', 'Liberal'], ['liberal party', 'Liberal'], ['liberal party of australia', 'Liberal'],
  ['the nationals', 'Nationals'], ['nationals', 'Nationals'], ['national party of australia – victoria', 'Nationals'],
  ["pauline hanson's one nation", 'One Nation'], ['one nation', 'One Nation'],
]);
export const partyName = name => aliases.get(norm(name)) ?? name.trim();
const abbreviations = new Map(Object.entries({ Labor:'ALP', Liberal:'LIB', Nationals:'NAT', Greens:'GRN', 'One Nation':'ONP', Independent:'IND', Other:'OTH', 'Animal Justice Party':'AJP', 'Family First Victoria':'FFP', 'Family First':'FFP', 'Legalise Cannabis Victoria':'LCV', 'Victorian Socialists':'VS', Libertarian:'LDP', 'Freedom Party':'FPV', 'Freedom Party of Victoria':'FPV', 'Labour DLP':'DLP', 'Shooters, Fishers & Farmers Vic':'SFF', 'Shooters, Fishers and Farmers Party Victoria':'SFF', 'Transport Matters':'TMP', 'Angry Victorians Party':'AVP', 'Health Australia Party':'HAP', 'Companions and Pets Party':'CPP', "Fiona Patten's Reason Party":'REASON', "Derryn Hinch's Justice Party":'DHJP' }).map(([label, code]) => [norm(label),code]));
export const partyAbbreviation = label => {
  const name = partyName(label);
  return abbreviations.get(norm(name)) ?? (name.match(/[\p{L}\p{N}]+/gu)?.map(word => word.length ? [...word][0] : '').join('').toUpperCase() || 'OTH');
};
const partyKey = name => norm(partyName(name));
const tcpSide = candidate => partyKey(candidate.party) === 'independent' ? `ind:${norm(candidate.name)}` : `party:${partyKey(candidate.party)}`;
export const sum = values => values.reduce((a, b) => a + (b ?? 0), 0);
export const share = (n, d) => n !== null && d > 0 ? 100 * n / d : null;
export const majorParties = ['Labor', 'Liberal', 'Nationals', 'Greens', 'One Nation'];
export const partyCode = label => ({ Labor:'alp', Liberal:'lib', Nationals:'nat', Greens:'grn', 'One Nation':'onp', Independent:'ind' })[partyName(label)] ?? 'other';
export function partyVotes(candidates, votes = candidates.map(c => c.votes), groupOther = false) {
  const totals = new Map();
  candidates.forEach((candidate, i) => {
    if (votes[i] == null) return;
    const name = partyName(candidate.party);
    const label = groupOther && !majorParties.includes(name) ? 'Other' : name;
    totals.set(label, (totals.get(label) ?? 0) + votes[i]);
  });
  return totals;
}

export function race(row) {
  const pair = row?.twoStatus === 'reported' ? [...row.two].sort((a, b) => b.votes - a.votes) : [];
  const valid = pair.length === 2 && pair.every(c => Number.isSafeInteger(c.votes)) && sum(pair.map(c => c.votes)) > 0;
  const votes = valid ? pair[0].votes - pair[1].votes : null;
  return { leader: valid && votes > 0 ? pair[0] : null, gap: valid ? share(votes, sum(pair.map(c => c.votes))) : null, votes, tied: valid && votes === 0 };
}

export function statewide(rows) {
  const parties = new Map();
  const get = label => {
    const key = partyKey(label);
    if (!parties.has(key)) parties.set(key, { label: partyName(label), votes: 0, leading: 0, declared: 0 });
    return parties.get(key);
  };
  let reporting = 0;
  for (const r of rows) {
    if (r.fp.some(c => c.votes > 0)) {
      reporting++;
      for (const c of r.fp) if (c.votes !== null) get(c.party).votes += c.votes;
    }
    const leader = race(r).leader;
    if (r.elected) get(r.elected.party).declared++;
    else if (leader) get(leader.party).leading++;
  }
  const list = [...parties.values()].sort((a, b) => b.votes - a.votes || a.label.localeCompare(b.label));
  return { list, reporting, votes: sum(list.map(p => p.votes)), leading: sum(list.map(p => p.leading)), declared: sum(list.map(p => p.declared)) };
}

function unique(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    map.set(key, map.has(key) ? null : item);
  }
  return map;
}

export function matchedTcp(current, historical) {
  if (current?.status !== 'ok' || current.pair?.length !== 2) return new Map();
  const sides = current.pair.map(tcpSide);
  const oldSides = historical?.pair?.map(tcpSide) ?? [];
  const oldOrder = sides.map(side => oldSides.indexOf(side));
  const comparable = new Set(sides).size === 2 && oldSides.length === 2 && oldOrder.every(i => i >= 0);
  const oldBooths = unique(comparable ? historical.booths : [], boothKey);
  const result = unique(current.booths, boothKey);
  for (const [key, booth] of result) {
    const total = sum(booth?.votes ?? []);
    if (!total) { result.delete(key); continue; }
    const prior = oldBooths.get(key);
    const priorTotal = sum(prior?.votes ?? []);
    const shares = booth.votes.map(v => share(v,total));
    const swing = priorTotal ? shares.map((pct,i) => pct - share(prior.votes[oldOrder[i]],priorTotal)) : [null,null];
    result.set(key, { votes: booth.votes, shares, swing });
  }
  return result;
}

export function boothComparisons(booths, fp = [], tcp, extras = {}, currentTcp) {
  fp = extras.fp ?? fp;
  tcp = extras.tcp ?? tcp;
  const oldFp = unique(fp, ([kind,name]) => boothKey({kind,name}));
  const oldTcp = unique(tcp?.booths ?? [], boothKey);
  const current = unique(booths, boothKey);
  const nearby = unique(extras.estimates ?? [], boothKey);
  const moved = new Set((extras.moved ?? []).map(venueKey));
  const fpPool = new Map(), tcpPool = new Map();
  for (const record of oldFp.values()) {
    if (!record) continue;
    const [kind,,votes] = record;
    if (!fpPool.has(kind)) fpPool.set(kind,new Map());
    const pool = fpPool.get(kind);
    for (const [party,count] of Object.entries(votes)) pool.set(party,(pool.get(party) ?? 0)+count);
  }
  for (const b of oldTcp.values()) {
    if (!b) continue;
    const pool = tcpPool.get(b.kind) ?? [0,0];
    b.votes.forEach((vote,i) => { pool[i] += vote; });
    tcpPool.set(b.kind,pool);
  }
  const comparisons = new Map();
  const tcpResults = matchedTcp(currentTcp);
  for (const [key, booth] of current) {
    if (!booth) continue;
    const same = booth.kind !== 'ordinary' || !moved.has(venueKey(booth.name));
    const estimate = nearby.get(key);
    const directFp = same ? oldFp.get(key)?.[2] : null;
    const pool = fpPool.get(booth.kind);
    const fpProxy = pool ? Object.fromEntries(pool) : booth.kind === 'early' ? extras.fpEarlyPool : null;
    const fpVotes = directFp ?? estimate?.firstPreferences ?? fpProxy;
    const fpMethod = directFp ? 'Booth match' : estimate?.firstPreferences ? (estimate.method === 'close 100%' ? 'Nearby booth' : 'Spatial estimate') : fpProxy ? 'District proxy' : null;
    const directTcp = same ? oldTcp.get(key)?.votes : null;
    const historicalPair = estimate?.tcp?.pair ?? tcp?.pair;
    const tcpVotes = directTcp ?? estimate?.tcp?.votes ?? tcpPool.get(booth.kind) ?? (booth.kind === 'early' ? tcp?.earlyPool : null);
    const tcpMethod = directTcp ? 'Booth match' : estimate?.tcp ? (estimate.method === 'close 100%' ? 'Nearby booth' : 'Spatial estimate') : tcpVotes ? 'District proxy' : null;
    const tcpNow = tcpResults.get(key);
    if (tcpNow && tcpVotes && historicalPair?.length === 2) {
      const sides = currentTcp.pair.map(tcpSide);
      const previous = historicalPair.map(tcpSide);
      const order = sides.map(side => previous.indexOf(side));
      const total = sum(tcpVotes);
      if (total && new Set(sides).size === 2 && order.every(i => i >= 0)) {
        tcpNow.swing = tcpNow.shares.map((value,i) => value-share(tcpVotes[order[i]],total));
        tcpNow.method = tcpMethod;
      }
    }
    comparisons.set(key,{fpVotes,fpMethod,tcp:tcpNow,year:extras.year ?? 2022});
  }
  return comparisons;
}

export function matchedSwing(candidates, booths, history = []) {
  const oldKey = ([kind, name]) => `${kind}:${norm(name)}`;
  const newKey = ({ kind, name }) => oldKey([kind, name]);
  const previous = unique(history, oldKey);
  const current = unique(booths, newKey);
  const matches = new Map(), now = new Map(), then = new Map();
  let currentTotal = 0, previousTotal = 0, reportedTotal = 0, reported = 0;
  for (const booth of booths) {
    const votes = sum(booth.votes);
    if (!votes) continue;
    reported++;
    reportedTotal += votes;
    const key = newKey(booth);
    const prior = previous.get(key);
    if (!prior || !current.get(key)) continue;
    const oldVotes = sum(Object.values(prior[2]));
    if (!oldVotes) continue;
    matches.set(booth, oldVotes);
    currentTotal += votes;
    previousTotal += oldVotes;
    candidates.forEach((candidate, i) => {
      const party = partyKey(candidate.party);
      now.set(party, (now.get(party) ?? 0) + booth.votes[i]);
    });
    for (const [label, vote] of Object.entries(prior[2])) {
      const party = partyKey(label);
      then.set(party, (then.get(party) ?? 0) + vote);
    }
  }
  const parties = [...now.keys()].filter(key => key !== 'independent' && then.has(key)).map(key => {
    const before = share(then.get(key), previousTotal);
    const after = share(now.get(key), currentTotal);
    return { label: partyName(candidates.find(c => partyKey(c.party) === key).party), before, after, pp: after - before };
  }).sort((a, b) => b.after - a.after);
  return { parties, matches, reported, coverage: share(currentTotal, reportedTotal) };
}

export function electorateSwing(candidates, booths, fp = [], extras = {}) {
  const moved = new Set((extras.moved ?? []).map(venueKey));
  const eligible = (extras.fp ?? fp).filter(([kind,name]) => kind !== 'ordinary' || !moved.has(venueKey(name)));
  return { ...matchedSwing(candidates, booths, eligible), year: extras.year ?? 2022 };
}
