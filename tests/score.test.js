const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/score.js');

test('words normalise case, punctuation and small numbers', () => {
  assert.deepEqual(S.words('The 3 quick, brown-fox’s "jumps"!'), ['the', 'three', 'quick', 'brown', 'foxs', 'jumps']);
  assert.deepEqual(S.words("the 6th sheikh's 21st"), ['the', 'sixth', 'sheikhs', '21st']);
  assert.deepEqual(S.words('?! 안녕'), []);
});

test('possessives and ordinals the ear cannot tell apart are not mistakes', () => {
  const s = S.score("The sixth sick sheikh's sixth sheep is sick.", 'The 6th sick sheikhs sixth sheep is sick');
  assert.equal(s.right, 8);
});

test('a clean reading that comes back mostly wrong is ignored, not used to excuse everything', () => {
  const s = S.score('one two three four', 'one too three for', '');
  assert.equal(s.baselineDropped, true); assert.equal(s.asrWords, 0); assert.equal(s.counted, 4); assert.equal(s.right, 2);
});

test('pace counts the words said, not the target', () => {
  const s = S.score('a b c d e f g h i j', 'a b c');
  assert.equal(S.spoken(s), 3);
  assert.equal(S.card('a b c d e f g h i j', s, { speechSec: 1, pauses: [] }).words_per_minute, 180);
});

test('a perfect reading is all ok', () => {
  const s = S.score('She sells sea shells.', 'she sells sea shells');
  assert.equal(s.right, 4); assert.equal(s.accuracy, 1);
});

test('swapped, missed and extra words are found where they happen', () => {
  const s = S.score('the cat sat on the mat', 'the bat sat the the mat today');
  const t = s.ops.map((o) => o.type);
  assert.deepEqual(t, ['ok', 'sub', 'ok', 'sub', 'ok', 'ok', 'extra']);
  assert.equal(s.ops[1].want, 'cat'); assert.equal(s.ops[1].got, 'bat');
  assert.equal(s.right, 4); assert.equal(s.extras, 1);
  const m = S.score('one two three', 'one three');
  assert.deepEqual(m.ops.map((o) => o.type), ['ok', 'miss', 'ok']);
});

test('a near miss is marked close', () => {
  const s = S.score('thoroughly', 'thorougly');
  assert.equal(s.ops[0].close, true);
});

test('words the transcriber misses on the clean reading are left out of the score', () => {
  const s = S.score('Worcestershire sauce is tasty', 'wooster sauce is tasty', 'wooster sure sauce is tasty');
  assert.equal(s.ops[0].asr, true);
  assert.equal(s.counted, 3); assert.equal(s.right, 3); assert.equal(s.accuracy, 1);
  assert.equal(s.asrWords, 1);
});

test('pauses and speech span from samples', () => {
  const rate = 16000, tone = (sec) => Array.from({ length: rate * sec }, (_, i) => 0.3 * Math.sin(i / 5)), quiet = (sec) => new Array(rate * sec).fill(0);
  const x = Float32Array.from([...quiet(0.5), ...tone(1), ...quiet(1), ...tone(1), ...quiet(0.5)]);
  const p = S.pauses(x, rate);
  assert.equal(p.pauses.length, 1);
  assert.ok(Math.abs(p.pauses[0].len - 1) < 0.05, 'pause about 1 s');
  assert.ok(Math.abs(p.speechSec - 3) < 0.05, 'speech about 3 s');
  assert.ok(Math.abs(p.start - 0.5) < 0.05);
  assert.deepEqual(S.pauses(new Float32Array(rate), rate).pauses, []);
});

test('the coach card carries only measured facts', () => {
  const s = S.score('the cat sat', 'the bat sat');
  const c = S.card('the cat sat', s, { speechSec: 1.5, pauses: [{ at: 0.4, len: 0.9 }] });
  assert.deepEqual(c.mistakes, [{ kind: 'swapped', word: 'cat', heard: 'bat' }]);
  assert.equal(c.words_per_minute, 120);
  assert.deepEqual(c.pauses, [0.9]);
  const m = S.messages(c);
  assert.equal(m[0].role, 'system'); assert.match(m[1].content, /"word":"cat"/);
});

test('a word the reader skipped counts, even if the clean reading only mis-heard it', () => {
  const s = S.score('the sixth sheep is sick', 'the sheep is sick', 'the six sheep is sick');
  assert.equal(s.asrWords, 0); assert.equal(s.counted, 5); assert.equal(s.right, 4);
  const same = S.score('the sixth sheep is sick', 'the six sheep is sick', 'the six sheep is sick');
  assert.equal(same.asrWords, 1); assert.equal(same.counted, 4); assert.equal(same.right, 4);
});
