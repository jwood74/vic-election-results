import assert from 'node:assert/strict';
import test from 'node:test';
import { districts, districtLinks, EXPECTED, collect, parseBooths, parseDistrict, parseFinalResult, parseTcpBooths } from '../lib/vec.mjs';
import { boothComparisons, boothMatchedTcpSwing, districtTcpSwing, electorateSwing, finalTcp, historicalBoothTcp, matchedSwing, matchedTcp, partyAbbreviation, partySwing, partyVotes, race, statewide } from '../public/model.js';
import historical from '../public/data/historical-results.json' with { type:'json' };
import archiveTcp from '../public/data/tcp-2022.json' with { type:'json' };
import { api } from '../lib/api.mjs';

const bass = `${EXPECTED}/results-by-district/bass-district-results`;
const evelyn = `${EXPECTED}/results-by-district/evelyn-district-results`;
const link = url => `<a href="${url}">District</a>`;
const index = `<main>${link(bass)}${link(bass)}${link(evelyn)}${link(bass.replace('www.vec.vic.gov.au', 'invalid.example'))}</main>`;
const resultTable = (title, voteA, voteB) => `<table><thead><tr><th>Candidate</th><th>Party</th><th>${title}</th><th>% votes</th></tr></thead><tbody><tr><td>ONE, A</td><td>Australian Labor Party - Victorian Branch</td><td>${voteA}</td><td></td></tr><tr><td>TWO, B</td><td>Liberal</td><td>${voteB}</td><td></td></tr></tbody></table>`;
const page = (two, elected = '') => `<main><h1>Bass District results</h1>${elected}${resultTable('1st pref. votes',900,'1,000')}<div><h3>Two candidate preferred results</h3>${two}</div><a id="FPVResultsLink" href="${bass}/by-voting-centre">Recheck results by voting centre</a></main>`;

test('2CP leads, withheld data, zero counts and declarations stay distinct', () => {
  const live = parseDistrict(page(resultTable('2CP votes',550,450)), bass);
  assert.equal(race(live).leader.name, 'ONE, A');
  assert.equal(race(live).gap, 10);
  assert.equal(race(live).margin, 5);
  assert.equal(race(live).marginVotes, 50);
  const odd = race(parseDistrict(page(resultTable('2CP votes',501,500)), bass));
  assert.equal(odd.marginVotes, 1);
  assert.equal(race(parseDistrict(page(resultTable('2CP votes',50,50)), bass)).marginVotes, 0);
  assert.equal(statewide([live]).list[0].label, 'Liberal'); // first-preference leader is different
  const hidden = parseDistrict(page(`Results withheld ${resultTable('2CP votes',550,450)}`), bass);
  assert.equal(hidden.twoStatus, 'withheld');
  assert.equal(race(hidden).leader, null);
  assert.equal(race(parseDistrict(page(resultTable('2CP votes',0,0)), bass)).gap, null);
  assert.equal(race(parseDistrict(page(resultTable('2CP votes',50,50)), bass)).tied, true);
  const declared = parseDistrict(page('', '<h3>Elected member</h3><p><strong>ONE, A</strong></p>'), bass);
  assert.equal(statewide([declared]).declared, 1);
  assert.equal(statewide([declared]).leading, 0);
});

test('captures the official close-of-roll enrolment and keeps blanks distinct from zero', () => {
  const enrolled = page('').replace('</main>', '<p class="list-item-title">Total enrolment as at close of rolls:</p><p class="list-item-body">49,984</p></main>');
  assert.equal(parseDistrict(enrolled,bass).enrolled,49984);
  assert.equal(parseDistrict(enrolled.replace('49,984','—'),bass).enrolled,null);
});

test('district update time survives refreshes and advances when a tally changes', async () => {
  const first = '2026-11-28T07:05:00.000Z';
  const second = '2026-11-28T07:06:00.000Z';
  let votes = 500;
  const get = async url => url === EXPECTED ? index : url === bass
    ? page(resultTable('2CP votes',votes,450)) : url === evelyn
      ? page('').replace(resultTable('1st pref. votes',900,'1,000'),resultTable('1st pref. votes',0,0)) : null;
  const initial = await collect(undefined,get,() => first);
  const refreshed = await collect(initial,get,() => second);
  assert.deepEqual(refreshed.results.map(r => [r.id,r.updatedAt]),[['bass',first],['evelyn',null]]);
  votes++;
  const changed = await collect(refreshed,get,() => second);
  assert.equal(changed.results.find(r => r.id === 'bass').updatedAt,second);
});

