import { boothComparisons, boothKey, districtTcpSwing, electorateSwing, majorParties, matchedSwing, matchedTcp, partyAbbreviation, partyCode, partyName, partySwing, partyVotes, race, share, statewide, sum } from './model.js';

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
const cell = (value, classes = '') => `<td class="num ${classes}">${/^[+−-]?0(?:\.0+)?(?:%| pp)?$/.test(value) ? `<span class="zero-value">${value}</span>` : value}</td>`;
const table = (labels, body, name, cls = '', textColumns = 1) => `<div class="scroll" tabindex="0" role="region" aria-label="${esc(name)}"><table class="${cls}" aria-label="${esc(name)}"><thead><tr>${labels.map((h,i) => `<th scope="col"${i >= textColumns ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
const empty = text => `<p class="empty muted">${text}</p>`;
const districtHref = id => `?district=${encodeURIComponent(id)}${demo ? '&demo=1' : ''}`;
const json = async url => {
  const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};
const params = new URLSearchParams(location.search);
const demo = params.get('demo') === '1';
const id = params.get('district');
const expanded = id !== null && params.get('view') === 'booths';
const boothFilters = new Map([['all','All booths and vote types'],['ordinary','Election day booths'],['declaration','Declaration votes'],['reported','With results']]);
let roster = {}, snapshot, boothData, history, tcpHistory, comparisonHistory, districtBaseline, demoTcpBaseline, pooledHistory, busy = false, invalid = false, dialogRefreshPending = false;
const views = { search: '', watched: false, sort: 'name', districtUnits: 'share', boothSearch: params.get('q') ?? '', boothSort: params.get('sort') === 'votes' ? 'votes' : 'name', boothUnits: ['votes','swing'].includes(params.get('units')) ? params.get('units') : 'share', districtParty: '', boothParty: params.get('party') ?? '' };
views.boothFilter = boothFilters.has(params.get('filter')) ? params.get('filter') : 'all';
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
const outcome = row => row?.elected ? '<span class="badge declared">Declared</span>' : !row?.fp.some(c => c.votes > 0) ? '<span class="meta">Awaiting count</span>' : row.twoStatus === 'withheld' ? '<span class="badge">TCP not published</span>' : race(row).tied ? '<span class="badge">TCP tied</span>' : race(row).leader ? '<span class="badge">TCP lead</span>' : '<span class="badge">Awaiting TCP</span>';
const signed = n => n > 0 ? 'positive' : n < 0 ? 'negative' : '';
const tint = label => `party-${partyCode(label)}`;
const bandCell = (label, value, extra = '') => cell(value, `${tint(label)} ${extra}`);
const priorVotes = key => Object.entries(districtBaseline?.[key] ?? {}).map(([party,votes]) => ({party,votes}));
const canCompare = row => snapshot?.status !== 'archive' && !row.stale && Object.hasOwn(districtBaseline ?? {}, row.id) && row.fp.some(c => c.votes > 0);
function matrix(name, fixed, group, columns, rows, sortKey, active, summary = '') {
  const groups = typeof group === 'string' ? [{label:group,count:columns.length}] : group;
  return `<div class="scroll matrix-scroll" tabindex="0" role="region" aria-label="${esc(name)}"><table class="matrix" aria-label="${esc(name)}"><thead><tr>${fixed.map((head,i) => `<th scope="col" rowspan="2"${i === 0 ? ' class="pinned"' : ''}>${head}</th>`).join('')}${groups.map(({label,count,tcp}) => `<th class="band-title${tcp ? ' tcp-band' : ''}" scope="colgroup" colspan="${count}">${esc(label)}</th>`).join('')}</tr><tr>${columns.map(({label,key,swing,tcp,display,candidate,edge}) => {
    const name = candidate ? `${label} (${candidate})` : label;
    const metric = tcp ? (swing ? ' TCP swing' : ' TCP') : (swing ? ' swing' : ' first preferences');
    const text = `${esc(display ?? partyAbbreviation(label))}${swing && !display ? ' Δ' : ''}${key && active === key ? ' ↓' : ''}`;
    return `<th scope="col" class="num ${label ? tint(label) : ''} ${swing ? 'swing-col' : ''} ${edge ?? ''}"${key && active === key ? ' aria-sort="descending"' : ''}>${key ? `<button type="button" data-${sortKey}="${esc(key)}" title="${esc(name + metric)}" aria-label="Sort by ${esc(name + metric)}">${text}</button>` : text}</th>`;
  }).join('')}</tr>${summary}</thead><tbody>${rows}</tbody></table></div>`;
}

function statewideView() {
  const results = snapshot?.results ?? [];
  const fresh = results.filter(row => !row.stale);
  const stats = statewide(fresh);
  const comparable = fresh.filter(canCompare);
  const swings = partySwing(partyVotes(comparable.flatMap(r => r.fp)), partyVotes(comparable.flatMap(r => priorVotes(r.id))));
  const bar = stats.list.filter(p => p.leading || p.declared).sort((a,b) => b.leading+b.declared-a.leading-a.declared).flatMap(p => {
    const party = ['Labor','Liberal','Nationals','Greens'].includes(p.label) ? p.label : 'Other';
    return [Array.from({length:p.declared}, () => `<span data-party="${party}"></span>`), Array.from({length:p.leading}, () => `<span data-party="${party}" data-leading="true"></span>`)].flat();
  });
  const nearest = fresh.filter(r => !r.elected).map(r => ({id:r.id, ...race(r)}))
    .filter(r => r.margin !== null).sort((a,b) => a.margin-b.margin).slice(0,6);
  return `<section id="statewide"><h1 class="section-head">Statewide overview</h1>
    <div class="stats">${[['Formal votes reported',stats.reporting ? num(stats.votes) : '—'],['Districts reporting',`${stats.reporting} / 88`],['Seats declared',`${stats.declared} / 88`]].map(([label,value]) => `<div class="stat"><small>${label}</small><strong>${value}</strong></div>`).join('')}</div>
    <div class="seatline" aria-hidden="true">${bar.join('')}${'<span></span>'.repeat(Math.max(0, 88-bar.length))}</div>
    <p class="seatnote meta"><span>${stats.leading} provisional TCP leads · ${stats.declared} declared</span><strong>45 seats for a majority</strong></p>
    <div class="grid"><div class="card"><h3>First preferences by party</h3>${stats.list.length ? table(['Party','Votes','Share','Swing','Leading','Declared'],stats.list.map(p => `<tr${majorParties.includes(p.label) ? ` class="${tint(p.label)}"` : ''}><th scope="row">${esc(p.label)}</th>${cell(num(p.votes))}${cell(pct(share(p.votes,stats.votes)))}${cell(delta(swings.get(p.label)),signed(swings.get(p.label)))}${cell(p.leading)}${cell(p.declared)}</tr>`).join(''),'Statewide votes by party', 'statewide-party-table') : empty('Party totals will appear when districts report.')}${swings.size ? `<p class="swing-baseline meta">Swing in percentage points vs ${demo ? 'the 2022 demo baseline' : `2022 across ${comparable.length} comparable ${comparable.length === 1 ? 'district' : 'districts'}`}.</p>` : ''}</div>
    <div class="card"><h3>Closest TCP races</h3>${nearest.length ? `<ul class="closest">${nearest.map(r => `<li${r.leader ? ` class="${tint(r.leader.party)}"` : ''}><div><a href="${districtHref(r.id)}">${esc(roster[r.id])}</a><small>${r.leader ? `${esc(r.leader.name)} · ${esc(partyAbbreviation(r.leader.party))}` : 'Tied'}</small></div><strong>${pct(r.margin)} (${num(r.marginVotes)} ${r.marginVotes === 1 ? 'vote' : 'votes'})</strong></li>`).join('')}</ul>` : empty('No provisional TCP margins available yet.')}</div></div></section>
    <section id="districts"><h2 class="section-head">District results</h2>
    <div class="tools"><input type="search" id="search" placeholder="Search districts" aria-label="Search districts" value="${esc(views.search)}"><label><input type="checkbox" id="watched" ${views.watched ? 'checked' : ''}> Watchlist only</label><select id="sort" aria-label="Sort districts"><option value="name">District A–Z</option><option value="close">Closest TCP</option><option value="votes">Most votes counted</option></select><select id="district-units" aria-label="District result display"><option value="share">Percentage</option><option value="votes">Votes</option><option value="swing">Swings</option></select></div><div class="card" id="district-list"></div></section>`;
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
  const score = key => active ? value(key,active) ?? -Infinity : views.sort === 'close' ? -(ranked.get(key)?.tcp.margin ?? Infinity) : views.sort === 'votes' ? ranked.get(key)?.formal ?? 0 : 0;
  list.sort(([a,an],[b,bn]) => (score(b) - score(a)) || an.localeCompare(bn));
  const format = swings ? delta : counts ? num : pct;
  const band = swings ? `First preference swing vs ${demo ? '2022 demo baseline' : '2022'}` : counts ? 'First preference votes' : 'First preference share';
  $('district-list').innerHTML = list.length ? matrix('District results', ['District','TCP Leader','TCP Share','TCP Swing','Formal votes'], band, parties.map(label => ({label,key:label,swing:swings})), list.map(([key,name]) => {
    const r = rows.get(key), data = ranked.get(key), lead = data?.tcp.leader;
    const tcpShare = data?.tcp.margin == null ? null : 50 + data.tcp.margin;
    const prior = demo ? demoTcpBaseline?.[key] : comparisonHistory?.districts?.[key]?.tcp ?? tcpHistory?.districts?.[key];
    const tcpSwing = snapshot?.status === 'archive' || r?.stale ? null : districtTcpSwing(r,prior,lead);
    const tcpTint = lead ? tint(lead.party) : '';
    return `<tr><td class="pinned">${star(key)} <a href="${districtHref(key)}">${esc(name)}</a>${r?.elected ? ' <span class="badge declared">Declared</span>' : ''}${r?.stale ? ' <small class="stale">Stale</small>' : ''}</td>${lead ? `<td class="${tcpTint}"><strong>${esc(titleCase(lead.party))}</strong></td>` : `<td>${data?.tcp.tied ? 'Tied' : '—'}</td>`}${cell(pct(tcpShare),tcpTint)}${cell(delta(tcpSwing),`${tcpTint} ${signed(tcpSwing)}`)}${cell(num(data?.formal || null))}${parties.map(p => { const n = value(key,p); return bandCell(p,format(n),swings ? `swing-col ${signed(n)}` : ''); }).join('')}</tr>`;
  }).join(''), 'district-party', views.districtParty) : empty(views.watched ? 'No watched districts match this filter.' : 'No districts match this search.');
}

function candidateTable(rows, name, showSwing = false, swingHeading = 'Swing (pp)', colour = false) {
  const total = sum(rows.map(r => r.votes));
  return rows.length ? table(['Candidate','Party','Votes','Share', ...(showSwing ? [swingHeading] : [])],[...rows].sort((a,b) => (b.votes ?? -1)-(a.votes ?? -1)).map(c => `<tr${colour && majorParties.includes(partyName(c.party)) ? ` class="${tint(c.party)}"` : ''}><td>${esc(c.name)}</td><td>${esc(titleCase(c.party))}</td>${cell(num(c.votes))}${cell(pct(share(c.votes,total)))}${showSwing ? cell(delta(c.swing),signed(c.swing)) : ''}</tr>`).join(''), name, colour ? 'party-row-table' : '', 2) : empty('No results published for this count yet.');
}

function districtView() {
  const d = snapshot?.results?.find(r => r.id === id);
  const available = boothData?.status === 'ok';
  const historical = snapshot?.status === 'archive';
  const hasRows = available && (boothData.booths.length || boothData.pooled?.length || boothData.tcp?.pooled?.length);
  const matched = !expanded && available && !historical && history && comparisonHistory ? electorateSwing(boothData.candidates, boothData.booths, history.districts[id], comparisonHistory.districts[id]) : null;
  const swingByParty = new Map(matched?.parties.map(p => [p.label,p.pp]));
  const fp = (d?.fp ?? []).map(c => ({...c,swing:swingByParty.get(partyName(c.party))}));
  const swingNote = historical ? '' : matched?.reported
    ? `Swing compares ${matched.matches.size} of ${matched.reported} reporting booths with their ${matched.year} counterparts${matched.coverage !== null ? ` (${pct(matched.coverage)} of reported booth votes)` : ''}. Votes and Share use the full district count.`
    : 'Matched swing appears when comparable booth results are available. Votes and Share use the full district count.';
  return `${expanded ? '' : `<section id="district-count"><div class="section-head"><h2>District count</h2><div class="count-status meta">${outcome(d)} ${star(id)}${d?.stale ? '<span class="stale">Previous district result</span>' : ''}${d?.source ? `<a href="${esc(d.source)}">VEC district results ↗</a>` : ''}</div></div>
  <div class="grid detail-grid"><div class="card"><h3>First preferences</h3>${candidateTable(fp, 'District first preferences', !historical, 'Matched swing (pp)')}${fp.length && swingNote ? empty(esc(swingNote)) : ''}</div><div class="card"><h3>Two-candidate-preferred</h3>${d?.twoStatus === 'withheld' ? empty('The VEC is not publishing a current TCP count.') : d?.twoStatus === 'replaced' ? empty('The VEC has replaced the TCP count with the preference distribution.') : candidateTable(d?.two ?? [], 'District two-candidate-preferred')}</div></div></section>`}
  <section id="booths">${expanded ? '' : `<div class="section-head"><h2>Booth results</h2><a id="booth-size" class="outline" href="${esc(boothHref(id,true))}">⤢ Maximise booth table</a></div>`}
    ${!expanded && boothData?.tcpPreview ? '<p class="notice warn">TCP swing preview: simulated TCP votes compared with the official 2022 booth count. First preferences are from the 2022 archive.</p>' : ''}
    <div class="tools">${expanded ? `<label for="booth-district">Electorate</label><select id="booth-district">${Object.entries(roster).sort(([,a],[,b]) => a.localeCompare(b)).map(([key,name]) => `<option value="${esc(key)}"${key === id ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select>` : ''}<input type="search" id="booth-search" placeholder="Search voting centres" aria-label="Search voting centres" value="${esc(views.boothSearch)}"><select id="booth-sort" aria-label="Sort voting centres"><option value="name">Booth A–Z</option><option value="votes">Most votes</option></select><select id="booth-units" aria-label="Booth vote display"><option value="share">Vote share (%)</option><option value="votes">Vote counts</option><option value="swing">Swing</option></select>${expanded ? `<label class="booth-filter">Show <select id="booth-filter">${[...boothFilters].map(([value,label]) => `<option value="${value}"${views.boothFilter === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>${historical ? `<span class="meta booth-preview">${boothData?.tcpPreview ? '2022 archive · Simulated TCP' : '2022 archive'}</span>` : ''}<div class="booth-actions"><a id="booth-size" class="outline" href="${esc(boothHref(id,false))}">↙ Back to district view</a></div>` : ''}</div>
    ${hasRows || (expanded && d?.fp.some(c => c.votes !== null)) ? '<div id="booth-list" class="card"></div><p id="booth-swing-note" class="meta" hidden></p>' : ''}
    ${hasRows ? `<p class="meta">${historical ? '' : `Swing is in percentage points against ${id === 'narracan' ? 'the 2023 supplementary election' : '2022'}. TCP requires the same two sides; ~ marks a nearby booth, spatial estimate or district proxy. `}${demo ? 'Demo counts use selected historical results.' : `${boothData.tcp?.status === 'withheld' ? 'The VEC is withholding TCP. ' : boothData.tcp?.status === 'unavailable' ? 'The TCP page could not be read. ' : !boothData.tcp?.booths?.length && !boothData.tcp?.pooled?.length ? 'No booth TCP available yet. ' : ''}Booth pages checked ${esc(time(boothData.at))} Melbourne time · <a href="${esc(boothData.source)}">VEC first preferences ↗</a>${boothData.tcp?.source ? ` · <a href="${esc(boothData.tcp.source)}">VEC TCP ↗</a>` : ''}`}</p>` : `<div class="card">${empty(demo ? 'No demo counts for this district. Try Bass, Gippsland East, Hawthorn, Melbourne, Northcote or Richmond.' : boothData?.status === 'unavailable' ? 'The voting-centre page could not be read. Try refreshing.' : 'No voting-centre rows available yet.')}</div>`}
  </section><dialog id="booth-dialog" aria-labelledby="venue-name"><div id="booth-result"></div><form method="dialog"><button class="outline">Close</button></form></dialog>`;
}

function comparisonsForBooths() {
  const archive = snapshot?.status === 'archive';
  return boothComparisons(boothData.booths, archive ? [] : history?.districts?.[id], !archive || boothData.tcpPreview ? tcpHistory?.districts?.[id] : null,
    archive ? {} : comparisonHistory?.districts?.[id], boothData.tcp);
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
  const priorTcp = archive ? null : extra?.tcp ?? tcpHistory?.districts?.[id];
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
    const swing = new Map(showPrimarySwing && baseline?.fpVotes ? matchedSwing(candidates,[b],[[b.kind,b.name,baseline.fpVotes]]).parties.map(p => [p.label,p.pp]) : []);
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
  const units = showCounts ? 'votes' : 'share (%)';
  const groups = [{label:`TCP · ${units}${showTcpSwing ? ' & swing (pp)' : ''}`,count:tcpColumns.length,tcp:true},{label:`First preferences · ${showPrimarySwing ? 'swing (pp)' : units}`,count:primaryColumns.length}];
  const renderRow = (b, isTotal = false) => `<tr${isTotal ? ' class="electorate-total"' : ''}><th scope="row" class="pinned">${isTotal ? 'Electorate total' : `<button class="venue" data-venue="${b.ref}">${esc(b.name)}</button>`}</th><td>${b.category}</td>${cell(num(b.total))}${!archive && showPrimarySwing ? `<td>${b.baseline?.fpMethod ? `${b.baseline.year} ${b.baseline.fpMethod.toLowerCase()}` : '—'}</td>` : ''}${columns.map(c => {
    const v = value(b,c);
    let display = c.swing ? delta(v) : showCounts ? num(v) : pct(v,false);
    if (c.tcp && c.swing && v !== null && !archive && b.tcp?.method && b.tcp.method !== 'Booth match') display += ` <abbr title="${b.baseline.year} ${esc(b.tcp.method.toLowerCase())}">~</abbr>`;
    return c.label ? bandCell(c.label,display,`${c.edge ?? ''} ${c.swing ? `swing-col ${signed(v)}` : ''}`) : cell(display,c.edge);
  }).join('')}</tr>`;
  let summaryRow = '';
  if (summary) {
    const matched = showPrimarySwing && !archive && booths.length && history && comparisonHistory ? electorateSwing(candidates, booths, history.districts[id], comparisonHistory.districts[id]) : null;
    const tcpVotes = pair.map(c => district.two?.find(r => r.name === c.name)?.votes ?? null);
    summaryRow = renderRow({category:district.stale ? 'Previous count' : 'District count',
      votes:partyVotes(district.fp), total:sum(district.fp.map(c => c.votes)), swing:new Map(matched?.parties.map(p => [p.label,p.pp])),
      baseline:matched?.parties.length ? {year:matched.year,fpMethod:'matched booths'} : null,
      tcp:district.twoStatus === 'reported' && tcpVotes.every(v => v !== null) ? tcpValues(tcpVotes) : null}, true);
  }
  const message = expanded && views.boothFilter !== 'all' ? 'No booths or vote categories match this filter.' : views.boothSearch.trim() ? 'No booths or vote categories match this search.' : 'No booth or vote-category results available yet.';
  $('booth-list').innerHTML = (list.length || summaryRow ? matrix('Voting-centre results',['Voting centre or vote type','Category', archive ? '2022 formal' : '2026 formal', ...(!archive && showPrimarySwing ? ['FP baseline'] : [])], groups, columns, list.map(b => renderRow(b)).join(''), 'booth-party', views.boothParty, summaryRow) : '') + (list.length ? '' : empty(message));
}

function render() {
  if (invalid) return;
  const active = document.activeElement;
  const focusId = active?.id;
  const focusStar = active?.dataset?.star;
  const oldScroll = $('content').querySelector('.matrix-scroll');
  if (id) {
    if ($('booth-dialog')?.open) { dialogRefreshPending = true; return; }
    const refreshButton = $('refresh');
    $('content').innerHTML = districtView();
    if (expanded) $('booth-size').before(refreshButton);
    boothList(); $('booth-sort').value = views.boothSort; $('booth-units').value = views.boothUnits;
  } else {
    $('content').innerHTML = statewideView(); $('sort').value = views.sort; $('district-units').value = views.districtUnits; districtList();
  }
  if (focusId && active && !document.contains(active)) $(focusId)?.focus({ preventScroll:true });
  if (focusStar) document.querySelector(`[data-star="${CSS.escape(focusStar)}"]`)?.focus({ preventScroll:true });
  if (oldScroll) $('content').querySelector('.matrix-scroll')?.scrollTo(oldScroll.scrollLeft, oldScroll.scrollTop);
}

async function refresh() {
  if (demo || busy || invalid) return;
  busy = true;
  $('refresh').disabled = true;
  let message, warning = false;
  try {
    snapshot = await json('api/results');
    if (snapshot.source) $('official').href = snapshot.source;
    if (id) boothData = await json(`api/results?district=${encodeURIComponent(id)}`).catch(() => ({status:'unavailable'}));
    const stamp = snapshot.at ? ` Last checked ${time(snapshot.at)} Melbourne time.` : '';
    switch (snapshot.status) {
      case 'archive': message = '2022 archive preview · six districts · not 2026 results.'; break;
      case 'waiting': message = 'Waiting for the VEC to publish 2026 results.' + stamp; break;
      case 'unverified': message = 'The VEC results page could not be verified yet.' + stamp; warning = true; break;
      case 'partial': message = `Partial snapshot · ${snapshot.loaded} of 88 district pages read. Older district rows are marked stale and excluded from statewide totals.` + stamp; warning = true; break;
      case 'stale': message = 'Showing the last available VEC snapshot. The count may have moved on.' + stamp; warning = true; break;
      default: message = 'VEC public results · automatically checks for updates.' + stamp;
    }
  } catch {
    if (snapshot && snapshot.status !== 'archive') snapshot = { ...snapshot, status:'stale' };
    boothData = { status:'unavailable' };
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
$('content').addEventListener('click', e => {
  const button = e.target.closest('button');
  if (button?.dataset.star) { toggle(button.dataset.star); render(); }
  for (const [data, key, redraw] of [['districtParty','districtParty',districtList],['boothParty','boothParty',boothList]]) {
    if (!button?.dataset[data]) continue;
    const value = button.dataset[data];
    const scroll = button.closest('.matrix-scroll');
    const { scrollLeft, scrollTop } = scroll;
    views[key] = views[key] === value ? '' : value;
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
    const swingByParty = pooled ? booth.swing : new Map(matches.parties.map(p => [p.label,p.pp]));
    const fpRows = booth.votes ? boothData.candidates.map((c,i) => ({...c,votes:booth.votes[i],swing:swingByParty.get(partyName(c.party))})) : [];
    const tcp = pooled ? booth.tcp : baseline?.tcp;
    const tcpRows = tcp ? boothData.tcp.pair.map((c,i) => ({...c,votes:tcp.votes[i],swing:tcp.swing[i]})) : [];
    const year = baseline?.year;
    const fpBaseline = pooled ? booth.baseline : matches.parties.length ? baseline : null;
    const tcpBaseline = pooled ? tcp?.swing.some(v => v !== null) && `${booth.year} same vote category` : tcp?.method && `${year} ${tcp.method.toLowerCase()}`;
    $('booth-result').innerHTML = `<h3 id="venue-name">${esc(booth.name)}</h3><h4>First preferences</h4>${candidateTable(fpRows, 'Booth first preferences', true, 'Swing (pp)', true)}${fpBaseline ? `<p class="meta">Baseline: ${fpBaseline.year} ${esc(fpBaseline.fpMethod.toLowerCase())}</p>` : ''}<h4>Two-candidate-preferred (TCP)</h4>${candidateTable(tcpRows, 'Booth TCP', true, 'Swing (pp)', true)}${tcpBaseline ? `<p class="meta">Baseline: ${esc(tcpBaseline)}</p>` : ''}`;
    $('booth-dialog').showModal();
  }
});
$('content').addEventListener('input', e => {
  if (e.target.id === 'search') { views.search = e.target.value; districtList(); }
  if (e.target.id === 'booth-search') { views.boothSearch = e.target.value; boothList(); }
});
$('content').addEventListener('change', e => {
  if (e.target.id === 'booth-district' && Object.hasOwn(roster,e.target.value)) location.assign(boothHref(e.target.value,true,false));
  if (e.target.id === 'watched') { views.watched = e.target.checked; districtList(); }
  if (e.target.id === 'sort') { views.sort = e.target.value; views.districtParty = ''; districtList(); }
  if (e.target.id === 'district-units') { views.districtUnits = e.target.value; districtList(); }
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
    if (id) {
      if (expanded) document.body.classList.add('booths-expanded');
      $('back').hidden = false; $('title').hidden = false; $('title').textContent = expanded ? `${roster[id]} booth results` : roster[id];
      document.title = `${demo ? 'Demo · ' : ''}${$('title').textContent} · Victoria Votes 2026`;
      $('navigation').hidden = expanded;
    }
    const historyFiles = ['history-2022.json','tcp-2022.json','booth-comparisons.json'];
    if (demo) {
      const [{buildDemo,demoIndex},data,totals] = await Promise.all([import('./demo.js'),Promise.all(historyFiles.map(file => json(`data/${file}`))),json('data/district-totals-2022.json')]);
      [history,tcpHistory,comparisonHistory] = data;
      const scenario = buildDemo(history,tcpHistory,totals.pooled);
      snapshot = scenario.snapshot;
      boothData = scenario.details.get(id);
      districtBaseline = scenario.districtBaseline;
      demoTcpBaseline = scenario.districtTcpBaseline;
      pooledHistory = totals.pooled;
      $('official').textContent = 'Historical baseline ↗';
      $('official').href = demoIndex;
      render();
    } else {
      if (id) Promise.all([...historyFiles,'district-totals-2022.json'].map(file => json(`data/${file}`).catch(() => undefined)))
        .then(data => { [history,tcpHistory,comparisonHistory] = data; pooledHistory = data[3]?.pooled; render(); });
      else Promise.all(['district-totals-2022.json','tcp-2022.json','booth-comparisons.json'].map(file => json(`data/${file}`).catch(() => undefined)))
        .then(([totals,tcp,comparisons]) => { districtBaseline = totals?.districts; tcpHistory = tcp; comparisonHistory = comparisons; render(); });
      render();
      await refresh();
      setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
    }
  }
} catch { $('status').hidden = false; $('status-message').textContent = demo ? 'The demo could not be loaded. Try reloading this page.' : 'The district list could not be loaded. Try reloading this page.'; }
