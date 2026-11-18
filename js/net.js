/* All network access lives here.
 *   GET  gen.pollinations.ai/v1/models, /audio/models    (prices, free or paid-only)
 *   POST gen.pollinations.ai/v1/audio/transcriptions     (what the transcriber heard)
 *   POST gen.pollinations.ai/v1/audio/speech             (a clean reading of the target, to test the transcriber)
 *   POST gen.pollinations.ai/v1/chat/completions         (coaching from the scorecard)
 * The visitor's key is passed in as an argument; this app never logs or stores it.
 */
(function () {
  'use strict';
  var C = window.AL.config;

  function getJSON(url) { return fetch(url, { credentials: 'omit', cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }); }

  // { id: { paidOnly, pricing } } for the three models this app uses.
  function prices() {
    return Promise.all([getJSON(C.API + '/v1/models'), getJSON(C.API + '/audio/models')]).then(function (r) {
      var out = {}, text = (r[0] && (r[0].data || r[0].models)) || [], audio = Array.isArray(r[1]) ? r[1] : (r[1].data || []);
      text.forEach(function (m) { out[m.id] = { paidOnly: !!m.paid_only, pricing: m.pricing || {} }; });
      audio.forEach(function (m) { var id = m.name || m.id; out[id] = Object.assign(out[id] || {}, { pricing: m.pricing || (out[id] || {}).pricing || {} }); if (m.paid_only != null) out[id].paidOnly = !!m.paid_only; });
      return out;
    });
  }

  function send(key, path, init, signal) {
    if (signal && signal.aborted) return Promise.resolve({ ok: false, status: 0, error: 'cancelled', cancelled: true });
    var ctrl = new AbortController(), timedOut = false, t0 = Date.now();
    var timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, C.TIMEOUT_MS);
    function stop() { ctrl.abort(); }
    if (signal) signal.addEventListener('abort', stop, { once: true });
    init.headers = Object.assign({ Authorization: 'Bearer ' + key }, init.headers || {});
    init.credentials = 'omit'; init.cache = 'no-store'; init.signal = ctrl.signal;
    return fetch(C.API + path, init).then(function (res) {
      var ms = Date.now() - t0;
      if (!res.ok) return res.text().then(function (t) {
        var j = null; try { j = JSON.parse(t); } catch (e) { /* not JSON */ }
        var msg = (j && j.error && (j.error.message || j.error)) || t.slice(0, 200);
        return { ok: false, status: res.status, ms: ms, error: 'HTTP ' + res.status + ': ' + String(msg).slice(0, 200) };
      });
      return { ok: true, status: res.status, ms: ms, res: res };
    }).catch(function (e) {
      if (signal && signal.aborted && !timedOut) return { ok: false, status: 0, error: 'cancelled', cancelled: true };
      return { ok: false, status: 0, ms: Date.now() - t0, error: timedOut ? 'timed out' : String((e && e.message) || e) };
    }).then(function (r) { clearTimeout(timer); if (signal) signal.removeEventListener('abort', stop); return r; });
  }

  // No prompt with the target text: it would steer the transcriber toward the right words and hide mistakes.
  function transcribe(key, wav, signal) {
    var fd = new FormData();
    fd.append('file', wav, 'take.wav');
    fd.append('model', C.TRANSCRIBE);
    fd.append('language', 'en');
    fd.append('temperature', '0');
    return send(key, '/v1/audio/transcriptions', { method: 'POST', body: fd }, signal).then(function (r) {
      if (!r.ok) return r;
      return r.res.json().then(function (j) { return { ok: true, ms: r.ms, text: String((j && j.text) || '').trim() }; });
    });
  }

  function speak(key, text, signal) {
    return send(key, '/v1/audio/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: C.SPEAK, input: text, voice: C.VOICE, response_format: 'wav' }) }, signal).then(function (r) {
      if (!r.ok) return r;
      return r.res.blob().then(function (b) { return { ok: true, ms: r.ms, blob: b }; });
    });
  }

  function coach(key, messages, signal) {
    var body = { model: C.COACH, messages: messages, max_tokens: 220, seed: Math.floor(Math.random() * 2147483647) };
    return send(key, '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal).then(function (r) {
      if (!r.ok) return r;
      return r.res.json().then(function (j) {
        var c = j && j.choices && j.choices[0], t = c && c.message && typeof c.message.content === 'string' ? c.message.content.trim() : '';
        return t ? { ok: true, ms: r.ms, text: t, usage: j.usage } : { ok: false, error: 'empty reply' };
      });
    });
  }

  window.AL.net = { prices: prices, transcribe: transcribe, speak: speak, coach: coach };
})();
