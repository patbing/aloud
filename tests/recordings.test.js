const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const S = require('../js/score.js');
const AU = require('../js/audio.js');

const file = path.join(__dirname, '../recordings/takes.json');

test('wav bytes have a valid 16 kHz mono header', () => {
  const b = AU.wavBytes(new Float32Array([0, 0.5, -0.5, 1]), 16000);
  assert.equal(Buffer.from(b.subarray(0, 4)).toString(), 'RIFF');
  assert.equal(new DataView(b.buffer).getUint32(24, true), 16000);
  assert.equal(b.length, 44 + 8);
  assert.equal(AU.resample(new Float32Array(48000), 48000).length, 16000);
  const alt = Float32Array.from({ length: 48000 }, (_, i) => (i % 2 ? 1 : -1)); // 24 kHz tone, above what 16 kHz can hold
  const down = AU.resample(alt, 48000);
  assert.ok(Math.max(...down.map(Math.abs)) < 0.5, 'averaging removes most of a tone above the new Nyquist');
});

test('every recorded take has its audio and rescoring works', { skip: !existsSync(file) && 'no recordings yet' }, () => {
  const text = readFileSync(file, 'utf8');
  assert.ok(!/sk_[A-Za-z0-9]{6,}/.test(text), 'a secret key in the recording');
  const rec = JSON.parse(text);
  assert.ok(rec.takes.length >= 2);
  for (const t of rec.takes) {
    assert.ok(existsSync(path.join(__dirname, '../recordings', t.audio)), t.id + ' audio file');
    assert.equal(typeof t.heard, 'string');
    const s = S.score(t.target, t.heard, t.baseline);
    assert.equal(s.total, S.words(t.target).length);
    assert.ok(t.coach || t.coachError, t.id + ' coach reply or its failure');
  }
});