test('booth results survive source failure and a cold start, then recover', async () => {
  const row = {id:'bass',twoStatus:'reported',two:[{name:'A'},{name:'B'}]};
  const oldTcp = {status:'ok',pair:row.two,booths:[{votes:[55,45]}]};
  let cached, fail = false, tcp = oldTcp;
  const opts = {
    readBooths: async () => cached,
    saveBooths: async (_, detail) => { cached = detail; },
    fetchBooths: async () => {
      if (fail) throw new Error('Temporary VEC failure');
      return {status:'ok',at:'2026-11-28T07:00:00Z',booths:[{votes:[50,40]}],tcp};
    },
  };
  const request = new Request('https://example.test/api/results?district=bass');
  const create = () => api(async () => ({status:'ok',results:[row]}),opts);
  assert.equal((await (await create()(request)).json()).status,'ok');
  const cold = create();
  fail = true;
  const stale = await (await cold(request)).json();
  assert.equal(stale.stale,true);
  assert.deepEqual(stale.booths,cached.booths);
  fail = false;
  tcp = {status:'unavailable'};
  assert.equal((await (await cold(request)).json()).tcp.stale,true);
  tcp = {status:'withheld'};
  assert.deepEqual((await (await cold(request)).json()).tcp,{status:'withheld'});
  tcp = oldTcp;
  const fresh = await (await cold(request)).json();
  assert.equal(fresh.stale,undefined);
  assert.deepEqual(fresh.tcp,oldTcp);
});

test('reads mixed-case live links, party-first TCP, and single-row booth headings', () => {
  const source = `${EXPECTED}/results-by-district/Caulfield-District-results`;
  assert.equal(districtLinks(`<main>${link(source)}</main>`,EXPECTED).get('caulfield'),source);
  const html = `<main><h1>Caulfield District results</h1><h3>Successful candidate</h3><p>The successful candidate's name will display here.</p>
    <p class="list-item-title">Total enrolled voters:</p><p class="list-item-body">51,087</p>
    ${resultTable('1st pref. votes',510,480).replace('ONE, A','ONE, A-B')}
    <div><h3>Two candidate preferred results</h3><table><thead><tr><th>Party</th><th>Candidate</th><th>Preferred votes</th><th>% preferred votes</th></tr></thead>
    <tbody><tr><td>Australian Labor Party</td><td>ONE, A-B</td><td>520</td><td>52.0%</td></tr><tr><td>Liberal</td><td>TWO, B</td><td>480</td><td>48.0%</td></tr></tbody></table></div>
    <a href="${source}/Caulfield-District-results-by-voting-centre">Latest results by voting centre</a></main>`;
  const district = parseDistrict(html,source);
  assert.equal(district.enrolled,51087);
  assert.equal(district.elected,null);
  assert.equal(district.twoStatus,'reported');
  assert.deepEqual(district.two.map(c => [c.name,c.votes]),[['ONE, A-B',520],['TWO, B',480]]);
  assert.ok(district.boothUrl.endsWith('/Caulfield-District-results-by-voting-centre'));
  const venuePage = (labels, counts) => `<main><table><thead><tr><th><a></a></th><th><a>ONE, A</a><div>Labor</div></th><th><a>TWO, B</a><div>Incorrect party metadata</div></th>${labels.map(label => `<th><a>${label}</a></th>`).join('')}</tr></thead><tbody><tr><th>Ordinary votes</th></tr><tr><th>Alma</th>${counts.map(n => `<td>${n}</td>`).join('')}</tr></tbody></table></main>`;
  const fp = parseBooths(venuePage(['Informal votes','Total votes polled'],[10,20,1,31]),district.fp);
  assert.deepEqual(fp.booths,[{name:'Alma',kind:'ordinary',votes:[10,20]}]);
  const tcp = parseTcpBooths(venuePage(['Miss-sorts','Informal votes','Total votes polled'],[12,18,2,1,33]),district,fp.booths);
  assert.deepEqual(tcp.pair.map(c => c.party),district.fp.map(c => c.party));
  assert.deepEqual(tcp.booths,[{name:'Alma',kind:'ordinary',votes:[12,18]}]);
});

