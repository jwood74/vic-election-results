import { boothKey, partyName, sum } from './model.js';
import { projectDistrict } from './projection.js';

const ids = ['bass', 'gippsland-east', 'hawthorn', 'melbourne', 'northcote', 'richmond'];
export const demoIndex = 'https://www.vec.vic.gov.au/results/state-election-results/2022-state-election-results';

export function buildDemo(fpHistory, tcpHistory, pooledHistory = {}, formalHistory = {}) {
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
    const pair = priorTcp.pair.map(c => candidates.find(p => p.party === partyName(c.party)));
    const indices = pair.map(c => candidates.indexOf(c));
    const simulateTcp = (b,prior) => {
      const total = sum(b.votes);
      const [a,z] = indices.map(k => b.votes[k]);
      const first = Math.max(a,Math.min(total-z,Math.round(total * (prior.votes[0]/sum(prior.votes) + (i % 3 - 1)*0.035))));
      return {kind:b.kind,name:b.name,votes:[first,total-first]};
    };
    const tcpBooths = booths.flatMap((b,j) => {
      const prior = priorTcpRows.get(boothKey(b));
      return prior && sum(prior.votes) && j % 5 !== 0 ? [simulateTcp(b,prior)] : [];
    });
    const tcpPooled = pooled.flatMap(b => {
      const prior = priorTcp.pooled?.find(p => p.kind === b.kind && sum(p.votes));
      return prior ? [simulateTcp(b,prior)] : [];
    });
    const totals = (people,rows) => people.map((person,j) => ({ ...person, votes:rows.reduce((n,b) => n + b.votes[j],0) }));
    districtTcpBaseline[id] = {pair,districtTotal:totals(pair,[...tcpBooths.map(b => priorTcpRows.get(boothKey(b))), ...priorTcp.pooled.filter(b => tcpPooled.some(p => p.kind === b.kind))]).map(c => c.votes)};
    const two = totals(pair,[...tcpBooths,...tcpPooled]);
    const row = {id,fp:totals(candidates,[...booths,...pooled]),two,twoStatus:two.some(c => c.votes > 0) ? 'reported' : 'unavailable',elected:null};
    const detail = {status:'ok',candidates,booths,pooled,tcp:{status:'ok',pair,booths:tcpBooths,pooled:tcpPooled}};
    const missing = fp.filter(([kind],j) => kind === 'ordinary' && j % 4 === 0).map(([kind,name]) => ({kind,name,votes:candidates.map(() => null)}));
    row.projection = projectDistrict(row,{...detail,booths:[...booths,...missing]}, {tcp:{...priorTcp,pair},fp:formalHistory[id]});
    results.push(row);
    details.set(id,detail);
  }
  return {snapshot:{status:'demo',loaded:results.length,results},details,districtBaseline,districtTcpBaseline};
}
