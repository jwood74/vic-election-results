import { boothKey, majorParties, partyName, race, sum, tcpSide, venueKey } from './model.js';

const clamp = value => Math.max(0, Math.min(1, value));
const tally = (votes, length) => votes?.length === length && votes.every(v => Number.isSafeInteger(v) && v >= 0);
const add = (a, b) => a.map((v,i) => v + b[i]);
const subtract = (a, b) => a.map((v,i) => v - b[i]);
const aligned = (pair, candidates = [], key = c => venueKey(c.name)) => {
  const keys = candidates.map(key);
  const matches = pair.map(c => keys.indexOf(key(c)));
  return new Set(matches).size === 2 && matches.every(i => i >= 0 && keys.indexOf(keys[i],i+1) === -1) ? matches : null;
};
const prepoll = new Set(['early','early-total','other-early']);
const declaration = new Set(['postal','absent','provisional','marked','declaration']);
const category = kind => prepoll.has(kind) ? 'early' : declaration.has(kind) ? 'declaration' : kind;

// Use comparable buckets even when one page reports only a pooled prepoll or declaration count.
function buckets(data, length, order) {
  const rows = [...(data.booths ?? []), ...(data.pooled ?? [])];
  const totals = new Map();
  const earlyTotal = tally(data.earlyPool,length) ? data.earlyPool : rows.find(b => b.kind === 'early-total')?.votes;
  const hasDeclarationTotal = rows.some(b => b.kind === 'declaration' && tally(b.votes,length) && sum(b.votes));
  for (const b of rows) {
    if (prepoll.has(b.kind) && sum(earlyTotal ?? [])) continue;
    if (hasDeclarationTotal && declaration.has(b.kind) && b.kind !== 'declaration') continue;
    const key = b.kind === 'ordinary' ? boothKey(b) : category(b.kind);
    const votes = tally(b.votes,length) ? order.map(i => b.votes[i]) : Array(order.length).fill(0);
    const prior = totals.get(key);
    if (b.kind === 'ordinary' && totals.has(key)) return null; // Ambiguous venues can't be reconciled safely.
    totals.set(key, { kind:category(b.kind), votes:prior ? add(prior.votes,votes) : votes });
  }
  if (sum(earlyTotal ?? [])) totals.set('early', {kind:'early', votes:order.map(i => earlyTotal[i])});
  return totals;
}

function transfer(fp, tcp, sides) {
  const total = sum(fp);
  const minor = total - fp[sides[0]] - fp[sides[1]];
  const toFirst = tcp[0] - fp[sides[0]];
  return total === sum(tcp) && minor > 0 && toFirst >= 0 && toFirst <= minor ? [toFirst, minor] : null;
}

function priorFlow(fp, tcp, pair) {
  if (!fp || pair.some(c => partyName(c.party) === 'Independent')) return null;
  const primary = pair.map(c => sum(Object.entries(fp).filter(([p]) => partyName(p) === partyName(c.party)).map(([,v]) => v)));
  const minor = sum(Object.values(fp)) - sum(primary);
  if (minor <= 0 || !primary.every((v,i) => v > 0 && tcp[i] >= v)) return null;
  // Historical FP and indicative TCP were not always taken from the same recheck.
  const flows = subtract(tcp, primary);
  return sum(flows) ? flows[0] / sum(flows) : null;
}

export function tcpLock(row) {
  if (row?.stale || row?.elected || row?.twoStatus !== 'reported' || row.two?.length !== 2) return null;
  const votes = row.two.map(c => c.votes);
  const formal = sum(row.fp.map(c => c.votes));
  if (!tally(votes,2) || !Number.isSafeInteger(row.enrolled) || row.enrolled < Math.max(sum(votes),formal)) return null;
  const remaining = row.enrolled - sum(votes);
  const margin = votes[0] - votes[1];
  return Math.abs(margin) > remaining ? { winner:row.two[margin > 0 ? 0 : 1], remaining } : null;
}

// Integrate the positive half of Student's t CDF. The angle substitution keeps
// the integrand bounded, including for a very large projected lead.
function studentUpperProbability(t, df) {
  const integral = end => {
    const step = end/64;
    let area = 0;
    for (let i = 0; i <= 64; i++) {
      const weight = i === 0 || i === 64 ? 1 : i % 2 ? 4 : 2;
      area += weight * Math.cos(i*step)**(df-1);
    }
    return area*step/3;
  };
  return 0.5 + 0.5 * integral(Math.atan(t/Math.sqrt(df)))/integral(Math.PI/2);
}