test('final preference distribution takes precedence over a conflicting indicative TCP', () => {
  const elected = '<h3>Elected member</h3><p><strong>ONE, A</strong></p>';
  const html = page(resultTable('Preferred votes',495,505), elected + resultTable('Votes after distribution',510,490));
  assert.deepEqual(finalTcp(parseFinalResult(html)).districtTotal,[510,490]);
  assert.equal(finalTcp(parseFinalResult(page(resultTable('Preferred votes',510,490),elected))),null);
});

test('Pakenham uses the declared Labor district result and the same-pair indicative booth baseline', () => {
  assert.deepEqual(Object.keys(historical).sort(),Object.keys(districts).sort());
  const result = historical.pakenham;
  assert.equal(result.winner.name,'VULIN, Emma');
  assert.deepEqual(finalTcp(result).districtTotal,[19587,19280]);
  const two = [{name:'Current Labor',party:'Labor',votes:500},{name:'Current Liberal',party:'Liberal',votes:500}];
  assert.equal(districtTcpSwing({two,twoStatus:'reported'},finalTcp(result),two[0]).toFixed(2),'-0.39');
  const booth = {name:'Pakenham Central',kind:'ordinary',votes:[520,480]};
  const baseline = historicalBoothTcp(result,archiveTcp.districts.pakenham);
  assert.equal(matchedTcp({status:'ok',pair:two,booths:[booth]},baseline).get('ordinary:pakenham central').swing[0].toFixed(2),'1.52');
  for (const id of ['shepparton','hawthorn','kew']) {
    assert.equal(historicalBoothTcp(historical[id],archiveTcp.districts[id]),null,id);
  }
  assert.equal(historicalBoothTcp(historical.bass,archiveTcp.districts.bass),archiveTcp.districts.bass);
});

test('party swing uses share of formal votes and compares parties entering or leaving the race', () => {
  const previous = partyVotes([{party:'Australian Labor Party',votes:40},{party:'Liberal',votes:60}]);
  const current = partyVotes([{party:'Labor',votes:100},{party:'Greens',votes:100}]);
  assert.deepEqual([...partySwing(current,previous)], [['Labor',10],['Greens',50],['Liberal',-60]]);
  assert.equal(partySwing(current,new Map()).size, 0);
});

test('booth-matched TCP swing uses comparable published booth totals in district pair order', () => {
  const labor = {name:'Current Labor',party:'Labor'}, liberal = {name:'Current Liberal',party:'Liberal'};
  const row = {twoStatus:'reported',two:[labor,liberal]};
  const booth = (name, votes, kind = 'ordinary') => ({name,votes,kind});
  const current = {status:'ok',pair:[liberal,labor],booths:[booth('Small',[20,80]),booth('Large',[550,350]),
    booth('Moved',[1,999]),booth('Unmatched',[999,1]),booth('Duplicate',[1,999]),booth('Duplicate',[1,999]),
    booth('Incomplete',[null,999]),booth('Postal',[1,999],'postal')]};
  const historical = {pair:[{name:'Prior Labor',party:'Labor'},liberal],booths:[booth('Small',[60,40]),booth('Large',[340,560]),
    booth('Moved',[999,1]),booth('Duplicate',[999,1]),booth('Incomplete',[999,1]),booth('Postal',[999,1],'postal')]};
  assert.deepEqual(boothMatchedTcpSwing(row,current,historical,['moved']),{matched:2,swing:[3,-3]});
  assert.equal(boothMatchedTcpSwing(row,current,{...historical,pair:[labor,{name:'Prior Green',party:'Greens'}]}),null);
  assert.equal(boothMatchedTcpSwing({...row,twoStatus:'withheld'},current,historical),null);
});

