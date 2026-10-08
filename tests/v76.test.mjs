import test from 'node:test';
import assert from 'node:assert/strict';
import { client, state, plain } from './helpers.mjs';

// v76: the long-word bonus is a line in Coco's bubble, not a word-area banner.
function catBoard() {
  const st = state();
  st.tiles = [...'CAT' + 'E'.repeat(22)].map(char => ({ char, mult: null, gem: false }));
  return st;
}
const submitCat = 'game.handleTileClick(0);game.handleTileClick(1);game.handleTileClick(2);game.submitWord()';

test('a host sends the score and the long-word bonus in ONE fx message', () => {
  const c = client(); c.load(catBoard(), 'NET.mode="host";NET.myIndex=0;buildTrie(["CAT"]);CONFIG.longWordTiers=[{len:3,bonus:5}];');
  c.run(submitCat);
  const fx = c.sent.filter(m => m.type === 'fx' && (m.toast || m.celebrate));
  assert.deepEqual(plain(fx[0]), { type: 'fx', toast: 'CAT → +13 pts', celebrate: 'Long word! +5 bonus included', sfx: 'longWord' });
  assert.ok(!fx.slice(1).some(m => m.celebrate || /CAT →/.test(m.toast)), 'no second copy of either line');
});

test('without a bonus the score goes alone, with no celebrate field', () => {
  const c = client(); c.load(catBoard(), 'NET.mode="host";NET.myIndex=0;buildTrie(["CAT"]);CONFIG.longWordTiers=[{len:9,bonus:5}];');
  c.run(submitCat);
  assert.deepEqual(plain(c.sent.find(m => m.type === 'fx' && m.toast)), { type: 'fx', toast: 'CAT → +8 pts' });
  assert.ok(!c.sent.some(m => m.celebrate));
});
