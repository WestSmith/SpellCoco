import test from 'node:test';
import assert from 'node:assert/strict';
import { client, state } from './helpers.mjs';

// v101: someone else's word in progress (Coco in solo, an online opponent's live
// selection) shows as plain letters with one steady line, never a red "Not in
// dictionary" verdict, and "+ add word" only ever adds the speller's own word.
const select = (c, ids) => c.run(`game.clearSelection();for(const i of ${JSON.stringify(ids)}){game.tiles[i].isSelected=true;game.selection.push(i)}game.updateUI()`);
const preview = c => ({ word: c.doc.getElementById('word-display').className, line: c.doc.getElementById('score-preview').innerText, html: c.doc.getElementById('score-preview').innerHTML });
const soloCocoTurn = words => { const c = client(), st = state(); st.players[0].isCoco = true; c.load(st, `NET.mode="local";CONFIG.solo={active:true,mood:"cozy"};buildTrie(${JSON.stringify(words)})`); return c; };

test("Coco's partial words show plain letters and the hunting line, valid or not", () => {
  const c = soloCocoTurn(['EEE']);
  assert.equal(c.run('game.myTurn'), false);
  select(c, [0, 1]);                                   // EE: not a word
  let p = preview(c);
  assert.equal(p.word, ''); assert.equal(p.line, '🐾 Coco is hunting for a word…');
  assert.doesNotMatch(p.html, /add-word-btn|Not in dictionary/);
  select(c, [0, 1, 2]);                                // EEE: a word, still no verdict
  p = preview(c);
  assert.equal(p.word, ''); assert.equal(p.line, '🐾 Coco is hunting for a word…');
});

test("add word does nothing during Coco's turn", () => {
  const c = soloCocoTurn(['EEE']);
  select(c, [0, 1]);
  c.run('addWordFromGame()');
  assert.equal(c.run('localCustomWords.includes("EE")'), false);
  assert.equal(c.run('game.calculateCurrentScore().isValid'), false);
});

test("an online opponent's live selection reads as them spelling", () => {
  const c = client();
  c.load(state(0), 'NET.mode="host";NET.myIndex=1;buildTrie(["EEE"])');
  assert.equal(c.run('game.myTurn'), false);
  select(c, [0, 1]);
  const p = preview(c);
  assert.equal(p.word, ''); assert.equal(p.line, 'Keith is spelling…');
  assert.doesNotMatch(p.html, /add-word-btn/);
});

test('your own invalid word still offers add word, and it works', () => {
  const c = client();
  c.load(state(), 'NET.mode="local";CONFIG.solo=null;buildTrie(["EEE"])');
  select(c, [0, 1]);
  const p = preview(c);
  assert.equal(p.word, 'invalid'); assert.match(p.html, /Not in dictionary[^]*add-word-btn/);
  c.run('addWordFromGame()');
  assert.equal(c.run('localCustomWords.includes("EE")'), true);
});