test('district TCP swing follows the current leader across a reversal in the historical pair', () => {
  const row = parseDistrict(page(resultTable('2CP votes',550,450)), bass);
  const leader = race(row).leader;
  const prior = {pair:[{party:'Liberal'},{party:'Labor'}],districtTotal:[60,40]};
  assert.equal(districtTcpSwing(row,prior,leader), 15);
  assert.equal(districtTcpSwing(row,{...prior,pair:[{party:'Greens'},{party:'Labor'}]},leader), null);
  assert.equal(districtTcpSwing({...row,twoStatus:'withheld'},prior,leader), null);
});

test('uses only linked known districts and keeps a marked stale previous row after a failed read', async () => {
  assert.equal(Object.keys(districts).length, 88);
  assert.deepEqual([...districtLinks(index, EXPECTED)], [['bass',bass],['evelyn',evelyn]]);
  const previous = { results: [{ id:'evelyn', ...parseDistrict(page(''), evelyn) }] };
  const got = await collect(previous, async url => url === EXPECTED ? index : url === bass ? page('') : null);
  assert.equal(got.status, 'partial');
  assert.equal(got.loaded, 1);
  assert.equal(got.results.find(r => r.id === 'evelyn').stale, true);
});

test('collector publishes a compact projection alongside district totals', async () => {
  const district = page(resultTable('2CP votes',900,1000)).replace('</main>', `<a id="TwoCPLink" href="${bass}/tcp">TCP</a></main>`);
  const cells = (name,values) => `<tr><td>${name}</td>${values.map(v => `<td>${v}</td>`).join('')}</tr>`;
  const table = (labels,values) => `<main><table><thead><tr><th></th><th>ONE, A</th><th>TWO, B</th><th></th><th></th></tr><tr><th>Ordinary votes</th><th></th><th></th><th>${labels}</th><th>Total votes polled</th></tr></thead><tbody>${cells('Ordinary votes',[])}${cells('Bass',values)}</tbody></table></main>`;
  const pages = new Map([[EXPECTED,`<main>${link(bass)}</main>`],[bass,district],
    [`${bass}/by-voting-centre`,table('Informal votes',[900,1000,0,1900])],[`${bass}/tcp`,table('Mis-sorts',[900,1000,0,1900])]]);
  const snapshot = await collect(null,async url => pages.get(url) ?? null);
  assert.equal(snapshot.results[0].projection.tcpCount,1900);
  assert.equal(snapshot.results[0].projection.matchedTcp,1);
  assert.equal(snapshot.results[0].projection.confidence,'Uncertain');
});

test('booth parser joins by candidate name and separates early and ordinary venues', () => {
  const { fp } = parseDistrict(page(''), bass);
  const line = (n, values) => `<tr><td>${n}</td>${values.map(v=>`<td>${v}</td>`).join('')}</tr>`;
  const html = `<main><table><thead><tr><th></th><th>TWO, B</th><th>ONE, A</th><th></th><th></th></tr><tr><th></th><th>Liberal</th><th>Labor</th><th>Informal votes</th><th>Total votes polled</th></tr></thead><tbody>
  ${line('Ordinary votes',[])}${line('Bass',[12,105,2,119])}${line('Ordinary votes total',[12,105,2,119])}${line('Early votes',[])}${line('Bass',[30,25,2,57])}${line('Other Early Votes',[77,11,2,90])}${line('Declaration votes',[])}${line('Postal votes',[33,33,2,68])}</tbody></table></main>`;
  const parsed = parseBooths(html, fp);
  assert.equal(parsed.candidates[0].party, 'Liberal');
  assert.deepEqual(parsed.booths, [{name:'Bass',kind:'ordinary',votes:[12,105]}, {name:'Bass',kind:'early',votes:[30,25]}]);
  assert.deepEqual(parsed.pooled, [{kind:'other-early',name:'Other prepoll votes',votes:[77,11]}, {kind:'postal',name:'Postal votes',votes:[33,33]}]);
  const pooledOnly = html.replace(line('Bass',[30,25,2,57]), '').replace(line('Declaration votes',[]), line('Early votes total',[77,11,2,90]) + line('Declaration votes',[])).replace('</tbody>',line('Declaration votes total',[33,33,2,68]) + '</tbody>');
  assert.deepEqual(parseBooths(pooledOnly,fp).pooled.map(b => b.kind), ['early-total','postal']);
  assert.throws(() => parseBooths(html.replace('119','120'), fp), /Invalid booth totals/);
  const pending = html.replace(line('Bass',[12,105,2,119]),line('Bass',['—','','','']));
  assert.deepEqual(parseBooths(pending,fp).booths[0].votes,[null,null]);
});

