import { boothKey, partyName } from './model.js';

const ids = ['bass', 'gippsland-east', 'hawthorn', 'melbourne', 'northcote', 'richmond'];
export const demoIndex = 'https://www.vec.vic.gov.au/results/state-election-results/2022-state-election-results';

export function buildDemo(fpHistory, tcpHistory) {
  const results = [];
  const details = new Map();
  const shift = (votes, booth, candidate, district) => Math.max(0, Math.round(votes * (0.94 + ((booth * 7 + candidate * 11 + district * 3) % 17) / 50)));
  for (const [i,id] of ids.entries()) {
    const fp = fpHistory.districts[id];
    const priorTcp = tcpHistory.districts[id];
    if (!fp?.length || !priorTcp?.booths?.length) throw new Error(`Missing demo baseline for ${id}`);
    const labels = [...new Set(fp.flatMap(([, , votes]) => Object.keys(votes).map(partyName)))];
    const candidates = labels.map((party,j) => ({name: `Demo candidate ${j + 1}`, party}));
    const priorTcpRows = new Map(priorTcp.booths.map(b => [boothKey(b), b]));
    // Leave some venues unreported, so reviewers can see matched coverage as well as swing.
    const selection = fp.filter(([kind], j) => kind === 'ordinary' && j % 4 !== 0);
    const booths = selection.map(([kind,name,votes],j) => {
      const byParty = new Map();
      for (const [party,n] of Object.entries(votes)) byParty.set(partyName(party),(byParty.get(partyName(party)) ?? 0)+n);
      return {kind,name,votes:candidates.map((c,k) => shift(byParty.get(c.party) ?? 0,j,k,i))};
    });
    // Keep the archived TCP sides so that the demo illustrates a valid historical comparison.
    const pair = priorTcp.pair;
    const tcpBooths = booths.flatMap((b,j) => {
      const prior = priorTcpRows.get(boothKey(b));
      return prior && j % 5 !== 0 ? [{kind:b.kind,name:b.name,votes:prior.votes.map((n,k) => shift(n,j,k + 1,i))}] : [];
    });
    const totals = (people,rows) => people.map((person,j) => ({ ...person, votes:rows.reduce((n,b) => n + b.votes[j],0) }));
    const two = totals(pair,tcpBooths);
    results.push({id,fp:totals(candidates,booths),two,twoStatus:tcpBooths.length ? 'reported' : 'unavailable',elected:null});
    details.set(id,{status:'ok',candidates,booths,tcp:{status:'ok',pair,booths:tcpBooths}});
  }
  return {snapshot:{status:'demo',loaded:results.length,results},details};
}
