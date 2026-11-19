const test = require('node:test');
const assert = require('node:assert');
const P = require('../js/pitch.js');

const R = 16000;
const TUNE = { bpm: 100, steps: [[0, 1], [2, 1], [4, 1], [5, 1], [7, 2]] };

function noise(n, a) { let s = 7; const x = new Float32Array(n); for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; x[i] = a * (s / 0x7fffffff * 2 - 1); } return x; }

test('a steady tone is read within 10 cents', () => {
  const x = P.synth([{ m: 57, sec: 1 }], R, { vibrato: 0 });
  const ns = P.notes(P.track(x, R));
  assert.strictEqual(ns.length, 1);
  assert.ok(Math.abs(ns[0].m - 57) < 0.1, ns[0].m);
});

test('noise alone is not sung notes', () => {
  assert.strictEqual(P.notes(P.track(noise(R, 0.2), R)).length, 0);
});

test('a clean take of the tune is all in tune', () => {
  const t = P.written(TUNE, 55);
  const sc = P.score(P.synth(t, R), R, t);
  assert.strictEqual(sc.counted, 5);
  assert.strictEqual(sc.inTune, 5);
  assert.strictEqual(sc.shift, 0);
});

test('singing an octave down is not a mistake', () => {
  const t = P.written(TUNE, 60);
  const sc = P.score(P.synth(t.map((n) => ({ m: n.m - 12, sec: n.sec })), R), R, t);
  assert.strictEqual(sc.shift, -12);
  assert.strictEqual(sc.inTune, 5);
});

test('a flat note and a skipped note are caught', () => {
  const t = P.written(TUNE, 55);
  const sung = t.map((n, i) => (i === 2 ? { m: n.m, sec: n.sec, cents: -70 } : n)).filter((_, i) => i !== 3);
  const sc = P.score(P.synth(sung, R), R, t);
  const by = sc.ops.filter((o) => o.i != null);
  assert.strictEqual(by[2].type, 'off');
  assert.ok(by[2].cents < -50 && by[2].cents > -90, by[2].cents);
  assert.strictEqual(by[3].type, 'miss');
  assert.strictEqual(sc.inTune, 3);
});

test('the pitch-reader check leaves out notes it cannot read through the room noise', () => {
  const t = P.written(TUNE, 55);
  const loud = noise(R * 0.3, 0.5);
  const chk = P.check(t, 0, loud, R);
  // Either it flags notes or, failing on most, drops itself. Both mean no note is blamed on the singer unfairly.
  assert.ok(chk.dropped || Object.keys(chk.bad).length > 0);
  const quiet = P.check(t, 0, noise(R * 0.3, 0.001), R);
  assert.strictEqual(quiet.dropped, false);
  assert.strictEqual(Object.keys(quiet.bad).length, 0);
});

test('the coach card names notes and says an octave choice is fine', () => {
  const t = P.written(TUNE, 60);
  const sc = P.score(P.synth(t.map((n) => ({ m: n.m - 12, sec: n.sec })), R), R, t);
  const c = P.card('Five up', t, sc);
  assert.strictEqual(c.notes[0].note, 'C3'); // the octave the singer chose, as the page shows it
  assert.match(c.octave, /1 octave below/);
  assert.strictEqual(P.messages(c)[0].content, P.COACH_RULES);
});

test('repeated notes sung without a break are still two notes', () => {
  const tw = { bpm: 100, steps: [[0, 1], [0, 1], [7, 1], [7, 1], [9, 1], [9, 1], [7, 2]] };
  const t = P.written(tw, 55);
  // Each "da" dips in loudness at the consonant even with no silence between notes.
  const x = P.synth(t, R, { gap: 0 });
  let o = Math.round(R * 0.3);
  t.forEach((n) => { const len = Math.round(R * n.sec); for (let q = 0; q < Math.round(R * 0.05); q++) x[o + q] *= 0.15; o += len; });
  const sc = P.score(x, R, t);
  assert.strictEqual(sc.inTune, 7, JSON.stringify(sc.ops));
});

test('wide vibrato does not split notes', () => {
  const t = P.written(TUNE, 55);
  const sc = P.score(P.synth(t, R, { vibrato: 0.8 }), R, t);
  assert.strictEqual(sc.inTune, 5, JSON.stringify(sc.ops));
  assert.strictEqual(sc.extras, 0);
});

test('room noise is not taken from digital silence', () => {
  const x = new Float32Array(R);
  x.set(noise(R / 2, 0.01), R / 2);
  const n = P.roomNoise(x, R);
  assert.ok(n.some((v) => v !== 0));
});