test('matched swing uses vote-weighted shares and excludes unmatched and ambiguous venues', () => {
  const candidates = [{party:'Labor'},{party:'Liberal'},{party:'Independent'}];
  const booths = [
    {kind:'ordinary',name:'Bass',votes:[30,50,20]}, {kind:'ordinary',name:'Cowes',votes:[150,40,10]},
    {kind:'early',name:'Bass',votes:[1000,5,0]}, {kind:'ordinary',name:'Duplicate',votes:[20,5,0]},
    {kind:'ordinary',name:'Duplicate',votes:[10,5,0]}, {kind:'ordinary',name:'Empty',votes:[0,0,0]},
  ];
  const baseline = [['ordinary','bass',{'Australian Labor Party - Victorian Branch':10,Liberal:90}],['ordinary','Cowes',{Labor:110,Liberal:90}],['ordinary','Duplicate',{Labor:10,Liberal:10}]];
  const result = matchedSwing(candidates, booths, baseline);
  assert.equal(result.matches.size, 2);
  assert.equal(result.reported, 5);
  assert.equal(result.parties.find(p=>p.label==='Labor').swing, 20);
  assert.equal(result.parties.some(p=>p.label==='Independent'), false);
  assert.ok(Math.abs(result.coverage - 100 * 300 / 1345) < 1e-9);
});

test('TCP parser uses the separate candidate pair and excludes aggregates, duplicate venues and invalid accounting', () => {
  const row = parseDistrict(page(resultTable('TCP votes',550,450)), bass);
  const cells = (name, values) => `<tr><th>${name}</th>${values.map(v=>`<td>${v}</td>`).join('')}</tr>`;
  const numbers = [70,30,3,7,110];
  const html = `<main><table><thead><tr><th></th><th>TWO, B</th><th>ONE, A</th><th></th><th></th><th></th></tr><tr><th>Voting centres</th><th>Liberal</th><th>Labor</th><th>Mis-sorts</th><th>Informal votes</th><th>Total votes polled</th></tr></thead><tbody>${cells('Ordinary votes total',numbers)}${cells('Bass',numbers)}${cells('Wrong total',[70,30,3,0,110])}${cells('Duplicate',numbers)}${cells('Duplicate',numbers)}${cells('Early votes',numbers)}${cells('Early voting centres',[])}${cells('Election Centre',numbers)}</tbody></table></main>`;
  const venues = [{name:'Bass',kind:'ordinary'}, {name:'Wrong total',kind:'ordinary'}, {name:'Early votes',kind:'early'}, {name:'Election Centre',kind:'early'}, {name:'Duplicate',kind:'ordinary'}];
  const parsed = parseTcpBooths(html,row,venues);
  assert.deepEqual(parsed.pair.map(c => c.party), ['Liberal', 'Australian Labor Party - Victorian Branch']);
  assert.deepEqual(parsed.booths, [{name:'Bass',kind:'ordinary',votes:[70,30]}, {name:'Election Centre',kind:'early',votes:[70,30]}]);
  const archive = html.replace(cells('Election Centre',numbers),cells('Postal votes',numbers) + cells('Declaration votes total',numbers));
  assert.deepEqual(parseTcpBooths(archive,row,venues).pooled, [
    {kind:'early-total',name:'Prepoll total',votes:[70,30]}, {kind:'postal',name:'Postal votes',votes:[70,30]},
  ]);
});

