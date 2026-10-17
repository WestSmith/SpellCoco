import test from 'node:test';
import assert from 'node:assert/strict';
import { client, flush } from './helpers.mjs';

// v78: no sound backlog after an iOS audio interruption; one purr at a time.
// A Web Audio double whose clock and state the test drives, like iOS does:
// while suspended or interrupted, currentTime stands still.
function audio(c, initial = 'suspended') {
  const made = [];
  c.ctx.window.AudioContext = class {
    constructor() { this.state = initial; this.currentTime = 0; this.destination = {}; this.started = []; this.pending = []; made.push(this); }
    resume() { return new Promise((ok, fail) => this.pending.push({ ok, fail })); }
    land(state = 'running') { this.state = state; this.pending.splice(0).forEach(p => p.ok()); }
    refuse() { this.pending.splice(0).forEach(p => p.fail(new Error('InvalidStateError'))); }
    param() { return { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }; }
    createOscillator() { const ac = this; return { frequency: this.param(), connect() {}, start(t) { ac.started.push(t ?? ac.currentTime); }, stop() {} }; }
    createGain() { return { gain: this.param(), connect() {} }; }
    createBiquadFilter() { return { frequency: this.param(), Q: this.param(), connect() {} }; }
  };
  let now = 1e6;
  c.ctx.clock = () => now;
  c.run('Date.now=()=>clock()');
  return { made, ac: () => made.at(-1), advance(ms) { now += ms; } };
}

test('sounds asked for during an interruption are dropped, not replayed in a burst', async () => {
  const c = client(), a = audio(c);
  c.run('soundEnabled=true;initAudio()');
  a.ac().state = 'interrupted';                          // a phone call starts
  for (let i = 0; i < 6; i++) { c.run('SFX.tileSelect()'); a.advance(2000); }
  c.run('SFX.invalid();SFX.swap()');
  a.advance(5000);
  a.ac().land();                                          // the call ends; iOS resumes the context
  await flush();
  assert.equal(a.ac().started.length, 0, 'nothing queued up during the call plays afterwards');
  c.run('SFX.tileSelect()');
  assert.equal(a.ac().started.length, 1, 'the next sound plays normally');
});

test('the tap that unlocks audio still plays its own sound', async () => {
  const c = client(), a = audio(c);
  c.run('soundEnabled=true;initAudio();SFX.tileSelect()');
  assert.equal(a.ac().started.length, 0);
  a.advance(40); a.ac().land(); await flush();
  assert.equal(a.ac().started.length, 1);
});

test('a refused resume (still interrupted) is silent and harmless', async () => {
  const c = client(), a = audio(c, 'interrupted');
  c.run('soundEnabled=true;initAudio();SFX.submit();playPurr()');
  a.ac().refuse(); await flush();
  assert.equal(a.ac().started.length, 0);
  assert.equal(a.made.length, 1, 'the same context is reused');
});

test('any tap re-wakes audio after a call, not only the board', () => {
  const c = client(), a = audio(c);
  c.run('soundEnabled=true;initAudio()');
  a.ac().land(); a.ac().state = 'suspended';
  const before = a.ac().pending.length;
  c.events['document:touchend'].forEach(f => f({}));
  assert.equal(a.ac().pending.length, before + 1, 'resume() is asked inside the gesture');
  c.run('soundEnabled=false;audioCtx=null');
  c.events['document:click'].forEach(f => f({}));
  assert.equal(a.made.length, 1, 'sound off and no context yet: a tap creates nothing');
});

test('tapping Coco quickly gives one purr, not a stack of them', () => {
  const c = client(), a = audio(c, 'running');
  const coco = c.els.get('coco-lounge');
  for (let i = 0; i < 12; i++) coco.listeners.click.forEach(f => f({}));
  const voice = a.ac().started.length;
  assert.equal(voice, 4, 'two carriers and their two tremolo oscillators');
  c.run('playPurr();playPurr()');
  assert.equal(a.ac().started.length, voice, 'even a direct call waits for the current purr');
  a.ac().currentTime = 1.6; c.fireDelay(1500);
  coco.listeners.click.forEach(f => f({}));
  assert.equal(a.ac().started.length, voice * 2, 'once it ends, the next pet purrs again');
});