function estimateWinProbability({ swings, completed, first, tcpCount, projectedTotal, remaining, fpEstimated, extraTurnout, officialPair, leader }) {
  if (!officialPair || !leader || tcpCount/projectedTotal < 0.10) return null;
  // Booths are clusters: one large batch is not thousands of independent observations.
  const observations = completed
    ? completed.map(votes => ({weight:sum(votes),value:votes[0]/sum(votes)}))
    : swings.map(({current,old}) => ({weight:sum(current),value:current[0]/sum(current)-old[0]/sum(old)}));
  if (observations.length < 4) return null;
  const weight = sum(observations.map(o => o.weight));
  const effectiveBooths = weight**2/sum(observations.map(o => o.weight**2));
  if (effectiveBooths < 3) return null;
  const mean = sum(observations.map(o => o.value*o.weight))/weight;
  const variance = sum(observations.map(o => o.weight*(o.value-mean)**2))/weight * effectiveBooths/(effectiveBooths-1);
  // These explicit model-error allowances cover count composition and correlated
  // errors that booth-to-booth variance alone misses. They aren't fitted parameters.
  const scale = Math.hypot(
    Math.sqrt(variance/effectiveBooths)*remaining/projectedTotal,
    (completed ? 0.10 : 0.06)*remaining/projectedTotal,
    0.08*fpEstimated/projectedTotal,
    0.15*extraTurnout/projectedTotal,
    0.005,
  );
  return Math.min(0.999,studentUpperProbability(Math.abs(first-0.5)/scale,effectiveBooths-1));
}

