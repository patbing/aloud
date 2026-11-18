// Record the no-sign-in takes. Spends Pollen: run only after the cost is approved.
//   POLLINATIONS_KEY=sk_... node tools/record.mjs <max Pollen>
// For each sentence: a synthetic reader (voice nova) reads it straight and with a planted slip, the baseline voice (alloy)
// reads it clean, the transcriber writes all three down, and the coach answers from the scorecard of each take.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../js/score.js');
const AU = require('../js/audio.js');

const KEY = process.env.POLLINATIONS_KEY;
if (!KEY) { console.error('Set POLLINATIONS_KEY'); process.exit(1); }
const MAX = Number(process.argv[2] || 0.05);
const API = 'https://gen.pollinations.ai';
const M = { tr: 'openai/whisper-large-v3', sp: 'openai/tts-1', co: 'openai/gpt-5.4-nano' };
const PLAN = [
  ['The sixth sick sheikh\'s sixth sheep is sick.', 'The sixth sick sheikh\'s sick sheep is sixth.'],
  ['Thirteen thin thieves thought they had thrown the thread through the thimble.', 'Thirteen thin thieves thought they threw the thread through the thimble.'],
  ['A proper copper coffee pot sits on the third shelf from the left.', 'A proper coffee copper pot sits on the third shelf from the left.'],
  ['Red lorry, yellow lorry, red lorry, yellow lorry, all the way to Worcestershire.', 'Red lorry, yellow lorry, red lolly, yellow lorry, all the way to Worcestershire.']
];

const text = (await (await fetch(API + '/v1/models')).json()).data;
const audio = await (await fetch(API + '/audio/models')).json();
const info = Object.fromEntries([...text.map((m) => [m.id, m]), ...audio.map((m) => [m.name, { ...(text.find((t) => t.id === m.name) || {}), ...m }])]);
for (const id of Object.values(M)) {
  if (!info[id]) { console.error('unknown model ' + id); process.exit(1); }
  if (info[id].paid_only) { console.error('paid-only model refused ' + id); process.exit(1); }
}
const P = { tr: Number(info[M.tr].pricing.promptAudioSeconds), sp: Number(info[M.sp].pricing.completionAudioTokens), coIn: Number(info[M.co].pricing.promptTextTokens), coOut: Number(info[M.co].pricing.completionTextTokens) };

// Spend guard: reserve each call's worst case before sending; a failed call is charged at worst case.
let spent = 0;
function reserve(w, what) { if (spent + w > MAX) throw new Error('spend cap reached before ' + what + ' (spent ≈ ' + spent.toFixed(5) + ')'); spent += w; }
const auth = { Authorization: 'Bearer ' + KEY };

function pcm(buf) { // 16-bit PCM WAV -> { samples (16 kHz), rate }
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 12, rate = 24000, ch = 1;
  while (o + 8 <= v.byteLength) {
    const id = String.fromCharCode(...buf.subarray(o, o + 4)), len = v.getUint32(o + 4, true);
    if (id === 'fmt ') { ch = v.getUint16(o + 10, true); rate = v.getUint32(o + 12, true); }
    if (id === 'data') {
      const n = Math.floor(Math.min(len, v.byteLength - o - 8) / 2 / ch), x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = v.getInt16(o + 8 + i * 2 * ch, true) / 32768;
      return { samples: AU.resample(x, rate), rate: AU.RATE };
    }
    o += 8 + len + (len & 1);
  }
  throw new Error('no data chunk');
}
async function speak(input, voice) {
  reserve(P.sp * input.length * 2, 'speech');
  const r = await fetch(API + '/v1/audio/speech', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: M.sp, input, voice, response_format: 'wav' }) });
  if (!r.ok) throw new Error('speech HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return pcm(new Uint8Array(await r.arrayBuffer()));
}
async function transcribe(a) {
  reserve(P.tr * (a.samples.length / a.rate + 1), 'transcription');
  const fd = new FormData();
  fd.append('file', new Blob([AU.wavBytes(a.samples, a.rate)], { type: 'audio/wav' }), 'take.wav');
  fd.append('model', M.tr); fd.append('language', 'en'); fd.append('temperature', '0');
  const r = await fetch(API + '/v1/audio/transcriptions', { method: 'POST', headers: auth, body: fd });
  if (!r.ok) throw new Error('transcription HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return String((await r.json()).text || '').trim();
}
async function coach(messages) {
  reserve(600 * P.coIn + 220 * P.coOut, 'coach');
  const r = await fetch(API + '/v1/chat/completions', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: M.co, messages, max_tokens: 220, seed: Math.floor(Math.random() * 2 ** 31) }) });
  const j = await r.json().catch(() => null);
  if (!r.ok) return { coachError: 'HTTP ' + r.status };
  const t = j?.choices?.[0]?.message?.content?.trim();
  return t ? { coach: t } : { coachError: 'empty reply' };
}

mkdirSync(new URL('../recordings/', import.meta.url), { recursive: true });
const takes = [];
try {
  for (const [i, [target, slipped]] of PLAN.entries()) {
    const baseline = await transcribe(await speak(target, 'alloy'));
    for (const [kind, said] of [['straight', target], ['slipped', slipped]]) {
      const a = await speak(said, 'nova');
      const id = 't' + (i + 1) + (kind === 'straight' ? 'a' : 'b');
      writeFileSync(new URL('../recordings/' + id + '.wav', import.meta.url), AU.wavBytes(a.samples, a.rate));
      const heard = await transcribe(a);
      const timing = S.pauses(a.samples, a.rate);
      const c = await coach(S.messages(S.card(target, S.score(target, heard, baseline), timing)));
      takes.push({ id, label: (kind === 'straight' ? 'Straight: ' : 'Planted slip: ') + target.split(' ').slice(0, 4).join(' ') + '…', target, said, audio: id + '.wav', heard, baseline, timing, ...c });
      console.log(id, '| heard:', heard, '| spent ≈', spent.toFixed(5));
    }
  }
} catch (e) { console.error(String(e.message || e)); }
// Takes recorded by a real person (human: true) are not made here; keep them first.
const old = (() => { try { return JSON.parse(readFileSync(new URL('../recordings/takes.json', import.meta.url), 'utf8')).takes.filter((t) => t.human); } catch { return []; } })();
takes.unshift(...old);
writeFileSync(new URL('../recordings/takes.json', import.meta.url), JSON.stringify({ recordedAt: new Date().toISOString(), models: Object.values(M), voices: { reader: 'nova', baseline: 'alloy' }, spentUpperBound: +spent.toFixed(5), takes }, null, 1));
console.log(takes.length + ' takes, worst-case spend ≈ ' + spent.toFixed(5) + ' P');
