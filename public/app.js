import { boothComparisons, boothKey, electorateSwing, majorParties, matchedSwing, partyAbbreviation, partyCode, partyName, partyVotes, race, share, statewide, sum } from './model.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const num = n => n == null ? '—' : n.toLocaleString('en-AU');
const pct = (n, unit = true) => n == null ? '—' : `${n.toFixed(2)}${unit ? '%' : ''}`;
const delta = n => {
  if (n == null) return '—';
  const rounded = Number(n.toFixed(2));
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}`;
};
const pp = n => n == null ? '—' : `${delta(n)} pp`;
const time = n => n ? new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', dateStyle:'medium', timeStyle:'short' }).format(new Date(n)) : null;
const cell = (value, classes = '') => `<td class="num ${classes}">${/^[+−-]?0(?:\.0+)?(?:%| pp)?$/.test(value) ? `<span class="zero-value">${value}</span>` : value}</td>`;
const table = (labels, body, name, cls = '', textColumns = 1) => `<div class="scroll" tabindex="0" role="region" aria-label="${esc(name)}"><table class="${cls}" aria-label="${esc(name)}"><thead><tr>${labels.map((h,i) => `<th scope="col"${i >= textColumns ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
const empty = text => `<p class="empty muted">${text}</p>`;
const districtHref = id => `?district=${encodeURIComponent(id)}`;
const json = async url => {
  const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};
const params = new URLSearchParams(location.search);
const id = params.get('district');
const expanded = id !== null && params.get('view') === 'booths';
let roster = {}, snapshot, boothData, history, tcpHistory, comparisonHistory, busy = false, invalid = false, dialogRefreshPending = false;
const views = { search: '', watched: false, sort: 'name', boothSearch: params.get('q') ?? '', boothSort: params.get('sort') === 'votes' ? 'votes' : 'name', boothUnits: ['votes','swing'].includes(params.get('units')) ? params.get('units') : 'share', districtParty: '', boothParty: params.get('party') ?? '' };
function boothHref(district, full = expanded, keepParty = true) {
  const query = new URLSearchParams({ district });
  if (full) query.set('view','booths');
  if (views.boothSearch) query.set('q',views.boothSearch);
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
const watchKey = 'vic-votes-2026-watchlist';
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
const heading = (eyebrow, name, copy = '') => `<div class="section-head"><div><p class="eyebrow">${eyebrow}</p><h2>${name}</h2>${copy ? `<p class="muted">${copy}</p>` : ''}</div></div>`;
const signed = n => n > 0 ? 'positive' : n < 0 ? 'negative' : '';
const tint = label => `party-${partyCode(label)}`;
const bandCell = (label, value, extra = '') => cell(value, `${tint(label)} ${extra}`);
function matrix(name, fixed, group, columns, rows, sortKey, active) {
  const groups = typeof group === 'string' ? [{label:group,count:columns.length}] : group;
  return `<div class="scroll matrix-scroll" tabindex="0" role="region" aria-label="${esc(name)}"><table class="matrix" aria-label="${esc(name)}"><thead><tr>${fixed.map((head,i) => `<th scope="col" rowspan="2"${i === 0 ? ' class="pinned"' : ''}>${head}</th>`).join('')}${groups.map(({label,count,tcp}) => `<th class="band-title${tcp ? ' tcp-band' : ''}" scope="colgroup" colspan="${count}">${esc(label)}</th>`).join('')}</tr><tr>${columns.map(({label,key,swing,tcp,display,candidate,edge}) => {
    const name = candidate ? `${label} (${candidate})` : label;
    const metric = tcp ? (swing ? ' TCP swing' : ' TCP') : (swing ? ' swing' : ' first preferences');
    const text = `${esc(display ?? partyAbbreviation(label))}${swing && !display ? ' Δ' : ''}${key && active === key ? ' ↓' : ''}`;
    return `<th scope="col" class="num ${label ? tint(label) : ''} ${swing ? 'swing-col' : ''} ${edge ?? ''}"${key && active === key ? ' aria-sort="descending"' : ''}>${key ? `<button type="button" data-${sortKey}="${esc(key)}" title="${esc(name + metric)}" aria-label="Sort by ${esc(name + metric)}">${text}</button>` : text}</th>`;
  }).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function statewideView() {
  const results = snapshot?.results ?? [];
  const fresh = results.filter(row => !row.stale);
  const stats = statewide(fresh);
  const bar = stats.list.filter(p => p.leading || p.declared).sort((a,b) => b.leading+b.declared-a.leading-a.declared).flatMap(p => {
    const party = ['Labor','Liberal','Nationals','Greens'].includes(p.label) ? p.label : 'Other';
    return [Array.from({length:p.declared}, () => `<span data-party="${party}"></span>`), Array.from({length:p.leading}, () => `<span data-party="${party}" data-leading="true"></span>`)].flat();
  });
  const nearest = fresh.filter(r => !r.elected && race(r).gap !== null).sort((a,b) => race(a).gap-race(b).gap).slice(0,6);
  return `<section id="statewide">${heading('01 / THE STATE', 'Statewide overview')}
    <div class="stats">${[['Formal votes reported',stats.reporting ? num(stats.votes) : '—'],['Districts reporting',`${stats.reporting} / 88`],['Seats declared',`${stats.declared} / 88`]].map(([label,value]) => `<div class="stat"><small>${label}</small><strong>${value}</strong></div>`).join('')}</div>
    <div class="seatline" aria-hidden="true">${bar.join('')}${'<span></span>'.repeat(Math.max(0, 88-bar.length))}</div>
    <p class="seatnote meta"><span>${stats.leading} provisional TCP leads · ${stats.declared} declared</span><strong>45 seats for a majority</strong></p>
    <div class="grid"><div class="card"><h3>First preferences by party</h3>${stats.list.length ? table(['Party','Votes','Share','Leading','Declared'],stats.list.map(p => `<tr><td>${esc(p.label)}</td>${cell(num(p.votes))}${cell(pct(share(p.votes,stats.votes)))}${cell(p.leading)}${cell(p.declared)}</tr>`).join(''),'Statewide votes by party') : empty('Party totals will appear when districts report.')}</div>
    <div class="card"><h3>Closest TCP races</h3>${nearest.length ? `<ul class="closest">${nearest.map(r => `<li><div><a href="${districtHref(r.id)}">${esc(roster[r.id])}</a><small>${esc(race(r).leader?.name ?? 'Tied')}</small></div><strong>${pp(race(r).gap).replace(/^\+/, '')}</strong></li>`).join('')}</ul>` : empty('No provisional TCP margins available yet.')}</div></div></section>
    <section id="districts">${heading('02 / THE COUNT', 'District results', 'Search all 88 districts or save a watchlist on this device.')}
    <div class="tools"><input type="search" id="search" placeholder="Search districts" aria-label="Search districts" value="${esc(views.search)}"><label><input type="checkbox" id="watched" ${views.watched ? 'checked' : ''}> Watchlist only</label><select id="sort" aria-label="Sort districts"><option value="name">District A–Z</option><option value="close">Closest TCP</option><option value="votes">Most votes counted</option></select></div><div class="card" id="district-list"></div></section>`;
}

function districtList() {
  const rows = new Map(snapshot?.results?.map(r => [r.id, r]));
  const list = Object.entries(roster).filter(([key,name]) => (!views.watched || watched.has(key)) && name.toLowerCase().includes(views.search.trim().toLowerCase()));
  const parties = [...majorParties, 'Other'];
  const ranked = new Map([...rows].map(([key,row]) => [key, partyVotes(row.fp, undefined, true)]));
  const formal = key => sum([...(ranked.get(key)?.values() ?? [])]);
  const partyShare = (key, party) => share(ranked.get(key)?.get(party) ?? (party === 'Other' ? 0 : null), formal(key));
  list.sort(([a,an],[b,bn]) => (views.districtParty ? (partyShare(b,views.districtParty) ?? -1) - (partyShare(a,views.districtParty) ?? -1) : views.sort === 'close' ? (race(rows.get(a)).gap ?? 999) - (race(rows.get(b)).gap ?? 999) : views.sort === 'votes' ? formal(b)-formal(a) : 0) || an.localeCompare(bn));
  $('district-list').innerHTML = list.length ? matrix('District results', ['District','Status','TCP Leader','TCP gap (pp)','Formal votes'], 'First preference share', parties.map(label => ({label,key:label})), list.map(([key,name]) => {
    const r = rows.get(key), lead = r?.elected ?? race(r).leader;
    return `<tr><td class="pinned">${star(key)} <a href="${districtHref(key)}">${esc(name)}</a></td><td>${outcome(r)} ${r?.stale ? '<small class="stale">Stale</small>' : ''}</td>${lead ? `<td class="${tint(lead.party)}"><strong>${esc(titleCase(lead.party))}</strong></td>` : '<td>—</td>'}${cell(pct(race(r).gap,false))}${cell(num(formal(key) || null))}${parties.map(p => bandCell(p,pct(partyShare(key,p)))).join('')}</tr>`;
  }).join(''), 'district-party', views.districtParty) : empty(views.watched ? 'No watched districts match this filter.' : 'No districts match this search.');
}

function candidateTable(rows, name, showSwing = false, swingHeading = 'Swing (pp)') {
  const total = sum(rows.map(r => r.votes));
  return rows.length ? table(['Candidate','Party','Votes','Share', ...(showSwing ? [swingHeading] : [])],[...rows].sort((a,b) => (b.votes ?? -1)-(a.votes ?? -1)).map(c => `<tr><td>${esc(c.name)}</td><td>${esc(titleCase(c.party))}</td>${cell(num(c.votes))}${cell(pct(share(c.votes,total)))}${showSwing ? cell(delta(c.swing),signed(c.swing)) : ''}</tr>`).join(''), name, '', 2) : empty('No results published for this count yet.');
}

function districtView() {
  const d = snapshot?.results?.find(r => r.id === id);
  const available = boothData?.status === 'ok';
  const historical = snapshot?.status === 'archive';
  const matched = !expanded && available && !historical && history && comparisonHistory ? electorateSwing(boothData.candidates, boothData.booths, history.districts[id], comparisonHistory.districts[id]) : null;
  const swingByParty = new Map(matched?.parties.map(p => [p.label,p.pp]));
  const fp = (d?.fp ?? []).map(c => ({...c,swing:swingByParty.get(partyName(c.party))}));
  const swingNote = historical ? '' : matched?.reported
    ? `Swing compares ${matched.matches.size} of ${matched.reported} reporting booths with their ${matched.year} counterparts${matched.coverage !== null ? ` (${pct(matched.coverage)} of reported booth votes)` : ''}. Votes and Share use the full district count.`
    : 'Matched swing appears when comparable booth results are available. Votes and Share use the full district count.';
  return `${expanded ? '' : `<section id="district-count">${heading('01 / DISTRICT TOTALS','The district count', `${outcome(d)} ${star(id)}${d?.stale ? ' <span class="stale">Previous district result</span>' : ''}${d?.source ? ` · <a href="${esc(d.source)}">VEC district results ↗</a>` : ''}`)}
  <div class="grid detail-grid"><div class="card"><h3>First preferences</h3>${candidateTable(fp, 'District first preferences', !historical, 'Matched swing (pp)')}${fp.length && swingNote ? empty(esc(swingNote)) : ''}</div><div class="card"><h3>Two-candidate-preferred</h3>${d?.twoStatus === 'withheld' ? empty('The VEC is not publishing a current TCP count.') : d?.twoStatus === 'replaced' ? empty('The VEC has replaced the TCP count with the preference distribution.') : candidateTable(d?.two ?? [], 'District two-candidate-preferred')}</div></div></section>`}
  <section id="booths">${expanded ? '' : `<div class="booth-heading">${heading('02 / VOTING CENTRES','Booth results','First preferences and two-candidate-preferred (TCP) results by voting centre.')}<a id="booth-size" class="outline" href="${esc(boothHref(id,true))}">⤢ Maximise booth table</a></div>`}
    ${!expanded && boothData?.tcpPreview ? '<p class="notice warn">TCP swing preview: simulated TCP votes compared with the official 2022 booth count. First preferences are from the 2022 archive.</p>' : ''}
    <div class="tools">${expanded ? `<label for="booth-district">Electorate</label><select id="booth-district">${Object.entries(roster).sort(([,a],[,b]) => a.localeCompare(b)).map(([key,name]) => `<option value="${esc(key)}"${key === id ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select>` : ''}<input type="search" id="booth-search" placeholder="Search voting centres" aria-label="Search voting centres" value="${esc(views.boothSearch)}"><select id="booth-sort" aria-label="Sort voting centres"><option value="name">Booth A–Z</option><option value="votes">Most votes</option></select><select id="booth-units" aria-label="Booth vote display"><option value="share">Vote share (%)</option><option value="votes">Vote counts</option><option value="swing">Swing</option></select>${expanded ? `${historical ? `<span class="meta booth-preview">${boothData?.tcpPreview ? '2022 archive · Simulated TCP' : '2022 archive'}</span>` : ''}<div class="booth-actions"><a id="booth-size" class="outline" href="${esc(boothHref(id,false))}">↙ Back to district view</a></div>` : ''}</div>
    ${available && boothData.booths.length ? `<div id="booth-list" class="card"></div><p id="booth-swing-note" class="meta" hidden></p><p class="meta">${historical ? '' : `Swing is in percentage points against ${id === 'narracan' ? 'the 2023 supplementary election' : '2022'}. TCP requires the same two sides; ~ marks a nearby booth, spatial estimate or district proxy. `} ${boothData.tcp?.status === 'withheld' ? 'The VEC is withholding TCP. ' : boothData.tcp?.status === 'unavailable' ? 'The TCP page could not be read. ' : !boothData.tcp?.booths?.length ? 'No booth TCP available yet. ' : ''}Booth pages checked ${esc(time(boothData.at))} Melbourne time · <a href="${esc(boothData.source)}">VEC first preferences ↗</a>${boothData.tcp?.source ? ` · <a href="${esc(boothData.tcp.source)}">VEC TCP ↗</a>` : ''}</p>` : `<div class="card">${empty(boothData?.status === 'unavailable' ? 'The voting-centre page could not be read. Try refreshing.' : 'No voting-centre rows available yet.')}</div>`}
  </section><dialog id="booth-dialog" aria-labelledby="venue-name"><div id="booth-result"></div><form method="dialog"><button class="outline">Close</button></form></dialog>`;
}

function comparisonsForBooths() {
  const archive = snapshot?.status === 'archive';
  return boothComparisons(boothData.booths, archive ? [] : history?.districts?.[id], !archive || boothData.tcpPreview ? tcpHistory?.districts?.[id] : null,
    archive ? {} : comparisonHistory?.districts?.[id], boothData.tcp);
}

function boothList() {
  syncBoothLink();
  if (!$('booth-list')) return;
  const { candidates, booths } = boothData;
  const archive = snapshot?.status === 'archive';
  const showPrimarySwing = views.boothUnits === 'swing';
  const showCounts = views.boothUnits === 'votes';
  const showTcpSwing = !archive || boothData.tcpPreview;
  const comparisons = comparisonsForBooths();
  const note = $('booth-swing-note');
  note.hidden = !showPrimarySwing;
  const reporting = booths.filter(b => sum(b.votes) > 0);
  const withBaseline = reporting.filter(b => comparisons.get(boothKey(b))?.fpVotes).length;
  note.textContent = archive ? 'First-preference swing needs 2026 booth results.' :
    `Historical comparison available for ${withBaseline} of ${reporting.length} reporting booths. A district proxy compares with the historical district’s booths of the same voting type. A dash means no comparable result.`;
  const tcp = boothData.tcp;
  const labels = [...new Set(candidates.map(c => partyName(c.party)))];
  const parties = [...majorParties.filter(p => labels.includes(p)), ...labels.filter(p => !majorParties.includes(p)).sort()];
  const primaryColumns = parties.map(label => ({label,key:`fp:${label}`,swing:showPrimarySwing}));
  const pair = tcp?.status === 'ok' ? tcp.pair : [];
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
    return { ...b, i, total, baseline, votes, swing, tcp:baseline?.tcp };
  }).filter(b => b.name.toLowerCase().includes(views.boothSearch.trim().toLowerCase()));
  const value = (b, column) => column.tcp ? b.tcp?.[column.swing ? 'swing' : showCounts ? 'votes' : 'shares'][column.side] ?? null : column.swing ? b.swing.get(column.label) ?? null : b.total ? showCounts ? b.votes.get(column.label) ?? 0 : share(b.votes.get(column.label) ?? 0,b.total) : null;
  const selected = columns.find(c => c.key === views.boothParty);
  list.sort((a,b) => (selected ? (value(b,selected) ?? -Infinity) - (value(a,selected) ?? -Infinity) : views.boothSort === 'votes' ? b.total-a.total : 0) || a.name.localeCompare(b.name));
  const units = showCounts ? 'votes' : 'share (%)';
  const groups = [{label:`TCP · ${units}${showTcpSwing ? ' & swing (pp)' : ''}`,count:tcpColumns.length,tcp:true},{label:`First preferences · ${showPrimarySwing ? 'swing (pp)' : units}`,count:primaryColumns.length}];
  $('booth-list').innerHTML = list.length ? matrix('Voting-centre results',['Voting centre','Category', archive ? '2022 formal' : '2026 formal', ...(!archive && showPrimarySwing ? ['FP baseline'] : [])], groups, columns, list.map(b => `<tr><td class="pinned"><button class="venue" data-venue="${b.i}">${esc(b.name)}</button></td><td>${b.kind === 'early' ? 'Early voting' : 'Election day'}</td>${cell(num(b.total || null))}${!archive && showPrimarySwing ? `<td>${b.baseline?.fpMethod ? `${b.baseline.year} ${b.baseline.fpMethod.toLowerCase()}` : '—'}</td>` : ''}${columns.map(c => {
    const v = value(b,c);
    let display = c.swing ? delta(v) : showCounts ? num(v) : pct(v,false);
    if (c.tcp && c.swing && v !== null && !archive && b.tcp?.method && b.tcp.method !== 'Booth match') display += ` <abbr title="${b.baseline.year} ${esc(b.tcp.method.toLowerCase())}">~</abbr>`;
    return c.label ? bandCell(c.label,display,`${c.edge ?? ''} ${c.swing ? `swing-col ${signed(v)}` : ''}`) : cell(display,c.edge);
  }).join('')}</tr>`).join(''), 'booth-party', views.boothParty) : empty('No voting centres match this search.');
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
    $('content').innerHTML = statewideView(); $('sort').value = views.sort; districtList();
  }
  if (focusId && active && !document.contains(active)) $(focusId)?.focus({ preventScroll:true });
  if (focusStar) document.querySelector(`[data-star="${CSS.escape(focusStar)}"]`)?.focus({ preventScroll:true });
  if (oldScroll) $('content').querySelector('.matrix-scroll')?.scrollTo(oldScroll.scrollLeft, oldScroll.scrollTop);
}

async function refresh() {
  if (busy || invalid) return;
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
    $('status').textContent = message;
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
    const booth = boothData.booths[Number(button.dataset.venue)];
    const baseline = comparisonsForBooths().get(boothKey(booth));
    const matches = matchedSwing(boothData.candidates,[booth],baseline?.fpVotes ? [[booth.kind,booth.name,baseline.fpVotes]] : []);
    const swingByParty = new Map(matches.parties.map(p => [p.label,p.pp]));
    const fpRows = boothData.candidates.map((c,i) => ({...c,votes:booth.votes[i],swing:swingByParty.get(partyName(c.party))}));
    const tcp = baseline?.tcp;
    const tcpRows = tcp ? boothData.tcp.pair.map((c,i) => ({...c,votes:tcp.votes[i],swing:tcp.swing[i]})) : [];
    const year = baseline?.year;
    $('booth-result').innerHTML = `<h3 id="venue-name">${esc(booth.name)}</h3><h4>First preferences</h4>${candidateTable(fpRows, 'Booth first preferences', true)}${matches.parties.length ? `<p class="meta">Baseline: ${year} ${esc(baseline.fpMethod.toLowerCase())}</p>` : ''}<h4>Two-candidate-preferred (TCP)</h4>${candidateTable(tcpRows, 'Booth TCP', true)}${tcp?.method ? `<p class="meta">Baseline: ${year} ${esc(tcp.method.toLowerCase())}</p>` : ''}`;
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
  if (e.target.id === 'booth-sort') { views.boothSort = e.target.value; views.boothParty = ''; boothList(); }
  if (e.target.id === 'booth-units') { views.boothUnits = e.target.value; boothList(); }
});
$('content').addEventListener('close', e => { if (e.target.id === 'booth-dialog' && dialogRefreshPending) { dialogRefreshPending = false; render(); } }, true);

try {
  roster = await json('data/districts.json');
  if (id !== null && !Object.hasOwn(roster, id)) {
    invalid = true; $('status').textContent = 'Unknown district.'; $('back').hidden = false; $('refresh').hidden = true;
  } else {
    if (id) {
      if (expanded) document.body.classList.add('booths-expanded');
      $('back').hidden = false; $('title').textContent = roster[id]; document.title = `${roster[id]} · Victoria Votes 2026`;
      $('kicker').textContent = 'LEGISLATIVE ASSEMBLY · DISTRICT RESULTS';
      $('subtitle').textContent = 'District totals, local voting centres and booth-matched swing.';
      $('navigation').innerHTML = '<a href="#district-count">District count</a><a href="#booths">Voting centres</a>';
      if (expanded) {
        $('title').textContent = `${roster[id]} booth results`;
        $('subtitle').hidden = true;
        $('navigation').hidden = true;
      }
      Promise.all(['history-2022.json','tcp-2022.json','booth-comparisons.json'].map(file => json(`data/${file}`).catch(() => undefined)))
        .then(data => { [history,tcpHistory,comparisonHistory] = data; render(); });
    }
    render();
    await refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
  }
} catch { $('status').textContent = 'The district list could not be loaded. Try reloading this page.'; }
