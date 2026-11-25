import { boothKey, partyName } from './model.js';

const ids = ['bass', 'gippsland-east', 'hawthorn', 'melbourne', 'northcote', 'richmond'];
export const demoIndex = 'https://www.vec.vic.gov.au/results/state-election-results/2022-state-election-results';

export function buildDemo(fpHistory, tcpHistory, pooledHistory = {}) {
  const results = [];
  const details = new Map();
  const districtBaseline = {};
  const districtTcpBaseline = {};
  const shift = (votes, booth, candidate, district) => Math.max(0, Math.round(votes * (0.94 + ((booth * 7 + candidate * 11 + district * 3) % 17) / 50)));
  for (const [i,id] of ids.entries()) {
    const fp = fpHistory.districts[id];
    const priorTcp = tcpHistory.districts[id];
    if (!fp?.length || !priorTcp?.booths?.length) throw new Error(`Missing demo baseline for ${id}`);
    const pools = Object.entries(pooledHistory[id] ?? {});
    const labels = [...new Set([...fp.map(([, , votes]) => votes), ...pools.map(([,votes]) => votes)].flatMap(votes => Object.keys(votes).map(partyName)))];
    const candidates = labels.map((party,j) => ({name: `Demo candidate ${j + 1}`, party}));
    const priorTcpRows = new Map(priorTcp.booths.map(b => [boothKey(b), b]));
    // Leave some venues unreported, so reviewers can see matched coverage as well as swing.
    const selection = fp.filter(([kind], j) => kind === 'ordinary' && j % 4 !== 0);
    const historical = new Map();
    const simulate = (kind,name,votes,j) => {
      const byParty = new Map();
      for (const [party,n] of Object.entries(votes)) {
        const label = partyName(party);
        byParty.set(label,(byParty.get(label) ?? 0)+n);
        historical.set(label,(historical.get(label) ?? 0)+n);
      }
      return {kind,name,votes:candidates.map((c,k) => shift(byParty.get(c.party) ?? 0,j,k,i))};
    };
    const booths = selection.map(([kind,name,votes],j) => simulate(kind,name,votes,j));
    const poolNames = { 'early-total':'Prepoll total', absent:'Absent votes', postal:'Postal votes', provisional:'Provisional votes', marked:'Marked as voted' };
    const pooled = pools.map(([kind,votes],j) => simulate(kind,poolNames[kind],votes,j + booths.length));
    districtBaseline[id] = Object.fromEntries(historical);
    // Keep the archived TCP sides so that the demo illustrates a valid historical comparison.
    const pair = priorTcp.pair;
    const tcpBooths = booths.flatMap((b,j) => {
      const prior = priorTcpRows.get(boothKey(b));
      return prior && j % 5 !== 0 ? [{kind:b.kind,name:b.name,votes:prior.votes.map((n,k) => shift(n,j,k + 1,i))}] : [];
    });
    const tcpPooled = (priorTcp.pooled ?? []).map((b,j) => ({...b,votes:b.votes.map((n,k) => shift(n,j + booths.length,k + 1,i))}));
    const totals = (people,rows) => people.map((person,j) => ({ ...person, votes:rows.reduce((n,b) => n + b.votes[j],0) }));
    districtTcpBaseline[id] = {pair,districtTotal:totals(pair,[...tcpBooths.map(b => priorTcpRows.get(boothKey(b))), ...(priorTcp.pooled ?? [])]).map(c => c.votes)};
    const two = totals(pair,[...tcpBooths,...tcpPooled]);
    results.push({id,fp:totals(candidates,[...booths,...pooled]),two,twoStatus:two.some(c => c.votes > 0) ? 'reported' : 'unavailable',elected:null});
    details.set(id,{status:'ok',candidates,booths,pooled,tcp:{status:'ok',pair,booths:tcpBooths,pooled:tcpPooled}});
  }
  return {snapshot:{status:'demo',loaded:results.length,results},details,districtBaseline,districtTcpBaseline};
}