export function projectDistrict(row, detail, { tcp:history, final, fp:historicalFp, moved = [] } = {}) {
  if (!row || row.stale || row.elected || ['withheld','replaced'].includes(row.twoStatus) || detail?.status !== 'ok') return null;
  const fp = row.fp.map(c => c.votes);
  const formal = sum(fp);
  if (!formal || !tally(fp,row.fp.length)) return null;
  const tcp = detail.tcp?.status === 'ok' && !detail.tcp.stale ? detail.tcp : null;
  const officialPair = row.two?.length === 2 ? row.two : tcp?.pair;
  const historicalOrder = !officialPair && history?.pair?.length === 2 && aligned(history.pair,row.fp,tcpSide);
  const pair = officialPair ?? (historicalOrder && historicalOrder.map(i => row.fp[i]));
  if (pair?.length !== 2) return null;
  const sides = aligned(pair,row.fp);
  const oldOrder = history?.pair?.length === 2 && tally(history.districtTotal,2) && sum(history.districtTotal) && aligned(pair,history.pair,tcpSide);
  const currentOnly = !oldOrder;
  if (currentOnly && (!officialPair || !tcp || !historicalFp || !sum(Object.values(historicalFp)))) return null;
  const fpOrder = detail.candidates?.map(c => row.fp.findIndex(f => venueKey(f.name) === venueKey(c.name)));
  const tcpOrder = tcp && aligned(pair,tcp.pair);
  if (!sides || fpOrder?.length !== fp.length || fpOrder.includes(-1) || new Set(fpOrder).size !== fp.length || (tcp && !tcpOrder)) return null;

  const fpBuckets = buckets(detail,fp.length,row.fp.map((_, i) => fpOrder.indexOf(i)));
  const tcpBuckets = tcp ? buckets(tcp,2,tcpOrder) : new Map();
  const oldBuckets = currentOnly ? new Map() : buckets(history,2,oldOrder);
  if (!fpBuckets || !tcpBuckets || !oldBuckets) return null;
  const actual = [...tcpBuckets.values()].reduce((v,b) => add(v,b.votes),[0,0]);
  // The district and centre pages can update at different times. Don't allocate the same votes twice.
  if (row.twoStatus === 'reported' && actual.some((v,i) => v !== row.two[i].votes)) return null;
  if (tcp?.districtTotal && actual.some((v,i) => v !== tcp.districtTotal[tcpOrder[i]])) return null;
  const unallocatedFp = [...fpBuckets.values()].reduce((v,b) => subtract(v,b.votes),fp);
  if (unallocatedFp.some(v => v < 0) || sum(actual) > formal) return null;
  if (sum(unallocatedFp)) fpBuckets.set('residual', {kind:'residual',votes:unallocatedFp});

  const oldVotes = currentOnly ? [] : oldOrder.map(i => history.districtTotal[i]);
  const finalOrder = !currentOnly && final && aligned(pair,final.pair,tcpSide);
  const finalVotes = finalOrder && finalOrder.map(i => final.districtTotal[i]);
  const fallbackFlow = currentOnly ? null : priorFlow(historicalFp,finalVotes ?? oldVotes,pair);
  const flows = new Map();
  let overallFlow = [0,0];
  const completed = [];
  for (const [key,b] of fpBuckets) {
    const observed = tcpBuckets.get(key)?.votes;
    if (currentOnly && b.kind === 'ordinary' && observed && sum(observed) > 0 && sum(observed) === sum(b.votes) &&
        observed.every((votes,i) => votes >= b.votes[sides[i]])) completed.push(observed);
    const rate = observed && transfer(b.votes,observed,sides);
    if (!rate) continue;
    flows.set(b.kind,add(flows.get(b.kind) ?? [0,0],rate));
    overallFlow = add(overallFlow,rate);
  }
  if (currentOnly && completed.length < 2) return null;
  const rateFor = kind => {
    const rate = flows.get(kind) ?? overallFlow;
    return rate[1] ? rate[0]/rate[1] : fallbackFlow;
  };
  const fromFp = (votes,kind) => {
    const minor = sum(votes) - votes[sides[0]] - votes[sides[1]];
    const rate = rateFor(kind);
    return minor && rate === null ? null : votes[sides[0]] + minor * rate;
  };

  const movedKeys = new Set(moved.map(venueKey));
  const comparable = key => !key.startsWith('ordinary:') || !movedKeys.has(key.slice('ordinary:'.length));
  const swings = [];
  const indicativeSwings = [];
  let oldCovered = [0,0], fpEstimate = 0, fpEstimated = 0, emptyBoothVotes = 0;
  for (const [key,b] of fpBuckets) {
    const count = sum(b.votes);
    const observed = tcpBuckets.get(key)?.votes ?? [0,0];
    const counted = sum(observed);
    const old = comparable(key) ? oldBuckets.get(key)?.votes : null;
    const oldCount = sum(old ?? []);
    const fpOnly = Math.max(0,count-counted);
    const converted = fpOnly ? fromFp(b.votes,b.kind) : null;
    if (fpOnly && converted === null) return null;
    if (fpOnly) {
      // Partial TCP buckets have no separate FP split for the unprocessed ballots.
      fpEstimate += fpOnly * (counted ? clamp((converted - observed[0])/fpOnly) : converted/count);
      fpEstimated += fpOnly;
    }
    if (!oldCount) continue;
    if (b.kind === 'ordinary') {
      if (counted) swings.push({current:observed, old});
      else if (count && converted !== null) indicativeSwings.push({current:[converted,count-converted],old});
      if (!count && !counted) emptyBoothVotes += oldCount;
    }
  }
  for (const [key,b] of oldBuckets) {
    const counted = Math.max(sum(fpBuckets.get(key)?.votes ?? []),sum(tcpBuckets.get(key)?.votes ?? []));
    if (!counted || !comparable(key)) continue;
    const fraction = b.kind === 'ordinary' ? 1 : clamp(counted/sum(b.votes));
    if (sum(b.votes)) oldCovered = add(oldCovered,b.votes.map(v => fraction*v));
  }
  if (fpEstimated > formal - sum(actual)) return null;
  const matched = swings.length ? swings : indicativeSwings;
  if (!currentOnly && !matched.length) return null;
  let swing = null, outstandingShare;
  if (currentOnly) {
    const completedVotes = completed.reduce(add,[0,0]);
    outstandingShare = completedVotes[0]/sum(completedVotes);
  } else {
    const matchedTotals = matched.reduce(([current,old],m) => [add(current,m.current),add(old,m.old)],[[0,0],[0,0]]);
    swing = matchedTotals[0][0]/sum(matchedTotals[0]) - matchedTotals[1][0]/sum(matchedTotals[1]);
    const oldRemaining = subtract(oldVotes,oldCovered).map(v => Math.max(0,v));
    outstandingShare = clamp((sum(oldRemaining) ? oldRemaining[0]/sum(oldRemaining) : oldVotes[0]/sum(oldVotes)) + swing);
  }
  const officialCap = Number.isSafeInteger(row.enrolled) && row.enrolled >= formal ? row.enrolled - formal : Infinity;
  const historicalFormal = historicalFp ? sum(Object.values(historicalFp)) : sum(oldVotes);
  const remaining = Math.min(officialCap,Math.max(0,historicalFormal - formal,emptyBoothVotes));
  const projectedTotal = formal + remaining;
  const first = (actual[0] + fpEstimate + remaining * outstandingShare)/projectedTotal;
  const leader = Math.abs(first-0.5) < 1e-10 ? null : pair[first > 0.5 ? 0 : 1];

  // Stress-test assumptions by count stage. These labels are scenarios, not win probabilities.
  const extraTurnout = Math.min(Math.max(0,officialCap-remaining),Math.round(historicalFormal * 0.05));
  const stress = (shift, extra) => {
    const leading = first > 0.5;
    const exposed = remaining + fpEstimated;
    const leaderVotes = Math.max(first,1-first) * projectedTotal;
    const adverseShare = leading ? 1-outstandingShare : outstandingShare;
    return leaderVotes - exposed * shift + extra * clamp(1-adverseShare-shift) > (projectedTotal + extra)/2;
  };
  const tcpCount = sum(actual);
  const observedBooths = currentOnly ? completed.length : swings.length;
  const supportingBooths = currentOnly ? completed.length : matched.length;
  const likely = leader && officialPair && observedBooths >= 4 && formal/projectedTotal >= 0.35 && tcpCount/projectedTotal >= 0.15 && stress(0.20,extraTurnout);
  const leaning = leader && supportingBooths >= 2 && formal/projectedTotal >= 0.10 && stress(0.075,0);
  const winProbability = estimateWinProbability({swings,completed:currentOnly ? completed : null,first,tcpCount,projectedTotal,remaining,fpEstimated,extraTurnout,officialPair,leader});
  const projectedShare = leader ? 100 * Math.max(first,1-first) : 50;
  const projectedSwing = leader && finalVotes ? projectedShare - 100 * finalVotes[pair.indexOf(leader)]/sum(finalVotes) : null;
  return { leader, share:projectedShare, projectedSwing, remaining, fpEstimated, tcpCount,
    matched:matched.length, matchedTcp:swings.length, swing:swing === null ? null : 100*swing, swingParty:pair[0].party, assumedPair:!officialPair,
    ...(currentOnly ? {currentOnly:true, completedBooths:completed.length} : {}),
    confidence:likely ? 'Likely' : leaning ? 'Leaning' : 'Uncertain', winProbability };
}

