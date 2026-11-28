import assert from 'node:assert/strict';
import test from 'node:test';
import { projectDistrict, projectedParty, seatOutlook, tcpLock } from '../public/projection.js';

const candidates = [{name:'A',party:'Labor'},{name:'B',party:'Liberal'},{name:'C',party:'Greens'}];
const pair = candidates.slice(0,2);
const booth = (i,votes) => ({kind:'ordinary',name:`Venue ${i}`,votes});
const withVotes = (people,votes) => people.map((c,i) => ({...c,votes:votes[i]}));

test('mixes published TCP, ten FP-only booths and five unreported booths without double counting', () => {
  const history = {pair:[...pair].reverse(),districtTotal:[1100,900],booths:Array.from({length:20},(_,i) => booth(i,i < 5 ? [50,50] : i < 15 ? [55,45] : [60,40]))};
  const tcp = {status:'ok',pair:[...pair].reverse(),booths:Array.from({length:5},(_,i) => booth(i,[40,60]))};
  const booths = Array.from({length:20},(_,i) => booth(i, i < 5 ? [40,30,30] : i < 15 ? [33,37,30] : [null,null,null]));
  const row = {fp:withVotes(candidates,[530,520,450]),two:withVotes(pair,[300,200]),twoStatus:'reported'};
  const detail = {status:'ok',candidates,booths,tcp};
  const result = projectDistrict(row,detail,{tcp:history,final:{pair,districtTotal:[960,1040]}});
  assert.equal(result.tcpCount,500);
  assert.equal(result.fpEstimated,1000);
  assert.equal(result.remaining,500);
  assert.equal(result.matchedTcp,5);
  assert.ok(Math.abs(result.swing-10) < 1e-9);
  assert.ok(Math.abs(result.share-54) < 1e-9);
  assert.ok(Math.abs(result.projectedSwing-6) < 1e-9);
  assert.equal(projectDistrict(row,detail,{tcp:history}).projectedSwing,null);
  assert.equal(result.leader.party,'Labor');
  assert.equal(result.confidence,'Uncertain');
  assert.equal(projectDistrict({...row,two:withVotes(pair,[301,200])},detail,{tcp:history}),null);
  assert.equal(projectDistrict({...row,twoStatus:'withheld'},detail,{tcp:history}),null);
  assert.equal(projectDistrict(row,detail,{tcp:{...history,pair:candidates.slice(1)}}),null);
});

test('uses historical flows for an early projection but waits for actual TCP before Likely', () => {
  const fp = {Labor:300,Liberal:300,Greens:400};
  const history = {pair,districtTotal:[500,500],booths:Array.from({length:5},(_,i) => booth(i,[100,100]))};
  const row = {fp:withVotes(candidates,[40,10,50]),two:[],twoStatus:'unavailable',enrolled:1200};
  const detail = {status:'ok',candidates,booths:[booth(0,[40,10,50])]};
  const early = projectDistrict(row,detail,{tcp:history,fp});
  assert.equal(early.assumedPair,true);
  assert.equal(early.matchedTcp,0);
  assert.equal(early.confidence,'Uncertain');
  assert.equal(early.winProbability,null);

  const tcp = {status:'ok',pair,booths:Array.from({length:4},(_,i) => booth(i,[140,60]))};
  const late = {...row,fp:withVotes(candidates,[320,80,400]),two:withVotes(pair,[560,240]),twoStatus:'reported'};
  const result = projectDistrict(late,{...detail,booths:tcp.booths.map((_,i) => booth(i,[80,20,100])),tcp},{tcp:history,fp});
  assert.equal(result.confidence,'Likely');
  assert.deepEqual(projectedParty(late,result,history),{candidate:late.two[0],label:'Likely'});
  assert.equal(tcpLock(late),null);
  assert.ok(result.winProbability > 0.99 && result.winProbability < 1);
});

