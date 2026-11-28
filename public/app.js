import { boothComparisons, boothKey, boothMatchedTcpSwing, districtTcpSwing, electorateSwing, finalTcp, historicalBoothTcp, majorParties, matchedSwing, matchedTcp, partyAbbreviation, partyCode, partyName, partySwing, partyVotes, race, retainSnapshotRows, share, statewide, sum } from './model.js';
import { projectedParty, seatOutlook, seatStages } from './projection.js';
import { candidateKey, candidateLabel, countStarted, predictionModes, predictionResult, predictionSummary, readPredictions } from './predictions.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const num = n => n == null ? '—' : n.toLocaleString('en-AU');
const pct = (n, unit = true) => n == null ? '—' : `${n.toFixed(2)}${unit ? '%' : ''}`;
const delta = n => {
  if (n == null) return '—';
  const rounded = Number(n.toFixed(2));
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}`;
};
const time = n => n ? new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', dateStyle:'medium', timeStyle:'short' }).format(new Date(n)) : null;
const cell = (value, classes = '', party) => `<td class="num ${classes}"${party ? ` aria-label="${esc(`${partyName(party)} ${value}`)}" title="${esc(partyName(party))}"` : ''}>${/^[+−-]?0(?:\.0+)?%?$/.test(value) ? `<span class="zero-value">${value}</span>` : value}</td>`;
const table = (labels, body, name, cls = '', textColumns = 1) => `<div class="scroll" tabindex="0" role="region" aria-label="${esc(name)}"><table class="${cls}" aria-label="${esc(name)}"><thead><tr>${labels.map((h,i) => `<th scope="col"${i >= textColumns ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
const empty = text => `<p class="empty muted">${text}</p>`;
const districtHref = id => `/?district=${encodeURIComponent(id)}${demo ? '&demo=1' : ''}`;
const json = async url => {
  const res = await fetch(`/${url}`, { signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};
const params = new URLSearchParams(location.search);
const statusPage = /^\/status\/?$/.test(location.pathname);
const demo = !statusPage && params.get('demo') === '1';
const id = statusPage ? null : params.get('district');
const expanded = id !== null && params.get('view') === 'booths';
const myPredictions = !statusPage && id === null && params.get('view') === 'predictions';
const boothFilters = new Map([['all','All booths and vote types'],['ordinary','Election day booths'],['declaration','Declaration votes'],['reported','With results']]);
let roster = {}, snapshot, boothData, history, tcpHistory, comparisonHistory, districtBaseline, demoTcpBaseline, pooledHistory, busy = false, invalid = false, dialogRefreshPending = false;
let sportsbetOdds, historicalResults;
const views = { search: '', watched: false, sort: 'name', districtUnits: 'share', boothSearch: params.get('q') ?? '', boothSort: params.get('sort') === 'votes' ? 'votes' : 'name', boothUnits: ['votes','swing'].includes(params.get('units')) ? params.get('units') : 'share', districtParty: '', boothParty: params.get('party') ?? '' };
views.boothFilter = boothFilters.has(params.get('filter')) ? params.get('filter') : 'all';
views.showAllParties = false;
const districtViewKey = `vic-votes-2026-${demo ? 'demo-' : ''}district-view`;
try {
  const saved = JSON.parse(localStorage.getItem(districtViewKey));
  views.watched = saved?.watched === true;
  if (['name','close','votes','updated'].includes(saved?.sort)) views.sort = saved.sort;
  if (['share','votes','swing'].includes(saved?.districtUnits)) views.districtUnits = saved.districtUnits;
  if ([...majorParties,'Other'].includes(saved?.districtParty)) views.districtParty = saved.districtParty;
} catch {}
function saveDistrictView() {
  const {watched,sort,districtUnits,districtParty} = views;
  try { localStorage.setItem(districtViewKey,JSON.stringify({watched,sort,districtUnits,districtParty})); } catch {}
}
function boothHref(district, full = expanded, keepParty = true) {
  const query = new URLSearchParams({ district });
  if (demo) query.set('demo','1');
  if (full) query.set('view','booths');
  if (views.boothSearch) query.set('q',views.boothSearch);
  if (views.boothFilter !== 'all') query.set('filter',views.boothFilter);
  if (views.boothSort !== 'name') query.set('sort',views.boothSort);
  if (views.boothUnits !== 'share') query.set('units',views.boothUnits);
  if (keepParty && views.boothParty) query.set('party',views.boothParty);
  return `?${query}${full ? '' : '#booths'}`;
}
function syncBoothLink() {
  const link = $('booth-size');
  if (link) link.href = boothHref(id, !expanded);
  if (expanded) window.history.replaceState(null, '', boothHref(id));
}
const watchKey = demo ? 'vic-votes-2026-demo-watchlist' : 'vic-votes-2026-watchlist';
let watched = new Set();
try { watched = new Set(JSON.parse(localStorage.getItem(watchKey) ?? '[]')); } catch {}
function toggle(id) {
  if (watched.has(id)) watched.delete(id); else watched.add(id);
  try { localStorage.setItem(watchKey, JSON.stringify([...watched])); } catch {}
}
function star(id) {
  const added = watched.has(id);
  return `<button type="button" class="star" data-star="${esc(id)}" aria-label="${added ? 'Remove' : 'Add'} ${esc(roster[id])} ${added ? 'from' : 'to'} watchlist" aria-pressed="${added}">${added ? '★' : '☆'}</button>`;
}
const titleCase = s => partyName(s);
const partyShort = party => `<abbr title="${esc(partyName(party))}">${esc(partyAbbreviation(party))}</abbr>`;
const outcome = row => row?.elected ? '<span class="badge declared">Declared</span>' : !row?.fp.some(c => c.votes > 0) ? '<span class="meta">Awaiting count</span>' : row.twoStatus === 'withheld' ? '<span class="badge">TCP not published</span>' : race(row).tied ? '<span class="badge">TCP tied</span>' : race(row).leader ? '<span class="badge">TCP lead</span>' : '<span class="badge">Awaiting TCP</span>';
const signed = n => n > 0 ? 'positive' : n < 0 ? 'negative' : '';
const tint = label => `party-${partyCode(label)}`;
const bandCell = (label, value, extra = '') => cell(value, `${tint(label)} ${extra}`);
const priorVotes = key => Object.entries(districtBaseline?.[key] ?? {}).map(([party,votes]) => ({party,votes}));
const priorTcp = key => demo ? demoTcpBaseline?.[key] : finalTcp(historicalResults?.[key]);
const priorBoothTcp = key => historicalBoothTcp(historicalResults?.[key], comparisonHistory?.districts?.[key]?.tcp ?? tcpHistory?.districts?.[key]);
const canCompare = row => snapshot?.status !== 'archive' && Object.hasOwn(districtBaseline ?? {}, row.id) && row.fp.some(c => c.votes > 0);
function matrix(name, fixed, group, columns, rows, sortKey, active, summary = '') {
  const groups = typeof group === 'string' ? [{label:group,count:columns.length}] : group;
  return `<div class="scroll matrix-scroll" tabindex="0" role="region" aria-label="${esc(name)}"><table class="matrix" aria-label="${esc(name)}"><thead><tr>${fixed.map((head,i) => `<th scope="col" rowspan="2"${i === 0 ? ' class="pinned"' : ''}>${head}</th>`).join('')}${groups.map(({label,count,tcp}) => `<th class="band-title${tcp ? ' tcp-band' : ''}" scope="colgroup" colspan="${count}">${esc(label)}</th>`).join('')}</tr><tr>${columns.map(({label,key,swing,tcp,display,candidate,edge}) => {
    const name = candidate ? `${label} (${candidate})` : label;
    const metric = tcp ? (swing ? ' TCP swing' : ' TCP') : (swing ? ' swing' : ' first preferences');
    const text = `${esc(display ?? partyAbbreviation(label))}${swing && !display ? ' Δ' : ''}${key && active === key ? ' ↓' : ''}`;
    return `<th scope="col" class="num ${label ? tint(label) : ''} ${swing ? 'swing-col' : ''} ${edge ?? ''}"${key && active === key ? ' aria-sort="descending"' : ''}>${key ? `<button type="button" data-${sortKey}="${esc(key)}" title="${esc(name + metric)}" aria-label="Sort by ${esc(name + metric)}">${text}</button>` : text}</th>`;
  }).join('')}</tr>${summary}</thead><tbody>${rows}</tbody></table></div>`;
}

const stageLabel = stage => stage[0].toUpperCase() + stage.slice(1);

function seatBlocs(parties) {
  const coalition = ['Liberal','Nationals'].map(party => parties.find(p => p.party === party)).filter(p => p?.total);
  const blocs = parties.filter(p => p.total && !coalition.includes(p)).map(p => ({label:p.party,total:p.total,parties:[p]}));
  if (coalition.length) blocs.push({label:'Coalition',total:sum(coalition.map(p => p.total)),parties:coalition});
  return blocs.sort((a,b) => b.total-a.total);
}

function seatOverview(parties) {
  const total = sum(parties.map(p => p.total));
  const byStage = [...seatStages].reverse();
  const staleSeats = p => sum(seatStages.map(stage => p[stage].filter(seat => seat.stale).length));
  const staleCount = sum(parties.map(staleSeats));
  const staleLabel = staleCount ? ` · ${staleCount} stale` : '';
  const blocs = seatBlocs(parties);
  const coalition = blocs.find(bloc => bloc.label === 'Coalition');
  const coalitionLabel = coalition ? `Coalition (LIB + NAT): ${num(coalition.total)}` : '';
  const seats = blocs.flatMap(bloc => bloc.parties).flatMap(p =>
    byStage.flatMap(stage => p[stage].map(seat => `<span class="${tint(p.party)}" data-stage="${stage}" title="${esc(`${roster[seat.id] ?? seat.id} · ${partyAbbreviation(seat.party)} ${stageLabel(stage)}${seat.stale ? ' · Stale' : ''}`)}"></span>`)));
  const unallocated = Math.max(0,88-total);
  const description = [...(coalitionLabel ? [coalitionLabel] : []),...parties.filter(p => p.total).map(p => `${partyAbbreviation(p.party)} ${p.total}`),...(staleCount ? [`${staleCount} stale`] : []),`${unallocated} unallocated`,'45 seats for a majority'].join(', ');
  const bar = `<div class="seatline" role="img" aria-label="${esc(`Seat outlook: ${description}`)}">${seats.join('')}${'<span></span>'.repeat(unallocated)}</div>
    <div class="seatnote meta"><span>${total} of 88 seats in the outlook${staleLabel}</span>${coalitionLabel ? `<span>${coalitionLabel}</span>` : ''}<strong>45 seats for a majority</strong></div>
    <ul class="seat-legend meta" aria-label="Seat confidence legend">${[...seatStages,'unallocated'].map(stage => `<li><span data-stage="${stage}" aria-hidden="true"></span>${stageLabel(stage)}</li>`).join('')}</ul>`;
  const breakdown = `<div class="card"><h3>Seats by Party</h3>${table(['Party',...seatStages.map(stageLabel),'Total'],parties.map(p => `<tr class="${tint(p.party)}"><th scope="row">${p.party === 'Other' ? 'Other' : partyShort(p.party)}</th>${seatStages.map(stage => cell(num(p[stage].length))).join('')}${cell(`<strong>${num(p.total)}</strong>${staleSeats(p) ? ` <small class="stale">(${staleSeats(p)} stale)</small>` : ''}`)}</tr>`).join(''),'Seats by Party','statewide-party-table seat-breakdown')}<p class="swing-baseline meta">Leading shows the published TCP leader when there is no stronger call. Stale seats use the last successful district count.</p></div>`;
  return {bar,breakdown};
}

function renderHeaderOutlook(parties) {
  const outlook = $('header-outlook');
  outlook.hidden = snapshot?.status === 'archive';
  if (outlook.hidden) return;
  const blocs = seatBlocs(parties);
  outlook.innerHTML = `<span class="meta">${demo ? 'Demo' : 'Seat outlook'}${blocs.length ? '' : ' · No calls yet'}</span>${blocs.map(({label,total,parties}) => label === 'Coalition'
    ? `<span class="header-seat" title="${esc(parties.map(p => `${p.party} ${num(p.total)}`).join(' + '))}">Coalition <strong>${num(total)}</strong></span>`
    : `<span class="header-seat ${tint(label)}">${label === 'Other' ? 'Other' : partyShort(label)} <strong>${num(total)}</strong></span>`).join('')}`;
}

function statewideView(parties) {
  const results = snapshot?.results ?? [];
  const stats = statewide(results);
  const comparable = results.filter(canCompare);
  const swings = partySwing(partyVotes(comparable.flatMap(r => r.fp)), partyVotes(comparable.flatMap(r => priorVotes(r.id))));
  const seats = seatOverview(parties);
  const visibleParties = views.showAllParties ? stats.list : stats.list.slice(0,8);
  const moreParties = stats.list.length - 8;
  return `<section id="statewide"><h1 class="section-head">Statewide overview</h1>
    <div class="stats">${[['Formal votes reported',stats.reporting ? num(stats.votes) : '—'],['Districts reporting',`${stats.reporting} / 88`],['Seats declared',`${stats.declared} / 88`]].map(([label,value]) => `<div class="stat"><small>${label}</small><strong>${value}</strong></div>`).join('')}</div>
    ${seats.bar}
    <div class="grid"><div class="card"><h3>First preferences by party</h3><div id="statewide-party-results">${visibleParties.length ? table(['Party','Votes','Share','Swing'],visibleParties.map(p => `<tr${majorParties.includes(p.label) ? ` class="${tint(p.label)}"` : ''}><th scope="row">${esc(p.label)}</th>${cell(num(p.votes))}${cell(pct(share(p.votes,stats.votes)))}${cell(delta(swings.get(p.label)),signed(swings.get(p.label)))}</tr>`).join(''),'Statewide votes by party', 'statewide-party-table') : empty('Party totals will appear when districts report.')}</div>${moreParties > 0 ? `<div class="swing-baseline meta"><button type="button" class="outline" id="show-more-parties" aria-expanded="${views.showAllParties}" aria-controls="statewide-party-results">${views.showAllParties ? 'Show fewer parties' : `Show ${moreParties} more ${moreParties === 1 ? 'party' : 'parties'}`}</button></div>` : ''}${swings.size ? `<p class="swing-baseline meta">Swing in percentage points vs ${demo ? 'the 2022 demo baseline' : `2022 across ${comparable.length} comparable ${comparable.length === 1 ? 'district' : 'districts'}`}.</p>` : ''}</div>
    ${seats.breakdown}</div></section>
    <section id="districts"><h2 class="section-head">District results</h2>
    <div class="tools"><input type="search" id="search" placeholder="Search districts" aria-label="Search districts" value="${esc(views.search)}"><label><input type="checkbox" id="watched" ${views.watched ? 'checked' : ''}> Watchlist only</label><select id="sort" aria-label="Sort districts"><option value="name">District A–Z</option><option value="close">Closest TCP</option><option value="votes">Most votes counted</option><option value="updated">Most recently updated</option></select><select id="district-units" aria-label="District result display"><option value="share">Percentage</option><option value="votes">Votes</option><option value="swing">Swings</option></select></div><div class="card" id="district-list"></div>
    ${snapshot?.status === 'archive' ? '' : `<details class="prediction-notes meta"><summary>How to read the predictions</summary><p>Predicted result is the estimated final two-candidate-preferred (TCP) share. It combines published TCP, estimated preference flows for ballots with first preferences only, and historical TCP adjusted by swing at matched booths. Estimated votes left use historical turnout.</p><p>Leaning and Likely mean the projected lead survives increasingly adverse assumptions about remaining votes. Uncertain means the lead is sensitive to those assumptions or there is too little data. Gain or Hold appears only when the lead for the published TCP pair exceeds the maximum possible uncounted votes, using official enrolment. It compares with the historical TCP leader and remains subject to rechecks and the final preference distribution.</p></details>`}</section>`;
}

const predictionStale = row => Boolean(row && (snapshot?.status === 'stale' || row.stale || row.projectionStale));
const lastPredictionTime = row => time(row?.projectionAt ?? row?.projectionCheckedAt ?? row?.at);
const stalePredictionBadge = row => predictionStale(row) && row?.projection ? ` <small class="stale" title="${esc(lastPredictionTime(row) ? `Last calculated ${lastPredictionTime(row)} Melbourne time` : 'Last available prediction')}">Stale</small>` : '';
const predictionBadge = call => call ? `<span class="badge${call.label === 'Declared' ? ' declared' : ''}">${call.candidate ? `${partyShort(call.candidate.party)} ` : ''}${esc(call.label)}</span>` : '—';

const picksKey = `vic-votes-2026-${demo ? 'demo-' : ''}predictions`;
let picks = readPredictions(null), nominations = {}, picksError = '', mode, pickFilter = 'all', pickSearch = '';
const predictionsHref = `?view=predictions${demo ? '&demo=1' : ''}`;
const pickStatuses = { unpicked:'No pick', pending:'Too early', ahead:'On track', behind:'Behind', correct:'Correct', missed:'Missed' };
const pickFilters = { all:'All districts', picked:'With a pick', unpicked:'Still to pick', behind:'Behind forecast', declared:'Declared picks' };
const originalsClosed = () => picks.lockedAt !== null || (!demo && countStarted(snapshot));
const editablePicks = () => mode === 'live' || !originalsClosed();

function savePicks(next) {
  try {
    localStorage.setItem(picksKey, JSON.stringify(next));
    picks = next;
    picksError = '';
    return true;
  } catch {
    picksError = 'Could not save your picks. Check that this browser allows site storage.';
    return false;
  }
}

function predictionRows() {
  const results = new Map(snapshot?.results?.map(row => [row.id,row]));
  const districts = demo ? [...results.keys()] : Object.keys(roster);
  return districts.sort((a,b) => roster[a].localeCompare(roster[b])).map(key => {
    const row = results.get(key);
    const pick = Object.hasOwn(picks[mode], key) ? picks[mode][key] : null;
    const published = snapshot?.status !== 'archive' ? row?.fp : null;
    const choices = new Map([...(nominations[key] ?? []), ...(published ?? [])].map(c => [candidateKey(c), c]));
    if (pick && !choices.has(candidateKey(pick))) choices.set(candidateKey(pick), pick);
    return { key, name:roster[key], pick, choices, ...predictionResult(pick,row,snapshot?.status) };
  });
}

const pickName = candidate => `${candidateLabel(candidate)} · ${partyName(candidate.party)}`;
const pickStatusBadge = status => `<span class="badge pick-${status}">${pickStatuses[status]}</span>`;
function predictionsView() {
  if (!mode) mode = originalsClosed() && (picks.lockedAt === null && !Object.keys(picks.original).length) ? 'live' : 'original';
  const summary = predictionSummary(predictionRows());
  const complete = summary.picked === 88;
  const majority = complete && summary.parties.find(([party,n]) => party !== 'Independents' && n >= 45);
  const lockText = picks.lockedAt !== null ? `Locked ${time(picks.lockedAt)} Melbourne time.` : originalsClosed() ? 'Pre-count picks are closed.' : 'Edit until you lock your picks or counting starts.';
  return `<section id="my-predictions" aria-labelledby="title">
    <div class="pick-intro"><p>Pick a winner in any district and follow your calls as results come in. Picks are saved in this browser.</p>
    <div class="tools"><label for="picks-mode">Prediction set</label><select id="picks-mode">${Object.entries(predictionModes).filter(([key]) => key === 'original' || originalsClosed() || mode === 'live').map(([key,label]) => `<option value="${key}"${mode === key ? ' selected' : ''}>${label}</option>`).join('')}</select>
    ${mode === 'original' && editablePicks() ? `<button type="button" id="lock-picks" class="outline"${summary.picked ? '' : ' disabled'}>Lock my picks</button>` : ''}
    <span class="meta">${mode === 'original' ? lockText : 'Editable until each seat is declared. Kept separate from pre-count picks.'}</span></div></div>
    <p class="notice warn" role="alert"${picksError ? '' : ' hidden'}>${esc(picksError)}</p>
    <div class="stats pick-stats" aria-live="polite">${[[`Districts picked`,`${summary.picked} / ${demo ? snapshot.results.length : 88}`],['On track · Behind',`${summary.ahead} · ${summary.behind}`],[demo ? 'Simulated declaration score' : 'Declared picks correct',`${summary.correct} / ${summary.declared}`]].map(([label,value]) => `<div class="stat"><small>${label}</small><strong>${value}</strong></div>`).join('')}</div>
    <p class="meta pick-explainer">${summary.pending} too early to call. ${demo ? 'The demo uses simulated counts.' : 'Only VEC declarations count toward the score.'}</p>
    ${summary.parties.length ? `<div class="card pick-seats"><h3>${complete ? 'Your statewide prediction' : 'Your picks by party'}</h3><ul>${summary.parties.map(([party,n]) => `<li class="${tint(party)}">${esc(party)} <strong>${n}</strong></li>`).join('')}</ul>${complete ? `<p class="meta">${majority ? `${esc(majority[0])} reaches the 45-seat majority.` : 'No single party reaches the 45-seat majority.'}</p>` : ''}</div>` : ''}
    <div class="tools"><input type="search" id="pick-search" placeholder="Search districts" aria-label="Search prediction districts" value="${esc(pickSearch)}"><label for="pick-filter">Show</label><select id="pick-filter">${Object.entries(pickFilters).map(([value,label]) => `<option value="${value}"${value === pickFilter ? ' selected' : ''}>${label}</option>`).join('')}</select></div>
    <div class="card" id="pick-list"></div></section>`;
}

function predictionList() {
  const rows = predictionRows().filter(({name, pick, status, call}) => name.toLowerCase().includes(pickSearch.trim().toLowerCase()) && (
    pickFilter === 'all' || (pickFilter === 'picked' && pick) || (pickFilter === 'unpicked' && !pick && (mode !== 'live' || call?.label !== 'Declared')) ||
    (pickFilter === 'behind' && status === 'behind') || (pickFilter === 'declared' && ['correct','missed'].includes(status))));
  $('pick-list').innerHTML = rows.length ? table(['District','Your pick','Current outlook','Status'],rows.map(({key,name,pick,choices,call,status}) => {
    const canEdit = editablePicks() && !(mode === 'live' && call?.label === 'Declared');
    const picker = canEdit && choices.size
      ? `<select id="pick-${esc(key)}" data-pick="${esc(key)}" aria-label="Pick a winner for ${esc(name)}"><option value="">Choose a winner</option>${[...choices].map(([value,c]) => `<option value="${esc(value)}"${pick && candidateKey(pick) === value ? ' selected' : ''}>${esc(pickName(c))}</option>`).join('')}</select>`
      : pick ? esc(pickName(pick)) : `<span class="meta">${canEdit ? 'Candidates unavailable' : '—'}</span>`;
    return `<tr><th scope="row"><a href="${districtHref(key)}">${esc(name)}</a></th><td>${picker}</td><td>${call ? `${call.candidate ? `${esc(candidateLabel(call.candidate))} ` : ''}${predictionBadge(call)}` : '—'}</td><td>${pickStatusBadge(status)}</td></tr>`;
  }).join(''),'District predictions','picks-table',4) : empty('No districts match this filter.');
}

function predictionCells(row, history) {
  if (snapshot?.status === 'archive') return '<td class="num">—</td><td>—</td>';
  const projection = row?.projection;
  const call = projectedParty(row?.stale ? {...row,stale:false} : row,projection,history);
  const resultTitle = projection?.districtOnly ? `District-count estimate: extrapolates the published TCP share from ${num(projection.tcpCount)} votes while booth data is unavailable or out of sync.` : projection ? `${projection.assumedPair ? 'Assumes the historical TCP pair. ' : ''}${num(projection.tcpCount)} published TCP votes; ${num(projection.fpEstimated)} estimated from first preferences; ${num(projection.remaining)} estimated formal votes left. ${projection.currentOnly ? `Uses ${num(projection.completedBooths)} completed election-day booths from this election.` : `${projection.matched} matched booths${projection.matchedTcp ? ' with TCP' : ' with estimated TCP'}.`}` : '';
  const projectedName = projection?.leader ? partyName(projection.leader.party) : '';
  const result = projection ? `<td class="num ${projectedName ? tint(projectedName) : ''}"${projectedName ? ` aria-label="${esc(`${projectedName} ${pct(projection.share)}${predictionStale(row) ? ' · stale' : ''}`)}"` : ''} title="${esc(`${projectedName ? `${projectedName} · ` : ''}${resultTitle}`)}">${projectedName ? pct(projection.share) : 'Tied · 50.00%'}${stalePredictionBadge(row)}</td>` : '<td class="num">—</td>';
  const callTitle = call?.locked ? `Published TCP lead exceeds the enrolment-based maximum of ${num(call.remaining)} votes still outside the TCP count.` : '';
  return `${result}<td${call?.candidate ? ` class="${tint(call.candidate.party)}"` : ''} title="${esc(callTitle)}">${predictionBadge(call)}</td>`;
}

function freshnessView() {
  const rows = new Map(snapshot?.results?.map(row => [row.id,row]));
  const counts = {Fresh:0,Stale:0,Unavailable:0};
  const body = Object.entries(roster).sort(([,a],[,b]) => a.localeCompare(b)).map(([key,name]) => {
    const row = rows.get(key);
    const state = !row ? 'Unavailable' : row.stale || snapshot.status === 'stale' ? 'Stale' : 'Fresh';
    const error = snapshot?.districtErrors?.[key];
    const issue = error === 404 ? 'District page: 404 Not Found' : Number.isInteger(error) ? `District page: HTTP ${error}` : error === 'not-attempted' ? 'Not checked this run' : error ? 'District read failed' : row?.boothReadIssue ?? (row?.tcpPageIssue ? 'Booth TCP: outage reported by VEC' : '—');
    counts[state]++;
    return `<tr><th scope="row"><a href="${districtHref(key)}">${esc(name)}</a></th><td${state === 'Stale' ? ' class="stale"' : ''}>${state}</td><td>${esc(issue)}</td><td>${esc(time(row?.at) ?? '—')}</td><td>${esc(time(row?.updatedAt) ?? '—')}</td></tr>`;
  });
  return `<section aria-label="District data freshness"><p>Fresh means the district page was read in the latest snapshot, even if no votes have been reported. Stale means its last successful result is still displayed. Read issues are from the last district collection. Times are Melbourne time.</p><div class="stats">${Object.entries(counts).map(([label,total]) => `<div class="stat"><small>${label}</small><strong>${total}</strong></div>`).join('')}</div><div class="card">${table(['District','Data status','Read issue','Last successful read','Last result change'],body.join(''),'District data freshness','',5)}</div></section>`;
}

function districtList() {
  const rows = new Map(snapshot?.results?.map(r => [r.id, r]));
  const list = Object.entries(roster).filter(([key,name]) => (!views.watched || watched.has(key)) && name.toLowerCase().includes(views.search.trim().toLowerCase()));
  const parties = [...majorParties, 'Other'];
  const {districtUnits:units, districtParty:active} = views;
  const counts = units === 'votes', swings = units === 'swing';
  const ranked = new Map([...rows].map(([key,row]) => {
    const votes = partyVotes(row.fp, undefined, true);
    if (!votes.has('Other')) votes.set('Other', 0);
    return [key, { votes, formal:sum([...votes.values()]), tcp:race(row),
      swing:swings && canCompare(row) ? partySwing(votes, partyVotes(priorVotes(key), undefined, true)) : null }];
  }));
  const value = (key, party) => {
    const data = ranked.get(key);
    if (swings) return data?.swing?.get(party) ?? null;
    const votes = data?.votes.get(party) ?? null;
    return counts ? (data?.formal ? votes : null) : share(votes, data?.formal);
  };
  const score = key => {
    if (active) return value(key,active) ?? -Infinity;
    if (views.sort === 'close') return -(ranked.get(key)?.tcp.margin ?? Infinity);
    if (views.sort === 'votes') return ranked.get(key)?.formal ?? 0;
    if (views.sort === 'updated') {
      const row = rows.get(key);
      return row?.stale ? -Infinity : Date.parse(row?.updatedAt) || -Infinity;
    }
    return 0;
  };
  list.sort(([a,an],[b,bn]) => (score(b) - score(a)) || an.localeCompare(bn));
  const format = swings ? delta : counts ? num : pct;
  const band = swings ? `First preference swing vs ${demo ? '2022 demo baseline' : '2022'}` : counts ? 'First preference votes' : 'First preference share';
  $('district-list').innerHTML = list.length ? matrix('District results', ['District','TCP Share','TCP Swing','Predicted result','Predicted party','Formal votes'], band, parties.map(label => ({label,key:label,swing:swings})), list.map(([key,name]) => {
    const r = rows.get(key), data = ranked.get(key), lead = data?.tcp.leader;
    const tcpShare = data?.tcp.margin == null ? null : 50 + data.tcp.margin;
    const prior = priorTcp(key);
    const tcpSwing = snapshot?.status === 'archive' ? null : districtTcpSwing(r,prior,lead);
    const tcpTint = lead ? tint(lead.party) : '';
    const tcpDisplay = data?.tcp.tied ? `Tied · ${pct(tcpShare)}` : pct(tcpShare);
    return `<tr><td class="pinned">${star(key)} <a href="${districtHref(key)}">${esc(name)}</a>${r?.elected ? ' <span class="badge declared">Declared</span>' : ''}${r?.stale ? ' <small class="stale">Stale</small>' : ''}</td>${cell(tcpDisplay,tcpTint,lead?.party)}${cell(delta(tcpSwing),`${tcpTint} ${signed(tcpSwing)}`)}${predictionCells(r,historicalResults?.[key]?.winner)}${cell(num(data?.formal || null))}${parties.map(p => { const n = value(key,p); return bandCell(p,format(n),swings ? `swing-col ${signed(n)}` : ''); }).join('')}</tr>`;
  }).join(''), 'district-party', views.districtParty) : empty(views.watched ? 'No watched districts match this filter.' : 'No districts match this search.');
}

function candidateTable(rows, name, showSwing = false, colour = false) {
  const total = sum(rows.map(r => r.votes));
  const coloured = party => colour === 'all' || (colour === 'major' && majorParties.includes(partyName(party)));
  return rows.length ? table(['Candidate','Party','Votes','Share', ...(showSwing ? ['Swing'] : [])],[...rows].sort((a,b) => (b.votes ?? -1)-(a.votes ?? -1)).map(c => `<tr${coloured(c.party) ? ` class="${tint(c.party)}"` : ''}><td>${esc(c.name)}</td><td>${esc(titleCase(c.party))}</td>${cell(num(c.votes))}${cell(pct(share(c.votes,total)))}${showSwing ? cell(delta(c.swing),signed(c.swing)) : ''}</tr>`).join(''), name, colour ? 'party-row-table' : '', 2) : empty('No results published for this count yet.');
}

function projectionBreakdown(projection) {
  const parts = [
    ['tcp','Published TCP',projection.tcpCount],
    ['fp','First preferences awaiting TCP',projection.fpEstimated],
    ['remaining','Estimated votes still to report',projection.remaining],
  ];
  let x = 0;
  const segments = parts.map(([stage,,count]) => {
    const rect = `<rect class="count-${stage}" x="${x}" y="0" width="${count}" height="1"/>`;
    x += count;
    return rect;
  }).join('');
  return `<div class="race-breakdown"><h4>What goes into the prediction</h4><svg class="race-meter" aria-hidden="true" viewBox="0 0 ${x} 1" preserveAspectRatio="none">${segments}</svg>
    <ul class="race-legend">${parts.map(([stage,label,count]) => `<li><span class="count-${stage}" aria-hidden="true"></span><span>${label}</span><strong>${num(count)}</strong></li>`).join('')}</ul></div>`;
}

function districtRaceSummary(row) {
  if (snapshot?.status === 'archive') return '';
  const fresh = snapshot?.status !== 'stale' && !row?.stale;
  const comparisons = comparisonHistory?.districts?.[id];
  const old = priorBoothTcp(id);
  const projection = row?.projection;
  const call = projectedParty(row?.stale ? {...row,stale:false} : row,projection,historicalResults?.[id]?.winner);
  const current = race(row);
  const metric = (label,value,party,description,detail = '') => `<div class="race-metric ${party ? tint(party) : ''}"><dt>${label}</dt><dd${description ? ` aria-label="${esc(description)}" title="${esc(description)}"` : ''}>${value}</dd>${detail}</div>`;
  const currentValue = current.tied ? 'Tied · 50.00%' : pct(current.margin === null ? null : 50 + current.margin);
  const matched = fresh && !boothData?.stale && !boothData?.tcp?.stale ? boothMatchedTcpSwing(row,boothData?.tcp,old,comparisons?.moved) : null;
  const currentSide = current.leader ?? (current.tied ? row.two[0] : null);
  const currentSwing = currentSide ? matched?.swing[row.two.indexOf(currentSide)] ?? null : null;
  const swingBaseline = currentSwing === null ? '' : ` title="${esc(`${currentSide.name} · ${matched.matched} matched election-day ${matched.matched === 1 ? 'booth' : 'booths'} vs ${comparisons?.year ?? 2022}`)}"`;
  const matchedDetail = `<dd class="race-matched-swing"${swingBaseline}>Booth-matched swing: ${currentSwing === null ? '—' : `${current.tied ? `${partyShort(currentSide.party)} ` : ''}<span class="${signed(currentSwing)}">${delta(currentSwing)}</span>`}</dd>`;
  const predictedValue = projection?.leader ? pct(projection.share) : projection ? 'Tied · 50.00%' : '—';
  const projectedSwing = (['final-results-v2','final-results-v3','final-results-v4'].includes(projection?.baseline) || demo) ? projection?.projectedSwing : null;
  const projectedDetail = `<dd class="race-projected-swing" title="Forecast final TCP share compared with the previous final district share for the same side">Projected swing: ${projectedSwing === null ? '—' : `<span class="${signed(projectedSwing)}">${delta(projectedSwing)}</span>`}</dd>`;
  const probability = !call?.locked && !row?.elected ? projection?.winProbability : null;
  const chance = probability == null ? '' : `<small class="race-chance">${probability > 0.99 ? '&gt;99%' : `≈${Math.round(100*probability)}%`} modelled win chance${call?.candidate ? '' : ` for ${partyShort(projection.leader.party)}`}</small>`;
  const leadText = current.leader ? `${partyName(current.leader.party)} leads the published TCP count by ${num(current.votes)} ${current.votes === 1 ? 'vote' : 'votes'}.` : current.tied ? 'The published TCP count is tied.' : '';
  const context = predictionStale(row) && projection ? `Showing the last available prediction${lastPredictionTime(row) ? ` from ${lastPredictionTime(row)} Melbourne time` : ''}.`
    : !fresh ? 'Showing the last available district count.'
    : row?.elected ? 'The VEC has declared the result.'
    : call?.locked ? `${leadText} At most ${num(call.remaining)} votes are outside the TCP count, based on official enrolment. The lead cannot be overtaken for the published pair if the current tally stands.`
    : projection ? `${leadText}${leadText ? ' ' : ''}The estimate of votes still to report is based on historical turnout.`
    : [leadText, row?.twoStatus === 'withheld' ? 'The VEC is withholding the TCP count.' : row?.twoStatus === 'replaced' ? 'The VEC has replaced TCP with the preference distribution.' : 'A prediction will appear when there is enough comparable count data.'].filter(Boolean).join(' ');
  const projectionNote = projection ? `<p class="race-swing meta">${projection.districtOnly ? 'District-count estimate: assumes the remaining votes follow the published district TCP split. Leaning requires the lead to survive separate tests for a shift in outstanding votes and higher turnout.' : projection.currentOnly ? `Estimate uses ${num(projection.completedBooths)} completed election-day booths from this election. Booths still to report may vote differently.` : `${num(projection.matched)} matched ${projection.matched === 1 ? 'booth' : 'booths'} with ${projection.matchedTcp ? 'published TCP' : 'estimated TCP'}.${projection.assumedPair ? ' This projection assumes the historical TCP pair.' : ''}`}</p>` : '';
  return `<section class="card race-summary" aria-labelledby="race-summary-heading"><h3 id="race-summary-heading">Race summary</h3><dl class="race-metrics">
    ${metric('Current TCP',currentValue,current.leader?.party,current.leader && `${partyName(current.leader.party)} ${currentValue}`,matchedDetail)}
    ${metric('Predicted result',`${predictedValue}${stalePredictionBadge(row)}`,projection?.leader?.party,projection?.leader && `${partyName(projection.leader.party)} ${predictedValue}${predictionStale(row) ? ' · stale' : ''}`,projectedDetail)}
    ${metric('Predicted party',`${predictionBadge(call)}${chance}`,call?.candidate?.party)}
    </dl>${projection ? projectionBreakdown(projection) : ''}${projectionNote}<p class="race-context meta">${esc(context)}</p>
    ${projection && !projection.districtOnly && !call?.locked ? `<details class="race-method meta"><summary>How win chance is estimated</summary><p>${chance ? '' : 'A percentage is shown once there is enough published TCP from enough booths. '}The model estimates the chance that the projected leader finishes above 50% for the published TCP pair. ${projection.currentOnly ? 'It uses the variation in TCP shares across completed election-day booths and allows more uncertainty about how the remaining booths will vote.' : 'It uses how consistently matched booths are swinging.'} It also accounts for TCP coverage, the projected margin, and uncertainty about preferences and turnout. These estimates have not been calibrated against past election-night counts and can change as more booths report.</p><p>Leaning and Likely use separate tests of whether the lead would survive worse-than-expected results in the remaining count. A mathematical lock requires a published lead larger than the official upper bound on votes still outside the TCP count.</p></details>` : ''}</section>`;
}

function districtPrediction(row) {
  if (snapshot?.status === 'archive') return '';
  const saved = Object.keys(predictionModes).filter(key => Object.hasOwn(picks[key], id));
  const parties = saved.map(key => partyName(picks[key][id].party));
  const split = new Set(parties).size > 1;
  const headline = split ? parties.map((party, i) => `<span class="prediction-party ${tint(party)}">${esc(party)} (${i === 0 ? 'pre-count' : 'live'})</span>`).join(' · ') : esc(parties[0] || 'No pick yet');
  const rows = saved.map(key => {
    const pick = picks[key][id];
    const {status} = predictionResult(pick, row, snapshot?.status);
    return `<div><dt class="meta">${predictionModes[key]}</dt><dd><strong>${esc(pickName(pick))}</strong> ${pickStatusBadge(status)}</dd></div>`;
  });
  return `<details id="district-prediction" class="card district-prediction"${$('district-prediction')?.open ? ' open' : ''}>
    <summary id="district-prediction-toggle" class="${!split && parties[0] ? tint(parties[0]) : ''}">Your prediction: ${headline}</summary>
    ${rows.length ? `<dl>${rows.join('')}</dl>` : ''}
    <a class="meta" href="${predictionsHref}">Open My Predictions →</a>
  </details>`;
}

function districtMarket() {
  const options = sportsbetOdds?.[id];
  if (snapshot?.status === 'archive' || !options?.length) return '';
  const shortest = Math.min(...options.map(([, odds]) => odds));
  const favourites = options.filter(([, odds]) => odds === shortest).map(([label]) => label);
  const favouriteParty = favourites.length === 1 ? favourites[0].replace(/^Independent \(.+\)$/, 'Independent') : '';
  const names = new Intl.ListFormat('en-AU').format(favourites);
  const rows = options.map(([label, odds]) => `<tr><th scope="row">${esc(label)}</th>${cell(odds.toFixed(2))}</tr>`).join('');
  return `<details id="district-market" class="card district-market"${$('district-market')?.open ? ' open' : ''}>
    <summary id="district-market-toggle" class="${favouriteParty ? tint(favouriteParty) : ''}">Sportsbet ${favourites.length === 1 ? 'favourite' : 'joint favourites'}: ${esc(names)}</summary>
    <p class="meta">Decimal odds for the district winner. Capture date unknown. These prices are separate from the dashboard forecast.</p>
    ${table(['Market option', 'Decimal odds'], rows, 'Sportsbet district winner odds')}
  </details>`;
}

function districtHistoricalResult() {
  const result = historicalResults?.[id];
  if (!result) return '';
  const {rows, year, source, winner, kind} = result;
  const margin = finalTcp(result) ? share(rows[0].votes, sum(rows.map(row => row.votes))) - 50 : null;
  const label = kind === 'distribution' ? 'Final preference distribution' : kind === 'published-tcp' ? 'Published indicative TCP count' : 'Declared result';
  return `<details id="district-history" class="card district-history"${$('district-history')?.open ? ' open' : ''}>
    <summary id="district-history-toggle" class="${tint(winner.party)}"${margin === null ? '' : ' title="Winning share above 50% after preferences"'}>${year} winner: ${esc(partyName(winner.party))}${margin === null ? '' : ` (${pct(margin)})`}</summary>
    <p class="meta">${id === 'narracan' ? `${year} supplementary election · ` : ''}${label} · <a href="${esc(source)}">VEC results ↗</a></p>
    ${rows.length ? candidateTable(rows, `${year} ${label.toLowerCase()}`, false, 'all') : ''}
  </details>`;
}

function districtView() {
  const d = snapshot?.results?.find(r => r.id === id);
  const available = boothData?.status === 'ok';
  const historical = snapshot?.status === 'archive';
  const hasRows = available && (boothData.booths.length || boothData.pooled?.length || boothData.tcp?.pooled?.length);
  const matched = !expanded && available && !historical && history && comparisonHistory ? electorateSwing(boothData.candidates, boothData.booths, history.districts[id], comparisonHistory.districts[id]) : null;
  const swingByParty = new Map(matched?.parties.map(p => [p.label,p.swing]));
  const fp = (d?.fp ?? []).map(c => ({...c,swing:swingByParty.get(partyName(c.party))}));
  const tcp = (d?.two ?? []).map(c => ({...c,swing:historical ? null : districtTcpSwing(d,priorTcp(id),c)}));
  const tcpSwingNote = `Swing is in percentage points against ${demo ? 'the same subset of historical ballots' : `the final ${id === 'narracan' ? '2023 supplementary' : '2022'} preference distribution`}. A dash means no comparable final pair.`;
  const swingNote = historical ? '' : matched?.reported
    ? `Swing compares ${matched.matches.size} of ${matched.reported} reporting booths with their ${matched.year} counterparts${matched.coverage !== null ? ` (${pct(matched.coverage)} of reported booth votes)` : ''}. Votes and Share use the full district count.`
    : 'Matched swing appears when comparable booth results are available. Votes and Share use the full district count.';
  return `${expanded ? '' : `<section id="district-count"><div class="section-head"><h2>District count</h2><div class="count-status meta">${outcome(d)} ${star(id)}${d?.stale ? '<span class="stale">Previous district result</span>' : ''}${d?.source ? `<a href="${esc(d.source)}">VEC district results ↗</a>` : ''}</div></div>
  ${districtRaceSummary(d)}
  <div class="district-context">${districtHistoricalResult()}${districtPrediction(d)}${districtMarket()}</div>
  <div class="grid detail-grid"><div class="card"><h3>First preferences</h3>${candidateTable(fp, 'District first preferences', !historical, 'all')}${fp.length && swingNote ? empty(esc(swingNote)) : ''}</div><div class="card"><h3>Two-candidate-preferred</h3>${d?.twoStatus === 'withheld' ? empty('The VEC is not publishing a current TCP count.') : d?.twoStatus === 'replaced' ? empty('The VEC has replaced the TCP count with the preference distribution.') : candidateTable(tcp, 'District two-candidate-preferred', !historical, 'all') + (!historical && tcp.length ? empty(tcpSwingNote) : '')}</div></div></section>`}
  <section id="booths">${expanded ? '' : `<div class="section-head"><h2>Booth results</h2><a id="booth-size" class="outline" href="${esc(boothHref(id,true))}">⤢ Maximise booth table</a></div>`}
    ${d?.tcpReportUrl && d.twoStatus !== 'withheld' ? `<p class="meta">${d.tcpPageIssue ? 'The VEC reports an issue with its booth TCP page. ' : ''}<a href="${esc(d.tcpReportUrl)}">Download official booth TCP results (Excel) ↗</a></p>` : ''}
    ${boothData?.tcp?.spreadsheet ? `<p class="meta">Booth TCP source: VEC Excel report.${boothData.tcp.stale ? ' This report is out of sync with the published district count.' : ''}</p>` : ''}
    ${boothData?.stale ? '<p class="notice warn">Showing the last successful booth results. These counts are stale.</p>' : boothData?.tcp?.stale && !boothData.tcp.spreadsheet ? `<p class="notice warn">Booth TCP is stale. Showing the last successful TCP count${boothData.tcp.at ? ` from ${esc(time(boothData.tcp.at))} Melbourne time` : ''}.</p>` : ''}
    ${!expanded && boothData?.tcpPreview ? '<p class="notice warn">TCP swing preview: simulated TCP votes compared with the official 2022 booth count. First preferences are from the 2022 archive.</p>' : ''}
    <div class="tools">${expanded ? `<label for="booth-district">Electorate</label><select id="booth-district">${Object.entries(roster).sort(([,a],[,b]) => a.localeCompare(b)).map(([key,name]) => `<option value="${esc(key)}"${key === id ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select>` : ''}<input type="search" id="booth-search" placeholder="Search voting centres" aria-label="Search voting centres" value="${esc(views.boothSearch)}"><select id="booth-sort" aria-label="Sort voting centres"><option value="name">Booth A–Z</option><option value="votes">Most votes</option></select><select id="booth-units" aria-label="Booth vote display"><option value="share">Vote share (%)</option><option value="votes">Vote counts</option><option value="swing">Swing</option></select>${expanded ? `<label class="booth-filter">Show <select id="booth-filter">${[...boothFilters].map(([value,label]) => `<option value="${value}"${views.boothFilter === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>${historical ? `<span class="meta booth-preview">${boothData?.tcpPreview ? '2022 archive · Simulated TCP' : '2022 archive'}</span>` : ''}<div class="booth-actions"><a id="booth-size" class="outline" href="${esc(boothHref(id,false))}">↙ Back to district view</a></div>` : ''}</div>
    ${hasRows || (expanded && d?.fp.some(c => c.votes !== null)) ? `<div id="booth-list" class="card"></div>${!historical && priorBoothTcp(id) ? `<p id="booth-tcp-baseline-note" class="meta" hidden>Booth TCP swing vs indicative ${id === 'narracan' ? '2023' : '2022'} booth count. ~ marks an estimate.</p>` : ''}<p id="booth-swing-note" class="meta" hidden></p>` : ''}
    ${hasRows ? `<p class="meta">${demo ? 'Demo counts use selected historical results.' : `${boothData.tcp?.status === 'withheld' ? 'The VEC is withholding TCP. ' : boothData.tcp?.status === 'unavailable' ? 'The TCP page could not be read. ' : !boothData.tcp?.booths?.length && !boothData.tcp?.pooled?.length ? 'No booth TCP available yet. ' : ''}Booth pages checked ${esc(time(boothData.at))} Melbourne time · <a href="${esc(boothData.source)}">VEC first preferences ↗</a>${boothData.tcp?.source ? ` · <a href="${esc(boothData.tcp.source)}">VEC TCP ↗</a>` : ''}`}</p>` : `<div class="card">${empty(demo ? 'No demo counts for this district. Try Bass, Gippsland East, Hawthorn, Melbourne, Northcote or Richmond.' : boothData?.status === 'unavailable' ? 'The voting-centre page could not be read. Try refreshing.' : 'No voting-centre rows available yet.')}</div>`}
  </section><dialog id="booth-dialog" aria-labelledby="venue-name"><div id="booth-result"></div><form method="dialog"><button class="outline">Close</button></form></dialog>`;
}

function comparisonsForBooths() {
  const archive = snapshot?.status === 'archive';
  const old = !archive || boothData.tcpPreview ? priorBoothTcp(id) : null;
  const extras = archive ? {} : comparisonHistory?.districts?.[id];
  return boothComparisons(boothData.booths, archive ? [] : history?.districts?.[id], old,
    {...extras,tcp:old,estimates:old ? extras?.estimates : extras?.estimates?.map(b => ({...b,tcp:null}))}, boothData.tcp);
}

function tcpValues(votes) {
  const total = sum(votes ?? []);
  return votes?.length ? {votes, shares:votes.map(v => share(v,total)), swing:[null,null]} : null;
}

function pooledBooths() {
  const archive = snapshot?.status === 'archive';
  const extra = comparisonHistory?.districts?.[id];
  const year = extra?.year ?? 2022;
  const priorFp = archive ? null : extra?.pooled ?? pooledHistory?.[id];
  const priorTcp = archive ? null : priorBoothTcp(id);
  const tcp = boothData?.tcp;
  const keyedPools = rows => (rows ?? []).map(row => ({...row,name:row.kind}));
  const tcpSwings = matchedTcp({status:tcp?.status,pair:tcp?.pair,booths:keyedPools(tcp?.pooled)},
    {pair:priorTcp?.pair,booths:keyedPools(priorTcp?.pooled)});
  const pools = new Map((boothData?.pooled ?? []).map(row => {
    const prior = priorFp?.[row.kind];
    const swing = prior ? partySwing(partyVotes(boothData.candidates,row.votes), partyVotes(Object.entries(prior).map(([party,votes]) => ({party,votes})))) : new Map();
    for (const label of swing.keys()) if (partyName(label).toLowerCase() === 'independent') swing.delete(label);
    return [row.kind,{...row,swing,baseline:swing.size ? {year,fpMethod:'same vote category'} : null}];
  }));
  for (const row of boothData?.tcp?.pooled ?? []) {
    const fp = pools.get(row.kind);
    pools.set(row.kind, {...row,...fp,name:row.kind === 'early-total' && !fp ? 'Prepoll total (TCP only)' : row.name,
      votes:fp?.votes, swing:fp?.swing ?? new Map(), tcp:tcpSwings.get(boothKey({...row,name:row.kind})) ?? tcpValues(row.votes), year});
  }
  return [...pools.values()];
}

function boothList() {
  syncBoothLink();
  if (!$('booth-list')) return;
  const district = snapshot?.results?.find(r => r.id === id);
  const summary = expanded && district?.fp.some(c => c.votes !== null);
  const booths = boothData?.booths ?? [];
  const candidates = boothData?.candidates ?? district?.fp ?? [];
  const archive = snapshot?.status === 'archive';
  const showPrimarySwing = views.boothUnits === 'swing';
  const showCounts = views.boothUnits === 'votes';
  const showTcpSwing = !archive || boothData?.tcpPreview;
  const comparisons = booths.length ? comparisonsForBooths() : new Map();
  const note = $('booth-swing-note');
  note.hidden = !showPrimarySwing;
  const reporting = booths.filter(b => sum(b.votes) > 0);
  const withBaseline = reporting.filter(b => comparisons.get(boothKey(b))?.fpVotes).length;
  note.textContent = archive ? 'First-preference swing needs 2026 booth results.' :
    `Historical comparison available for ${withBaseline} of ${reporting.length} reporting booths. Pooled swings compare the same vote category. A dash means no comparable result.`;
  const tcp = boothData?.tcp;
  const labels = [...new Set([...candidates, ...(summary ? district.fp : [])].map(c => partyName(c.party)))];
  const parties = [...majorParties.filter(p => labels.includes(p)), ...labels.filter(p => !majorParties.includes(p)).sort()];
  const primaryColumns = parties.map(label => ({label,key:`fp:${label}`,swing:showPrimarySwing}));
  const pair = tcp?.status === 'ok' ? tcp.pair : district?.two ?? [];
  const sideIndex = ['Labor', 'Liberal'].map(p => pair.findIndex(c => partyName(c.party) === p)).find(i => i >= 0) ?? 0;
  const candidate = pair[sideIndex];
  const side = candidate ? { label:partyName(candidate.party), tcp:true, side:sideIndex, candidate:candidate.name } : {label:'',tcp:true};
  const tcpColumns = [
    {...side, display:candidate ? `${partyAbbreviation(side.label)} TCP` : 'Count', key:candidate ? `tcp:${sideIndex}` : null, edge:showTcpSwing ? 'tcp-start' : 'tcp-start tcp-end'},
    ...(showTcpSwing ? [{...side, display:'Swing', key:candidate ? `tcp-swing:${sideIndex}` : null, swing:true, edge:'tcp-end'}] : []),
  ];
  const columns = [...tcpColumns,...primaryColumns];
  const list = booths.map((b,i) => {
    const total = sum(b.votes), baseline = comparisons.get(boothKey(b));
    const votes = partyVotes(candidates,b.votes);
    const swing = new Map(showPrimarySwing && baseline?.fpVotes ? matchedSwing(candidates,[b],[[b.kind,b.name,baseline.fpVotes]]).parties.map(p => [p.label,p.swing]) : []);
    return { ...b, ref:String(i), category:b.kind === 'early' ? 'Prepoll' : 'Election day', total, baseline, votes, swing, tcp:baseline?.tcp };
  }).concat(pooledBooths().map(b => ({...b, ref:`pool-${b.kind}`, category:['postal','absent','provisional','marked','declaration'].includes(b.kind) ? 'Declaration' : 'Pooled votes',
    total:b.votes ? sum(b.votes) : null, votes:b.votes ? partyVotes(candidates,b.votes) : new Map() })))
    .filter(b => `${b.name} ${b.category}`.toLowerCase().includes(views.boothSearch.trim().toLowerCase()))
    .filter(b => {
      const filter = expanded ? views.boothFilter : 'all';
      return filter === 'all' || (filter === 'ordinary' && b.kind === 'ordinary') ||
        (filter === 'declaration' && b.category === 'Declaration') ||
        (filter === 'reported' && (b.total > 0 || b.tcp?.votes.some(v => v > 0)));
    });
  const value = (b, column) => column.tcp ? b.tcp?.[column.swing ? 'swing' : showCounts ? 'votes' : 'shares'][column.side] ?? null : column.swing ? b.swing.get(column.label) ?? null : showCounts ? b.votes.get(column.label) ?? null : share(b.votes.get(column.label) ?? null,b.total);
  const selected = columns.find(c => c.key === views.boothParty);
  const categoryOrder = {'Election day':0, Prepoll:1, 'Pooled votes':2, Declaration:3};
  list.sort((a,b) => (selected ? (value(b,selected) ?? -Infinity) - (value(a,selected) ?? -Infinity) : views.boothSort === 'votes' ? b.total-a.total : categoryOrder[a.category]-categoryOrder[b.category]) || a.name.localeCompare(b.name));
  const units = showCounts ? 'votes' : 'share';
  const groups = [{label:`TCP · ${units}${showTcpSwing ? ' & swing' : ''}`,count:tcpColumns.length,tcp:true},{label:`First preferences · ${showPrimarySwing ? 'swing' : units}`,count:primaryColumns.length}];
  const renderRow = (b, isTotal = false) => `<tr${isTotal ? ' class="electorate-total"' : ''}><th scope="row" class="pinned">${isTotal ? `Electorate total${district.stale ? ' <small class="stale">Previous count</small>' : ''}` : `<button class="venue" data-venue="${b.ref}">${esc(b.name)}</button>`}</th>${cell(num(b.total))}${columns.map(c => {
    const v = value(b,c);
    let display = c.swing ? delta(v) : showCounts ? num(v) : pct(v,false);
    if (c.tcp && c.swing && v !== null && !archive && b.tcp?.method && b.tcp.method !== 'Booth match') display += ` <abbr title="${b.baseline.year} ${esc(b.tcp.method.toLowerCase())}">~</abbr>`;
    return c.label ? bandCell(c.label,display,`${c.edge ?? ''} ${c.swing ? `swing-col ${signed(v)}` : ''}`) : cell(display,c.edge);
  }).join('')}</tr>`;
  let summaryRow = '';
  if (summary) {
    const matched = showPrimarySwing && !archive && booths.length && history && comparisonHistory ? electorateSwing(candidates, booths, history.districts[id], comparisonHistory.districts[id]) : null;
    const tcpVotes = pair.map(c => district.two?.find(r => r.name === c.name)?.votes ?? null);
    const tcp = district.twoStatus === 'reported' && tcpVotes.every(v => v !== null) ? tcpValues(tcpVotes) : null;
    if (tcp && !archive) tcp.swing = pair.map(c => districtTcpSwing(district,priorTcp(id),c));
    summaryRow = renderRow({votes:partyVotes(district.fp), total:sum(district.fp.map(c => c.votes)), swing:new Map(matched?.parties.map(p => [p.label,p.swing])),
      tcp}, true);
  }
  const message = expanded && views.boothFilter !== 'all' ? 'No booths or vote categories match this filter.' : views.boothSearch.trim() ? 'No booths or vote categories match this search.' : 'No booth or vote-category results available yet.';
  const showTable = Boolean(list.length || summaryRow);
  $('booth-list').innerHTML = (showTable ? matrix('Voting-centre results',['Voting centre or vote type', archive ? '2022 formal' : '2026 formal'], groups, columns, list.map(b => renderRow(b)).join(''), 'booth-party', views.boothParty, summaryRow) : '') + (list.length ? '' : empty(message));
  const tcpNote = $('booth-tcp-baseline-note');
  if (tcpNote) tcpNote.hidden = !showTable;
}

function render() {
  if (invalid) return;
  const parties = seatOutlook(snapshot?.results ?? [],{allowProjections:snapshot?.status !== 'archive',staleSnapshot:snapshot?.status === 'stale'});
  renderHeaderOutlook(parties);
  const active = document.activeElement;
  const focusId = active?.id;
  const focusStar = active?.dataset?.star;
  const scrollSelector = myPredictions ? '#pick-list .scroll' : '.matrix-scroll';
  const oldScroll = $('content').querySelector(scrollSelector);
  if (statusPage) {
    $('content').innerHTML = freshnessView();
  } else if (myPredictions) {
    $('content').innerHTML = predictionsView();
    predictionList();
  } else if (id) {
    if ($('booth-dialog')?.open) { dialogRefreshPending = true; return; }
    const refreshButton = $('refresh');
    $('content').innerHTML = districtView();
    if (expanded) $('booth-size').before(refreshButton);
    boothList(); $('booth-sort').value = views.boothSort; $('booth-units').value = views.boothUnits;
  } else {
    $('content').innerHTML = statewideView(parties); $('sort').value = views.sort; $('district-units').value = views.districtUnits; districtList();
  }
  if (focusId && active && !document.contains(active)) ($(focusId) ?? (myPredictions ? $(active.dataset.pick ? 'pick-filter' : 'picks-mode') : null))?.focus({ preventScroll:true });
  if (focusStar) document.querySelector(`[data-star="${CSS.escape(focusStar)}"]`)?.focus({ preventScroll:true });
  if (oldScroll) $('content').querySelector(scrollSelector)?.scrollTo(oldScroll.scrollLeft, oldScroll.scrollTop);
}

async function refresh() {
  if (demo || busy || invalid) return;
  busy = true;
  $('refresh').disabled = true;
  let message, warning = false;
  try {
    snapshot = retainSnapshotRows(snapshot,await json('api/results'));
    if (snapshot.source) $('official').href = snapshot.source;
    if (id) {
      const next = await json(`api/results?district=${encodeURIComponent(id)}`).catch(() => ({status:'unavailable'}));
      boothData = next.status !== 'ok' && boothData?.status === 'ok' ? {...boothData,stale:true} : next;
    }
    const stamp = snapshot.at ? ` Last checked ${time(snapshot.at)} Melbourne time.` : '';
    switch (snapshot.status) {
      case 'archive': message = '2022 archive preview · six districts · not 2026 results.'; break;
      case 'waiting': message = 'Waiting for the VEC to publish 2026 results.' + stamp; break;
      case 'unverified': message = 'The VEC results page could not be verified yet.' + stamp; warning = true; break;
      case 'partial': message = `Partial snapshot · ${snapshot.loaded} of 88 district pages read. Vote and seat totals include last-known results where available.` + stamp; warning = true; break;
      case 'stale': message = 'Showing the last available VEC snapshot. The count may have moved on.' + stamp; warning = true; break;
      default: message = 'VEC public results · automatically checks for updates.' + stamp;
    }
  } catch {
    if (snapshot && snapshot.status !== 'archive') snapshot = { ...snapshot, status:'stale' };
    if (boothData?.status === 'ok') boothData = {...boothData,stale:true};
    message = 'The results service could not be reached.' + (snapshot?.results?.length ? ' Showing the last available snapshot.' : ''); warning = true;
  } finally {
    $('status-message').textContent = message;
    $('demo-link').hidden = snapshot?.status !== 'waiting' || warning;
    $('status').hidden = expanded && snapshot?.status === 'archive' && !warning;
    $('status').classList.toggle('warn', warning);
    render();
    busy = false;
    $('refresh').disabled = false;
  }
}

$('refresh').addEventListener('click', refresh);
const siteHeader = $('site-header');
new ResizeObserver(() => document.documentElement.style.setProperty('--header-height', `${siteHeader.offsetHeight}px`)).observe(siteHeader);
$('content').addEventListener('click', e => {
  const button = e.target.closest('button');
  if (button?.id === 'show-more-parties') { views.showAllParties = !views.showAllParties; render(); }
  if (button?.id === 'lock-picks' && !originalsClosed() && Object.keys(picks.original).length) {
    if (window.confirm('Lock your pre-count picks? You can still make separate live picks, but this set can no longer be edited.') && !originalsClosed()) {
      savePicks({ ...picks, lockedAt:Date.now() });
    }
    render();
  }
  if (button?.dataset.star) { toggle(button.dataset.star); render(); }
  for (const [data, key, redraw] of [['districtParty','districtParty',districtList],['boothParty','boothParty',boothList]]) {
    if (!button?.dataset[data]) continue;
    const value = button.dataset[data];
    const scroll = button.closest('.matrix-scroll');
    const { scrollLeft, scrollTop } = scroll;
    views[key] = views[key] === value ? '' : value;
    if (key === 'districtParty') saveDistrictView();
    redraw();
    const attr = data === 'districtParty' ? 'data-district-party' : 'data-booth-party';
    const replacement = document.querySelector(`[${attr}="${CSS.escape(value)}"]`);
    if (replacement) { replacement.closest('.matrix-scroll').scrollTo(scrollLeft,scrollTop); replacement.focus({preventScroll:true}); }
  }
  if (button?.dataset.venue != null) {
    const ref = button.dataset.venue;
    const pooled = ref.startsWith('pool-');
    const booth = pooled ? pooledBooths().find(b => b.kind === ref.slice(5)) : boothData.booths[Number(ref)];
    if (!booth) return;
    const baseline = pooled ? null : comparisonsForBooths().get(boothKey(booth));
    const matches = matchedSwing(boothData.candidates,[booth],baseline?.fpVotes ? [[booth.kind,booth.name,baseline.fpVotes]] : []);
    const swingByParty = pooled ? booth.swing : new Map(matches.parties.map(p => [p.label,p.swing]));
    const fpRows = booth.votes ? boothData.candidates.map((c,i) => ({...c,votes:booth.votes[i],swing:swingByParty.get(partyName(c.party))})) : [];
    const tcp = pooled ? booth.tcp : baseline?.tcp;
    const tcpRows = tcp ? boothData.tcp.pair.map((c,i) => ({...c,votes:tcp.votes[i],swing:tcp.swing[i]})) : [];
    const year = baseline?.year;
    const fpBaseline = pooled ? booth.baseline : matches.parties.length ? baseline : null;
    const tcpBaseline = pooled ? tcp?.swing.some(v => v !== null) && `${booth.year} same vote category` : tcp?.method && `${year} ${tcp.method.toLowerCase()}`;
    $('booth-result').innerHTML = `<h3 id="venue-name">${esc(booth.name)}</h3><h4>First preferences</h4>${candidateTable(fpRows, 'Booth first preferences', true, 'major')}${fpBaseline ? `<p class="meta">Baseline: ${fpBaseline.year} ${esc(fpBaseline.fpMethod.toLowerCase())}</p>` : ''}<h4>Two-candidate-preferred (TCP)</h4>${candidateTable(tcpRows, 'Booth TCP', true, 'major')}${tcpBaseline ? `<p class="meta">Baseline: ${esc(tcpBaseline)}</p>` : ''}`;
    $('booth-dialog').showModal();
  }
});
$('content').addEventListener('input', e => {
  if (e.target.id === 'pick-search') { pickSearch = e.target.value; predictionList(); }
  if (e.target.id === 'search') { views.search = e.target.value; districtList(); }
  if (e.target.id === 'booth-search') { views.boothSearch = e.target.value; boothList(); }
});
$('content').addEventListener('change', e => {
  if (e.target.id === 'picks-mode' && Object.hasOwn(predictionModes,e.target.value)) { mode = e.target.value; render(); }
  if (e.target.id === 'pick-filter') { pickFilter = e.target.value; predictionList(); }
  if (e.target.dataset.pick) {
    const key = e.target.dataset.pick;
    const row = predictionRows().find(row => row.key === key);
    const candidate = row?.choices.get(e.target.value);
    if (row && editablePicks() && !(mode === 'live' && row.call?.label === 'Declared') && (candidate || !e.target.value)) {
      const next = { ...picks[mode] };
      if (candidate) next[key] = { name:candidate.name, party:candidate.party };
      else delete next[key];
      savePicks({ ...picks, [mode]:next });
    }
    render();
  }
  if (e.target.id === 'booth-district' && Object.hasOwn(roster,e.target.value)) location.assign(boothHref(e.target.value,true,false));
  if (e.target.id === 'watched') { views.watched = e.target.checked; saveDistrictView(); districtList(); }
  if (e.target.id === 'sort') { views.sort = e.target.value; views.districtParty = ''; saveDistrictView(); districtList(); }
  if (e.target.id === 'district-units') { views.districtUnits = e.target.value; saveDistrictView(); districtList(); }
  if (e.target.id === 'booth-sort') { views.boothSort = e.target.value; views.boothParty = ''; boothList(); }
  if (e.target.id === 'booth-units') { views.boothUnits = e.target.value; boothList(); }
  if (e.target.id === 'booth-filter') { views.boothFilter = e.target.value; boothList(); }
});
$('content').addEventListener('close', e => { if (e.target.id === 'booth-dialog' && dialogRefreshPending) { dialogRefreshPending = false; render(); } }, true);

try {
  if (demo) {
    $('demo-banner').hidden = false;
    $('status').hidden = true;
    $('refresh').hidden = true;
    document.querySelector('.brand').href = '?demo=1';
    $('back').href = '?demo=1';
    document.title = `Demo · ${document.title}`;
  }
  roster = await json('data/districts.json');
  if (id !== null && !Object.hasOwn(roster, id)) {
    invalid = true; $('status').hidden = false; $('status-message').textContent = 'Unknown district.'; $('back').hidden = false; $('refresh').hidden = true;
  } else {
    $('predictions-link').href = predictionsHref;
    $('predictions-link').hidden = expanded;
    if (myPredictions || (id && !expanded)) {
      const loadPicks = () => {
        try { picks = readPredictions(localStorage.getItem(picksKey)); } catch {}
      };
      loadPicks();
      window.addEventListener('storage', e => {
        if (e.key === picksKey || e.key === null) { loadPicks(); render(); }
      });
      window.addEventListener('pageshow', e => {
        if (e.persisted) { loadPicks(); render(); }
      });
    }
    if (myPredictions) {
      $('predictions-link').setAttribute('aria-current','page');
      $('back').hidden = false; $('title').hidden = false; $('title').textContent = 'My Predictions';
      document.title = `${demo ? 'Demo · ' : ''}My Predictions · Victoria Votes 2026`;
      if (!demo) json('data/candidates-2026.json').then(data => { nominations = data; render(); })
        .catch(() => { picksError = 'The nominations list could not be loaded. Candidate names from published results will still appear.'; render(); });
    }
    if (id) {
      if (expanded) document.body.classList.add('booths-expanded');
      $('back').hidden = false; $('title').hidden = false; $('title').textContent = expanded ? `${roster[id]} booth results` : roster[id];
      document.title = `${demo ? 'Demo · ' : ''}${$('title').textContent} · Victoria Votes 2026`;
      $('navigation').hidden = expanded;
    }
    if (statusPage) {
      $('back').hidden = false; $('title').hidden = false; $('title').textContent = 'Data status';
      $('status-link').setAttribute('aria-current','page');
      document.title = 'Data status · Victoria Votes 2026';
    }
    if (!myPredictions && !statusPage) json('data/historical-results.json')
      .then(data => { historicalResults = data; render(); }, () => {});
    const historyFiles = ['history-2022.json','tcp-2022.json','booth-comparisons.json'];
    if (demo) {
      const [{buildDemo,demoIndex},data,totals] = await Promise.all([import('./demo.js'),Promise.all(historyFiles.map(file => json(`data/${file}`))),json('data/district-totals-2022.json')]);
      [history,tcpHistory,comparisonHistory] = data;
      const scenario = buildDemo(history,tcpHistory,totals.pooled,totals.districts);
      snapshot = scenario.snapshot;
      boothData = scenario.details.get(id);
      districtBaseline = scenario.districtBaseline;
      demoTcpBaseline = scenario.districtTcpBaseline;
      pooledHistory = totals.pooled;
      $('official').textContent = 'Historical baseline ↗';
      $('official').href = demoIndex;
      render();
    } else {
      if (id && !expanded) json('data/sportsbet-odds-2026.json')
        .then(data => { sportsbetOdds = data; render(); }, () => {});
      if (id) Promise.all([...historyFiles,'district-totals-2022.json'].map(file => json(`data/${file}`).catch(() => undefined)))
        .then(data => { [history,tcpHistory,comparisonHistory] = data; pooledHistory = data[3]?.pooled; render(); });
      else if (!myPredictions && !statusPage) Promise.all(['district-totals-2022.json','tcp-2022.json','booth-comparisons.json'].map(file => json(`data/${file}`).catch(() => undefined)))
        .then(([totals,tcp,comparisons]) => { districtBaseline = totals?.districts; tcpHistory = tcp; comparisonHistory = comparisons; render(); });
      render();
      await refresh();
      setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
    }
  }
} catch { $('status').hidden = false; $('status-message').textContent = demo ? 'The demo could not be loaded. Try reloading this page.' : 'The district list could not be loaded. Try reloading this page.'; }