export function projectedParty(row, projection, prior) {
  if (row?.elected) return {candidate:row.elected, label:'Declared'};
  const lock = tcpLock(row);
  if (lock) {
    const label = !prior ? 'TCP Locked' : partyName(prior.party) === partyName(lock.winner.party) ? 'Hold' : 'Gain';
    return {candidate:lock.winner, label, locked:true, remaining:lock.remaining};
  }
  if (projection?.leader && projection.confidence !== 'Uncertain') return {candidate:projection.leader,label:projection.confidence};
  return row?.fp.some(c => c.votes > 0) ? {label:'Uncertain'} : null;
}

export const seatStages = ['leading', 'leaning', 'likely', 'locked', 'declared'];

export function seatOutlook(rows, { allowProjections = true } = {}) {
  const parties = new Map([...majorParties,'Other'].map(party => [party, {party, total:0, ...Object.fromEntries(seatStages.map(stage => [stage,[]]))}]));
  for (const row of rows) {
    if (!row.elected && (row.stale || !allowProjections)) continue;
    const call = projectedParty(row,row.projection);
    const candidate = call?.candidate ?? race(row).leader;
    if (!candidate) continue;
    const stage = call?.candidate ? (call.locked ? 'locked' : call.label.toLowerCase()) : 'leading';
    const party = partyName(candidate.party);
    const group = parties.get(party) ?? parties.get('Other');
    group[stage].push({id:row.id,party});
    group.total++;
  }
  return [...parties.values()].filter(group => group.party !== 'Other' || group.total);
}
