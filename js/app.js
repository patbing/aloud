/* Aloud: the page. Model text is only ever inserted with textContent. */
(function () {
  'use strict';
  var C = window.AL.config, S = window.AL.score, A = window.AL.audio, N = window.AL.net;
  var app = { key: null, prices: null, rec: null, busy: false, ctrl: null, take: null, spent: 0 };

  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function trusted(fn) { return function (ev) { if (ev && ev.isTrusted === false) return; fn(ev); }; }
  function say(t, warn) { var n = $('notice'); n.textContent = t || ''; n.className = 'notice' + (warn ? ' warn' : ''); }
  function fmtP(x) { return x == null ? '?' : (x < 0.001 ? x.toFixed(5) : x.toFixed(4)) + ' P'; }

  // ---------- one scored take, recorded or live ----------
  function renderTake(box, t) {
    box.textContent = '';
    box.appendChild(h('p', 'target', t.target));
    if (t.error) { box.appendChild(h('p', 'warn', t.error)); return; }
    var sc = S.score(t.target, t.heard, t.baseline);
    var line = h('p', 'words');
    sc.ops.forEach(function (o) {
      var w = h('span', 'w ' + (o.asr ? 'asr' : o.type), o.type === 'extra' ? '+' + o.got : o.want);
      w.title = o.asr ? 'The transcriber missed this word even in a clean reading, so it is not counted.' :
        o.type === 'ok' ? 'heard right' : o.type === 'miss' ? 'not heard' : o.type === 'extra' ? 'heard but not in the sentence' : 'heard as "' + o.got + '"' + (o.close ? ' (close)' : '');
      line.appendChild(w);
      if (o.type === 'sub') line.appendChild(h('span', 'got', o.got));
    });
    box.appendChild(line);
    var facts = [sc.counted ? sc.right + ' of ' + sc.counted + ' words heard right' : 'no countable words'];
    if (sc.asrWords) facts.push(sc.asrWords + ' left out (transcriber missed them on the clean reading too)');
    if (t.timing) {
      var w = S.wpm(sc.total, t.timing.speechSec);
      if (w) facts.push(w + ' words per minute');
      facts.push(t.timing.pauses.length ? t.timing.pauses.length + ' pause' + (t.timing.pauses.length > 1 ? 's' : '') + ' (' + t.timing.pauses.map(function (p) { return p.len.toFixed(1) + ' s'; }).join(', ') + ')' : 'no pauses over 0.35 s');
    }
    box.appendChild(h('p', 'facts', facts.join(' · ')));
    var d = h('details', 'req'); d.appendChild(h('summary', null, 'What the transcriber wrote'));
    d.appendChild(h('p', 'heard', 'Your take: ' + (t.heard || '(nothing)')));
    if (typeof t.baseline === 'string') d.appendChild(h('p', 'heard', 'Clean synthetic reading: ' + (t.baseline || '(nothing)')));
    box.appendChild(d);
    if (t.coach) { box.appendChild(h('h3', null, 'Coach (' + C.COACH + ', from the scorecard only)')); t.coach.replace(/\*\*|__|`/g, '').split('\n').map(function (l) { return l.replace(/^\s*([-*•]|\d+[.)])\s+/, '').trim(); }).filter(Boolean).forEach(function (l) { box.appendChild(h('p', 'tip', l)); }); }
    else if (t.coachError) box.appendChild(h('p', 'warn', 'Coaching failed: ' + t.coachError + '. The score above does not depend on it.'));
  }

  // ---------- recorded takes, no sign-in ----------
  function loadRecordings() {
    return fetch('recordings/takes.json', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (rec) {
      app.rec = rec;
      var list = $('takes'); list.textContent = '';
      rec.takes.forEach(function (t, i) {
        var b = h('button', 'take', (i + 1) + '. ' + t.label);
        b.type = 'button';
        b.addEventListener('click', trusted(function () { showRecorded(t); }));
        list.appendChild(b);
      });
      $('recmeta').textContent = rec.takes.length + ' takes recorded ' + rec.recordedAt.slice(0, 10) + ' with ' + rec.models.join(', ') + '. The readers are synthetic voices; the transcripts and coaching are real model replies, the score is recomputed here.';
      if (rec.takes.length) showRecorded(rec.takes[0]);
    }).catch(function () { $('recmeta').textContent = 'The recorded takes are not published yet. Sign in to try your own.'; });
  }
  function showRecorded(t) {
    var a = $('recaudio'); a.src = 'recordings/' + t.audio; a.hidden = false;
    renderTake($('recresult'), t);
  }

  // ---------- live take ----------
  function target() { var c = $('custom').value.trim(); return c || $('sentence').value; }
  function estimate(sec, chars) {
    var p = app.prices; if (!p) return null;
    var tr = Number(((p[C.TRANSCRIBE] || {}).pricing || {}).promptAudioSeconds) || 0;
    var sp = Number(((p[C.SPEAK] || {}).pricing || {}).completionAudioTokens) || 0;
    var co = (p[C.COACH] || {}).pricing || {};
    var coach = 500 * (Number(co.promptTextTokens) || 0) + 220 * (Number(co.completionTextTokens) || 0);
    var base = $('baseline').checked ? sp * chars + tr * Math.max(4, chars / 14) : 0; // about 14 characters a second of speech
    return tr * sec + base + coach;
  }
  function freeCheck() {
    var p = app.prices || {}, bad = [C.TRANSCRIBE, C.COACH].concat($('baseline').checked ? [C.SPEAK] : []).filter(function (id) { return !p[id] || p[id].paidOnly; });
    return bad.length ? 'Not run: ' + bad.join(', ') + (app.prices ? ' is paid-only or missing from the model list today.' : ' (model list not loaded).') : null;
  }

  function startRec() {
    if (app.busy || !app.key) return;
    var stop = freeCheck(); if (stop) return say(stop, true);
    app.busy = true; render();
    A.record(C.MAX_SEC).then(function (r) {
      app.take = r; say('Recording… read the sentence, then press Stop (' + C.MAX_SEC + ' s at most).');
      r.stopped.then(function (got) { app.take = null; run(got); });
      render();
    }).catch(function (e) { app.busy = false; say('Microphone unavailable: ' + (e && e.message || e) + '. You can upload a recording instead.', true); render(); });
  }
  function stopRec() { if (app.take) app.take.stop(); }
  function upload(ev) {
    var f = ev.target.files && ev.target.files[0]; ev.target.value = '';
    if (!f || app.busy || !app.key) return;
    var stop = freeCheck(); if (stop) return say(stop, true);
    app.busy = true; render();
    A.decode(f).then(function (got) {
      if (got.samples.length > A.RATE * C.MAX_SEC) throw new Error('longer than ' + C.MAX_SEC + ' s');
      run(got);
    }).catch(function (e) { app.busy = false; say('Could not read that file: ' + (e && e.message || e), true); render(); });
  }

  function run(got) {
    var t = { target: target() }, key = app.key;
    app.ctrl = new AbortController(); var sig = app.ctrl.signal;
    t.timing = S.pauses(got.samples, got.rate);
    if (!t.timing.speechSec) { app.busy = false; say('That take was silent. Check the microphone and try again.', true); render(); return; }
    var sec = got.samples.length / got.rate;
    $('playback').src = URL.createObjectURL(got.wav); $('playback').hidden = false;
    say('Transcribing your take…');
    var mine = N.transcribe(key, got.wav, sig);
    var base = !$('baseline').checked ? Promise.resolve(null) : N.speak(key, t.target, sig).then(function (s) {
      if (!s.ok) return s;
      return A.decode(s.blob).then(function (d) { return N.transcribe(key, d.wav, sig); });
    });
    Promise.all([mine, base]).then(function (r) {
      if (!r[0].ok) { t.error = 'Transcription failed: ' + r[0].error + '. No score without a transcript.'; return; }
      t.heard = r[0].text;
      if (r[1] && r[1].ok) t.baseline = r[1].text;
      else if (r[1]) say('The transcriber check failed (' + r[1].error + '); every word is counted.', true);
      say('Asking the coach…');
      return N.coach(key, S.messages(S.card(t.target, S.score(t.target, t.heard, t.baseline), t.timing)), sig).then(function (c) {
        if (c.ok) t.coach = c.text; else t.coachError = c.error;
      });
    }).then(function () {
      app.spent += estimate(sec, t.target.length) || 0;
      if (!t.error) say('');
      renderTake($('liveresult'), t);
    }).catch(function (e) { say('Something broke: ' + (e && e.message || e), true); })
      .then(function () { app.busy = false; app.ctrl = null; render(); });
  }

  // ---------- sign-in ----------
  function readKey(c, e) {
    var k = (c && c.apiKey) || (e && e.detail && (e.detail.apiKey || e.detail.key)) || null;
    return typeof k === 'string' && k ? k : null;
  }
  function wireConnect() {
    var c = $('connect');
    c.setAttribute('app-key', C.APP_KEY);
    Promise.race([customElements.whenDefined('polli-connect'), new Promise(function (r) { setTimeout(r, 8000); })]).then(function () {
      if (!customElements.get('polli-connect')) { c.hidden = true; $('connect-fallback').hidden = false; }
      onKey(readKey(c));
    });
    c.addEventListener('change', function (e) { onKey(readKey(c, e)); });
  }
  function onKey(k) { if (k === app.key) return; app.key = k; if (!k && app.ctrl) app.ctrl.abort(); if (!k && app.take) app.take.stop(); render(); }

  function render() {
    var signed = !!app.key, recording = !!app.take;
    $('signin').hidden = signed;
    $('rec').disabled = !signed || (app.busy && !recording);
    $('rec').textContent = recording ? 'Stop' : 'Record';
    $('rec').classList.toggle('on', recording);
    $('file').disabled = !signed || app.busy;
    var est = estimate(8, target().length);
    $('cost').textContent = est == null ? '' : 'About ' + fmtP(est) + ' per 8-second take from listed prices' + ($('baseline').checked ? ', transcriber check included' : '') + '.';
    $('spent').hidden = !app.spent; $('spent').textContent = 'spent ≈ ' + fmtP(app.spent);
  }

  function init() {
    var sel = $('sentence');
    C.SENTENCES.forEach(function (s) { var o = h('option', null, s); o.value = s; sel.appendChild(o); });
    $('rec').addEventListener('click', trusted(function () { if (app.take) stopRec(); else startRec(); }));
    $('file').addEventListener('change', trusted(upload));
    ['sentence', 'custom', 'baseline'].forEach(function (id) { $(id).addEventListener('input', render); });
    $('src').href = C.REPO_URL;
    wireConnect();
    N.prices().then(function (p) { app.prices = p; render(); }).catch(function (e) { say('Model list unavailable: ' + e.message, true); });
    loadRecordings();
    render();
  }
  init();
})();
