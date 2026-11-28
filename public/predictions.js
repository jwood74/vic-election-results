import { partyName } from './model.js';
import { projectedParty } from './projection.js';

export const pollsClose = Date.parse('2026-11-28T18:00:00+11:00');
export const predictionModes = { original:'Pre-count picks', live:'Live picks' };

export function candidateLabel({ name }) {
  const [surname, given] = name.split(/,\s*/, 2);
  return given ? `${given} ${surname}` : name;
}

// The nominations and results pages can use different case and name order.
export const candidateKey = candidate => candidateLabel(candidate).normalize('NFKC').toLowerCase()
  .replace(/[’‘]/g, "'").trim().replace(/\s+/g, ' ');

export function countStarted(snapshot, now = Date.now()) {
  return now >= pollsClose || (snapshot?.status !== 'archive' && (snapshot?.results ?? [])
    .some(row => row.elected || row.fp?.some(candidate => candidate.votes > 0)));
}

export function predictionResult(pick, row, snapshotStatus) {
  const usable = snapshotStatus !== 'archive';
  // A previously published declaration remains a declaration in a stale snapshot.
  const call = usable && row?.elected ? { candidate:row.elected, label:'Declared' }
    : usable && snapshotStatus !== 'stale' && !row?.stale && row ? projectedParty(row, row.projection) : null;
  if (!pick) return { call, status:'unpicked' };
  if (!call?.candidate) return { call, status:'pending' };
  const matches = candidateKey(pick) === candidateKey(call.candidate);
  return { call, status: call.label === 'Declared' ? (matches ? 'correct' : 'missed') : (matches ? 'ahead' : 'behind') };
}

export function predictionSummary(rows) {
  const counts = { unpicked:0, pending:0, ahead:0, behind:0, correct:0, missed:0 };
  const parties = new Map();
  for (const { pick, status } of rows) {
    counts[status]++;
    if (!pick) continue;
    const label = partyName(pick.party);
    const party = /^independent(s)?$/i.test(label) || !label ? 'Independents' : label;
    parties.set(party, (parties.get(party) ?? 0) + 1);
  }
  return { ...counts, picked:rows.length - counts.unpicked, declared:counts.correct + counts.missed,
    parties:[...parties].sort(([a,x],[b,y]) => y-x || a.localeCompare(b)) };
}

export function readPredictions(raw) {
  let data;
  try { data = JSON.parse(raw); } catch {}
  const picks = mode => Object.fromEntries(Object.entries(data?.[mode] ?? {}).filter(([id, value]) =>
    /^[a-z0-9-]+$/.test(id) && typeof value?.name === 'string' && value.name && typeof value.party === 'string'));
  return { original:picks('original'), live:picks('live'), lockedAt:Number.isFinite(data?.lockedAt) ? data.lockedAt : null };
}
