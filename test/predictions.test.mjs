import assert from 'node:assert/strict';
import test from 'node:test';
import candidates from '../public/data/candidates-2026.json' with { type:'json' };
import districts from '../public/data/districts.json' with { type:'json' };
import { candidateKey, countStarted, pollsClose, predictionResult, predictionSummary, readPredictions } from '../public/predictions.js';

const pick = { name:'O’NEILL, Taylor', party:'Independent' };
const winner = { name:"Taylor O'Neill", party:'Independent', votes:600 };
const other = { name:'Sam Chen', party:'Independent', votes:400 };
const row = { fp:[winner,other], two:[winner,other], twoStatus:'reported', enrolled:1100 };

test('nominations cover the 88 districts with individually selectable candidates', () => {
  assert.equal(Object.keys(districts).length,88);
  assert.deepEqual(Object.keys(candidates).sort(),Object.keys(districts).sort());
  for (const list of Object.values(candidates)) {
    assert.ok(list.length && list.every(c => c.name && c.party));
    assert.equal(new Set(list.map(candidateKey)).size,list.length);
  }
});

test('pre-count edits close at 6 pm Melbourne time or when real results arrive', () => {
  assert.equal(pollsClose, Date.parse('2026-11-28T07:00:00Z'));
  assert.equal(countStarted({status:'waiting'},pollsClose-1),false);
  assert.equal(countStarted({status:'archive',results:[row]},pollsClose-1),false);
  assert.equal(countStarted({status:'ok',results:[row]},pollsClose-1),true);
  assert.equal(countStarted(null,pollsClose),true);
});

test('only declarations score; similar names and independent candidates are not interchangeable', () => {
  assert.equal(predictionResult(pick,row,'ok').status,'ahead'); // TCP lock is still provisional.
  assert.equal(predictionResult(other,row,'ok').status,'behind');
  assert.equal(predictionResult(pick,{...row,enrolled:2000},'ok').status,'pending');
  assert.equal(predictionResult(pick,row,'stale').status,'pending');
  assert.equal(predictionResult(pick,{...row,stale:true},'partial').status,'pending');
  const declared = {...row,elected:winner};
  assert.equal(predictionResult(pick,declared,'ok').status,'correct');
  assert.equal(predictionResult(other,declared,'ok').status,'missed');
  assert.equal(predictionResult(pick,declared,'archive').status,'pending');
  assert.equal(predictionResult(pick,declared,'stale').status,'correct');
  const picks = [[pick,declared],[other,declared],[pick,row],[other,row],[null,declared]];
  const stats = predictionSummary(picks.map(([pick,result]) => ({pick,...predictionResult(pick,result,'ok')})));
  assert.deepEqual(stats,{unpicked:1,pending:0,ahead:1,behind:1,correct:1,missed:1,picked:4,declared:2,parties:[['Independents',4]]});
});

test('stored prediction sets stay separate and recover from malformed storage', () => {
  const sets = {original:{bass:pick},live:{bass:other},lockedAt:pollsClose-1};
  assert.deepEqual(readPredictions(JSON.stringify(sets)),sets);
  assert.deepEqual(readPredictions('bad json'),{original:{},live:{},lockedAt:null});
  assert.deepEqual(readPredictions('{"original":{"bass":null},"lockedAt":"bad date"}'),{original:{},live:{},lockedAt:null});
});