test('win chance responds to spread across booths and withholds a number for concentrated TCP', () => {
  const history = {pair,districtTotal:[1000,1000],booths:Array.from({length:10},(_,i) => booth(i,[100,100]))};
  const estimate = (firstVotes, totals = [100,100,100,100]) => {
    const total = totals.reduce((a,b) => a+b,0);
    const first = firstVotes.reduce((a,b) => a+b,0);
    const two = withVotes(pair,[first,total-first]);
    const booths = firstVotes.map((v,i) => booth(i,[v,totals[i]-v]));
    return projectDistrict({fp:two,two,twoStatus:'reported'}, {status:'ok',candidates:pair,booths,tcp:{status:'ok',pair,booths}}, {tcp:history,final:history});
  };
  const consistent = estimate([54,55,55,56]);
  const mixed = estimate([30,40,70,80]);
  assert.equal(consistent.share,mixed.share);
  assert.ok(consistent.winProbability > mixed.winProbability);
  assert.ok(mixed.winProbability > 0.5);
  assert.equal(estimate([330,55,55,55],[600,100,100,100]).winProbability,null);
  assert.equal(estimate([22,22,22,22],[40,40,40,40]).winProbability,null);
  const liberalLead = estimate([22,22,22,22]);
  assert.equal(liberalLead.leader.party,'Liberal');
  assert.ok(Math.abs(liberalLead.projectedSwing-28) < 1e-9);
  assert.equal(estimate([50,50,50,50]).projectedSwing,null);
});

test('reconciles pooled TCP against venue-level prepoll and excludes moved booths from swing', () => {
  const history = {pair,districtTotal:[160,140],booths:[booth(0,[50,50]),booth(1,[50,50])],earlyPool:[60,40]};
  const row = {fp:withVotes(candidates,[82,62,56]),two:withVotes(pair,[115,85]),twoStatus:'reported'};
  const detail = {status:'ok',candidates,booths:[booth(0,[40,30,30]),booth(1,[0,0,0]),{kind:'early',name:'EVC',votes:[42,32,26]}],
    tcp:{status:'ok',pair,booths:[booth(0,[55,45])],pooled:[{kind:'early-total',name:'Prepoll total',votes:[60,40]}]}};
  const result = projectDistrict(row,detail,{tcp:history});
  assert.equal(result.tcpCount,200);
  assert.equal(result.fpEstimated,0);
  assert.equal(result.remaining,100);
  assert.equal(projectDistrict(row,detail,{tcp:history,moved:['Venue 0']}),null);
});

test('a mathematical TCP lock needs an official upper bound and must rule out a tie', () => {
  const row = {fp:withVotes(candidates,[490,290,120]),two:withVotes(pair,[550,350]),twoStatus:'reported',enrolled:1100};
  assert.equal(tcpLock(row),null); // Remaining 200 could tie the 200-vote lead.
  assert.equal(tcpLock({...row,enrolled:undefined}),null);
  assert.equal(tcpLock({...row,enrolled:800}),null);
  const locked = {...row,enrolled:1099};
  assert.deepEqual(projectedParty(locked,null,pair[1]),{candidate:locked.two[0],label:'Gain',locked:true,remaining:199});
  assert.equal(projectedParty(locked,null,pair[0]).label,'Hold');
  assert.equal(projectedParty(locked,null,undefined).label,'TCP Locked');
  assert.equal(tcpLock({...locked,stale:true}),null);
  assert.equal(projectedParty({...locked,elected:row.fp[1]},null,pair[1]).label,'Declared');
});

test('seat outlook counts each race at its strongest stage and leaves provisional leads unallocated', () => {
  const base = {fp:withVotes(candidates,[490,290,120]),two:withVotes(pair,[550,350]),twoStatus:'reported'};
  const forecast = (id,leader,confidence) => ({...base,id,projection:{leader,confidence}});
  const rows = [forecast('a',pair[0],'Leaning'),forecast('b',pair[1],'Likely'),
    {...forecast('c',pair[1],'Likely'),enrolled:1099},
    {...forecast('d',pair[0],'Likely'),elected:{party:'Independent'},enrolled:1099},
    forecast('e',pair[0],'Uncertain'),{...base,id:'f'},{...forecast('g',pair[0],'Likely'),stale:true}];
  const groups = seatOutlook(rows);
  assert.deepEqual(groups.map(p => [p.party,p.total]),[['Labor',2],['Liberal',1],['Nationals',0],['Greens',0],['One Nation',0],['Other',1]]);
  assert.deepEqual(groups[0].leaning.map(seat => seat.id),['a']);
  assert.deepEqual(groups[0].locked.map(seat => seat.id),['c']);
  assert.deepEqual(groups[1].likely.map(seat => seat.id),['b']);
  assert.deepEqual(groups.at(-1).declared,[{id:'d',party:'Independent'}]);
  assert.deepEqual(seatOutlook(rows,{allowProjections:false}).filter(p => p.total).map(p => p.party),['Other']);
});
