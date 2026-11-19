/* Aloud: the page. Model text is only ever inserted with textContent. */
(function () {
  'use strict';
  var C = window.AL.config, S = window.AL.score, A = window.AL.audio, N = window.AL.net, P = window.AL.pitch;
  var app = { key: null, prices: null, rec: null, busy: false, ctrl: null, take: null, stake: null, tune: null, spent: 0 };

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
      var w = S.wpm(S.spoken(sc), t.timing.speechSec);
      if (w) facts.push(w + ' words per minute');
      facts.push(t.timing.pauses.length ? t.timing.pauses.length + ' pause' + (t.timing.pauses.length > 1 ? 's' : '') + ' (' + t.timing.pauses.map(function (p) { return p.len.toFixed(1) + ' s'; }).join(', ') + ')' : 'no pauses over 0.35 s');
    }
    box.appendChild(h('p', 'facts', facts.join(' · ')));
    if (t.note) box.appendChild(h('p', t.human ? 'facts' : 'warn', t.note));
    if (t.baselineError) box.appendChild(h('p', 'warn', 'The transcriber check failed (' + t.baselineError + '), so every word is counted.'));
    else if (sc.baselineDropped) box.appendChild(h('p', 'warn', 'The clean reading came back mostly wrong, so the transcriber check was ignored and every word is counted.'));
    var d = h('details', 'req'); d.appendChild(h('summary', null, 'What the transcriber wrote'));
    d.appendChild(h('p', 'heard', 'Your take: ' + (t.heard || '(nothing)')));
    if (typeof t.baseline === 'string') d.appendChild(h('p', 'heard', 'Clean synthetic reading: ' + (t.baseline || '(nothing)')));
    box.appendChild(d);
    if (t.coach) coachLines(box, t.coach);
    else if (t.coachError) box.appendChild(h('p', 'warn', 'Coaching failed: ' + t.coachError + '. The score above does not depend on it.'));
  }

  function coachLines(box, text) {
    box.appendChild(h('h3', null, 'Coach (' + C.COACH + ', from the scorecard only)'));
    text.replace(/\*\*|__|`/g, '').split('\n').map(function (l) { return l.replace(/^\s*([-*•]|\d+[.)])\s+/, '').trim(); }).filter(Boolean).forEach(function (l) { box.appendChild(h('p', 'tip', l)); });
  }

  // ---------- recorded takes, no sign-in ----------
  function loadRecordings() {
    return fetch('recordings/takes.json', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (rec) {
      app.rec = rec;
      var list = $('takes'); list.textContent = '';
      rec.takes.forEach(function (t, i) {
        var b = h('button', 'take' + (t.human ? ' human' : ''), (i + 1) + '. ' + t.label);
        b.type = 'button';
        b.addEventListener('click', trusted(function () { showRecorded(t); }));
        list.appendChild(b);
      });
      $('recmeta').textContent = rec.takes.length + ' takes recorded ' + rec.recordedAt.slice(0, 10) + ' with ' + rec.models.join(', ') + '. ' + (rec.takes.some(function (t) { return t.human; }) ? 'The first take is a real person on a phone; the others are synthetic voices. ' : 'The readers are synthetic voices; ') + 'The transcripts and coaching are real model replies, the score is recomputed here.';
      // Open on a real voice if there is one, else on a take where a planted slip is caught.
      if (rec.takes.length) showRecorded(rec.takes.filter(function (t) { return t.human; })[0] || rec.takes.filter(function (t) { return t.id === 't2b'; })[0] || rec.takes[0]);
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
    var coach = coachCost();
    var base = $('baseline').checked ? sp * chars + tr * Math.max(4, chars / 14) : 0; // about 14 characters a second of speech
    return tr * sec + base + coach;
  }
  function coachCost() { var co = ((app.prices || {})[C.COACH] || {}).pricing || {}; return 500 * (Number(co.promptTextTokens) || 0) + 220 * (Number(co.completionTextTokens) || 0); }
  function freeCheck() {
    if (S.words(target()).length < 2) return 'Not run: the sentence needs at least two English words.';
    var p = app.prices || {}, bad = [C.TRANSCRIBE, C.COACH].concat($('baseline').checked ? [C.SPEAK] : []).filter(function (id) { return !p[id] || p[id].paidOnly; });
    if (bad.length) return 'Not run: ' + bad.join(', ') + (app.prices ? ' is paid-only or missing from the model list today.' : ' (model list not loaded).');
    var est = estimate(C.MAX_SEC, target().length);
    if (est == null) return 'Not run: no price for these models, so the cost cannot be checked.';
    if (app.spent + est > C.CAP) return 'Not run: this visit has spent ≈ ' + fmtP(app.spent) + ' and the next take could pass the ' + fmtP(C.CAP) + ' cap. Reload the page to start a new visit.';
    return null;
  }

  function startRec() {
    if (app.busy || !app.key) return;
    var stop = freeCheck(); if (stop) return say(stop, true);
    app.busy = true; render();
    Promise.resolve().then(function () { return A.record(C.MAX_SEC); }).then(function (r) {
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
    if (f.size > 5e6) return say('That file is over 5 MB; keep uploads to ' + C.MAX_SEC + ' seconds.', true);
    app.busy = true; render();
    A.decode(f).then(function (got) {
      if (got.samples.length > A.RATE * C.MAX_SEC) throw new Error('longer than ' + C.MAX_SEC + ' s');
      run(got);
    }).catch(function (e) { app.busy = false; say('Could not read that file: ' + (e && e.message || e), true); render(); });
  }

  function run(got) {
    var t = { target: target() }, key = app.key, stop = freeCheck();
    if (!key || stop) { app.busy = false; say(key ? stop : 'Signed out: the take was not sent.', true); render(); return; }
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
    }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
    Promise.all([mine, base]).then(function (r) {
      if (!r[0].ok) { t.error = 'Transcription failed: ' + r[0].error + '. No score without a transcript.'; return; }
      t.heard = r[0].text;
      if (r[1] && r[1].ok) t.baseline = r[1].text;
      else if (r[1]) t.baselineError = r[1].error;
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

  // ---------- sing it: scored here, no sign-in; the coach is optional ----------
  var SVG = 'http://www.w3.org/2000/svg';
  function sv(tag, attrs, text) { var e = document.createElementNS(SVG, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; }
  function tune() { return C.TUNES[Number($('tune').value)] || C.TUNES[0]; }
  function written() { return P.written(tune(), Number($('key').value)); }

  function trace(sc, target, sec) {
    var Wd = 900, Ht = 220, L = 44, pad = 6;
    var ms = target.map(function (t) { return t.m + sc.shift; }), lo = Math.min.apply(null, ms) - 2, hi = Math.max.apply(null, ms) + 2;
    function X(t) { return L + (Wd - L - pad) * Math.min(1, t / sec); }
    function Y(m) { return pad + (Ht - 2 * pad) * (hi - Math.max(lo, Math.min(hi, m))) / (hi - lo); }
    var g = sv('svg', { viewBox: '0 0 ' + Wd + ' ' + Ht, class: 'trace', role: 'img', 'aria-label': 'Pitch over time: your voice as a line, the written notes as bars' });
    ms.filter(function (m, i) { return ms.indexOf(m) === i; }).forEach(function (m) {
      g.appendChild(sv('line', { x1: L, x2: Wd - pad, y1: Y(m), y2: Y(m), class: 'grid' }));
      g.appendChild(sv('text', { x: 2, y: Y(m) + 4, class: 'lbl' }, P.name(m)));
    });
    sc.ops.forEach(function (o) {
      if (o.start == null || o.i == null) return;
      g.appendChild(sv('line', { x1: X(o.start), x2: X(o.start + o.held), y1: Y(target[o.i].m + sc.shift), y2: Y(target[o.i].m + sc.shift), class: 'want ' + (o.excused ? 'excused' : o.type) }));
    });
    var d = '', pen = false;
    sc.frames.forEach(function (f) {
      if (f.m == null || f.m < lo - 1 || f.m > hi + 1) { pen = false; return; }
      d += (pen ? 'L' : 'M') + X(f.t).toFixed(1) + ' ' + Y(f.m).toFixed(1) + ' '; pen = true;
    });
    if (d) g.appendChild(sv('path', { d: d, class: 'sung' }));
    return g;
  }

  function renderSung(box, s) {
    var target = s.target, sc = s.sc;
    box.textContent = '';
    box.appendChild(h('p', 'target', s.tune + (s.label ? ' · ' + s.label : '')));
    if (!sc.voiced || !sc.sung.length) { box.appendChild(h('p', 'warn', 'No held notes were heard. Sing louder or closer, one vowel per note, each held about half a second.')); return; }
    box.appendChild(trace(sc, target, s.sec));
    var line = h('p', 'words');
    sc.ops.forEach(function (o) {
      if (o.i == null) { var x = h('span', 'n extra', '+' + P.name(o.m)); x.title = 'an extra note, not in the tune'; line.appendChild(x); return; }
      var n = h('span', 'n ' + (o.excused ? 'excused' : o.type), P.name(target[o.i].m + sc.shift));
      n.appendChild(h('small', null, o.type === 'miss' ? 'missed' : (o.cents > 0 ? '+' : '') + o.cents + '¢'));
      n.title = o.excused ? 'The pitch reader misread this note even on a clean tone with your room noise, so it is not counted.' :
        o.type === 'miss' ? 'not heard' : o.type === 'in' ? 'in tune (within ' + P.IN_TUNE + ' cents)' : o.type === 'close' ? 'close (within ' + P.CLOSE + ' cents)' : (o.cents < 0 ? 'flat' : 'sharp') + ' by ' + Math.abs(o.cents) + ' cents';
      line.appendChild(n);
    });
    box.appendChild(line);
    if (sc.checkDropped) { box.appendChild(h('p', 'warn', 'Too noisy to score: the pitch reader misread most notes even of a clean tone at your loudness in this room. Sing closer to the microphone or somewhere quieter.')); return; }
    var facts = [sc.counted ? sc.inTune + ' of ' + sc.counted + ' notes in tune' : 'no countable notes'];
    if (sc.shift) facts.push('sung ' + Math.abs(sc.shift / 12) + ' octave' + (Math.abs(sc.shift) > 12 ? 's' : '') + (sc.shift < 0 ? ' lower' : ' higher') + ' than played (fine)');
    if (sc.excluded) facts.push(sc.excluded + ' left out (the pitch reader misread them on the clean tone too)');
    if (sc.extras) facts.push(sc.extras + ' extra note' + (sc.extras > 1 ? 's' : ''));
    box.appendChild(h('p', 'facts', facts.join(' · ')));
    if (s.note) box.appendChild(h('p', 'facts', s.note));
    if (s.coach) coachLines(box, s.coach);
    else if (s.coachError) box.appendChild(h('p', 'warn', 'Coaching failed: ' + s.coachError + '. The notes above do not depend on it.'));
  }

  function coachCheck() {
    var p = app.prices || {};
    if (!app.key) return 'sign in first';
    if (!p[C.COACH] || p[C.COACH].paidOnly) return C.COACH + ' is paid-only or missing today';
    if (!coachCost()) return 'no listed price for ' + C.COACH + ', so the cost cannot be checked';
    if (app.spent + coachCost() > C.CAP) return 'this visit could pass the ' + fmtP(C.CAP) + ' cap';
    return null;
  }

  function scoreSung(got, label, note) {
    var target = written(), s = { tune: tune().name, label: label, note: note, target: target, sec: got.samples.length / got.rate };
    s.sc = P.score(got.samples, got.rate, target);
    $('singplayback').src = URL.createObjectURL(got.wav); $('singplayback').hidden = false;
    renderSung($('singresult'), s);
    var why = coachCheck();
    if (!$('singcoach').checked || !s.sc.sung.length) { app.busy = false; render(); return; }
    if (why) { say('Coach not asked: ' + why + '.', true); app.busy = false; render(); return; }
    app.ctrl = new AbortController();
    say('Asking the coach…');
    N.coach(app.key, P.messages(P.card(s.tune, target, s.sc)), app.ctrl.signal).then(function (c) {
      app.spent += coachCost();
      if (c.ok) s.coach = c.text; else s.coachError = c.error;
      say(''); renderSung($('singresult'), s);
    }).catch(function (e) { say('Something broke: ' + (e && e.message || e), true); })
      .then(function () { app.busy = false; app.ctrl = null; render(); });
  }

  function playTune() {
    stopTune();
    var x = P.synth(written(), A.RATE, { lead: 0.1 }), Ctx = window.AudioContext || window.webkitAudioContext;
    try {
      var ac = new Ctx(), b = ac.createBuffer(1, x.length, A.RATE), src = ac.createBufferSource();
      b.getChannelData(0).set(x); src.buffer = b; src.connect(ac.destination);
      src.onended = function () { ac.close(); if (app.tune === src) app.tune = null; }; src.start(); app.tune = src;
    } catch (e) { say('This browser cannot play the tune: ' + (e && e.message || e), true); }
  }

  // The singing mic has echo cancellation off, so the tune must not be playing while it records.
  function stopTune() { if (app.tune) { try { app.tune.stop(); } catch (e) { /* already ended */ } app.tune = null; } }

  // Code-made singers, so anyone can see the scoring without a microphone. Faint noise stands in for a room.
  function demo(flawed) {
    if (app.busy) return;
    var t = written(), sung = t.map(function (n, i) { return flawed && i === 2 ? { m: n.m, sec: n.sec, cents: -60 } : n; });
    if (flawed) sung.splice(3, 1);
    var x = P.synth(sung, A.RATE), seed = 1;
    for (var i = 0; i < x.length; i++) { seed = (seed * 16807) % 2147483647; x[i] += 0.004 * (seed / 2147483647 * 2 - 1); }
    app.busy = true; render();
    setTimeout(function () { // let the busy state paint before the scoring blocks the tab for a moment
      scoreSung({ samples: x, rate: A.RATE, wav: new Blob([A.wavBytes(x, A.RATE)], { type: 'audio/wav' }) },
        flawed ? 'synthetic singer, one note sung 60 cents flat, one skipped' : 'synthetic singer, every note as written',
        'A code-made voice (three harmonics with vibrato), not a person. The scoring is the same code your own take gets.');
    }, 0);
  }

  function singStart() {
    if (app.busy) return;
    stopTune();
    app.busy = true; render();
    Promise.resolve().then(function () { return A.record(C.MAX_SEC, true); }).then(function (r) {
      app.stake = r; say('Recording… sing the tune, then press Stop (' + C.MAX_SEC + ' s at most).');
      r.stopped.then(function (got) { app.stake = null; say(''); scoreSung(got, 'your take'); })
        .catch(function (e) { app.stake = null; app.busy = false; say('Something broke: ' + (e && e.message || e), true); render(); });
      render();
    }).catch(function (e) { app.busy = false; say('Microphone unavailable: ' + (e && e.message || e) + '. You can upload a recording instead.', true); render(); });
  }
  function singUpload(ev) {
    var f = ev.target.files && ev.target.files[0]; ev.target.value = '';
    if (!f || app.busy) return;
    if (f.size > 5e6) return say('That file is over 5 MB; keep uploads to ' + C.MAX_SEC + ' seconds.', true);
    app.busy = true; render();
    A.decode(f).then(function (got) {
      if (got.samples.length > A.RATE * C.MAX_SEC) throw new Error('longer than ' + C.MAX_SEC + ' s');
      scoreSung(got, 'uploaded take');
    }).catch(function (e) { app.busy = false; say('Could not read that file: ' + (e && e.message || e), true); render(); });
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
  function onKey(k) { if (k === app.key) return; app.key = k; if (!k && app.ctrl) app.ctrl.abort(); if (!k && app.take) app.take.stop(); if (!k) $('singcoach').checked = false; render(); }

  function render() {
    var signed = !!app.key, recording = !!app.take;
    $('signin').hidden = signed;
    $('rec').disabled = !signed || (app.busy && !recording);
    $('rec').textContent = recording ? 'Stop' : 'Record';
    $('rec').classList.toggle('on', recording);
    $('file').disabled = !signed || app.busy;
    var singing = !!app.stake;
    $('sing').disabled = app.busy && !singing;
    $('sing').textContent = singing ? 'Stop' : 'Sing';
    $('sing').classList.toggle('on', singing);
    ['play', 'singfile', 'demo1', 'demo2'].forEach(function (id) { $(id).disabled = app.busy; });
    $('singcoach').disabled = !signed;
    $('singcoachcost').textContent = signed ? 'about ' + fmtP(coachCost()) + ' of your Pollen' : 'needs sign-in';
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
    C.TUNES.forEach(function (t, i) { var o = h('option', null, t.name); o.value = i; $('tune').appendChild(o); });
    C.KEYS.forEach(function (k) { var o = h('option', null, k.label); o.value = k.midi; $('key').appendChild(o); });
    $('key').value = 55;
    $('play').addEventListener('click', trusted(playTune));
    $('demo1').addEventListener('click', trusted(function () { demo(false); }));
    $('demo2').addEventListener('click', trusted(function () { demo(true); }));
    $('sing').addEventListener('click', trusted(function () { if (app.stake) app.stake.stop(); else singStart(); }));
    $('singfile').addEventListener('change', trusted(singUpload));
    $('src').href = C.REPO_URL;
    wireConnect();
    N.prices().then(function (p) { app.prices = p; render(); }).catch(function (e) { say('Model list unavailable: ' + e.message, true); });
    loadRecordings();
    render();
  }
  init();
})();