test('TCP swing aligns reversed candidate order and rejects different sides or vote categories', () => {
  const current = {status:'ok', pair:[{name:'New Labor',party:'Labor'},{name:'INDEPENDENT, A',party:'Independent'}], booths:[{name:'Cowes',kind:'ordinary',votes:[60,40]},{name:'Cowes',kind:'early',votes:[80,20]}]};
  const previous = {pair:[{name:'Independent, A',party:'Independent'},{name:'Former Labor',party:'Australian Labor Party - Victorian Branch'}], booths:[{name:'cowes',kind:'ordinary',votes:[120,80]}]};
  const result = matchedTcp(current,previous);
  assert.deepEqual(result.get('ordinary:cowes'), {votes:[60,40],shares:[60,40],swing:[20,-20]});
  assert.deepEqual(result.get('early:cowes').swing,[null,null]);
  previous.pair[0].name = 'Another independent';
  assert.deepEqual(matchedTcp(current,previous).get('ordinary:cowes').swing,[null,null]);
  assert.equal(partyAbbreviation('Animal Justice Party'),'AJP');
  assert.equal(partyAbbreviation('Australian Labor Party - Victorian Branch'),'ALP');
});

test('best available comparison skips moved name matches and keeps TCP proxies within vote type and pair', () => {
  const pair = [{name:'A',party:'Labor'},{name:'B',party:'Liberal'}];
  const booth = (name,kind='ordinary') => ({name,kind,votes:[60,40]});
  const booths = [booth('Same'),booth('Moved'),booth('New'),booth('Early','early')];
  const fp = [['ordinary','Same',{Labor:40,Liberal:60}],['ordinary','Moved',{Labor:10,Liberal:90}],['early','Old EVC',{Labor:35,Liberal:65}]];
  const tcp = {pair,booths:[{...booth('Same'),votes:[40,60]}]};
  const extras = {moved:['Moved'], estimates:[{name:'Moved',kind:'ordinary',method:'weighted estimate',firstPreferences:{Labor:33,Liberal:67}}]};
  const current = {status:'ok',pair,booths};
  const result = boothComparisons(booths,fp,tcp,extras,current);
  assert.equal(result.get('ordinary:same').fpMethod,'Booth match');
  assert.equal(result.get('ordinary:moved').fpVotes.Labor,33);
  assert.equal(result.get('ordinary:moved').fpMethod,'Spatial estimate');
  assert.equal(result.get('ordinary:new').fpVotes.Labor,50);
  assert.equal(result.get('ordinary:new').tcp.method,'District proxy');
  assert.deepEqual(result.get('ordinary:new').tcp.swing,[20,-20]);
  assert.equal(result.get('early:early').fpVotes.Labor,35);
  assert.deepEqual(result.get('early:early').tcp.swing,[null,null]);
  const early = boothComparisons(booths,fp,{...tcp,earlyPool:[45,55]},extras,current).get('early:early');
  assert.deepEqual(early.tcp.swing,[15,-15]);
  assert.equal(early.tcp.method,'District proxy');
  const changed = {...current,pair:[pair[0],{name:'C',party:'Greens'}]};
  assert.deepEqual(boothComparisons(booths,fp,tcp,extras,changed).get('ordinary:new').tcp.swing,[null,null]);
});

test('electorate swing compares the same five reporting booths using vote-weighted shares', () => {
  const candidates = [{party:'Labor'},{party:'Liberal'}];
  const booths = [1,2,3,4,5].map(i => ({name:`Booth ${i}`,kind:'ordinary',votes:i === 5 ? [15,85] : [20,5]}));
  const fp = booths.map((b,i) => [b.kind,b.name,i === 4 ? {Labor:30,Liberal:20} : {Labor:10,Liberal:15}]);
  booths.push({name:'Not reported',kind:'ordinary',votes:[0,0]}, {name:'Moved',kind:'ordinary',votes:[100,0]}, {name:'Proxy only',kind:'ordinary',votes:[100,0]});
  fp.push(['ordinary','Not reported',{Labor:1000,Liberal:0}],['ordinary','Moved',{Labor:1000,Liberal:0}]);
  const result = electorateSwing(candidates,booths,fp,{moved:['Moved']});
  assert.equal(result.matches.size,5);
  assert.equal(result.reported,7);
  const labor = result.parties.find(p => p.label === 'Labor');
  assert.equal(labor.before,100*70/150);
  assert.equal(labor.after,47.5);
  assert.equal(labor.swing,47.5-100*70/150);
});
