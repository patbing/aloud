/* Aloud singing: pitch tracking (YIN), note segmentation, note-by-note comparison with the tune, and the pitch-reader check.
 * Pure functions, no network, no DOM. Works in the browser (window.AL.pitch) and in node (require).
 * Code, not a model, decides which notes were in tune. The coach model only reads the scorecard. */
(function (root) {
  'use strict';

  var NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function name(m) { var r = Math.round(m); return NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1); }
  function hz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function midi(f) { return 69 + 12 * Math.log(f / 440) / Math.LN2; }
  function median(a) { if (!a.length) return null; var s = a.slice().sort(function (x, y) { return x - y; }), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; }

  var HOP = 0.02, FMIN = 70, FMAX = 1000, W = 512, THR = 0.15;
  var IN_TUNE = 25, CLOSE = 50; // cents

  // YIN pitch every 20 ms. Frames quieter than the take's own level gate are unvoiced. Returns [{ t, m, r }]: m = MIDI float or null, r = frame loudness.
  function track(x, rate) {
    var hop = Math.round(rate * HOP), tauMax = Math.ceil(rate / FMIN), tauMin = Math.max(2, Math.floor(rate / FMAX));
    var starts = [], rms = [], s, k;
    for (s = 0; s + W + tauMax <= x.length; s += hop) {
      var e = 0; for (k = 0; k < W; k++) e += x[s + k] * x[s + k];
      starts.push(s); rms.push(Math.sqrt(e / W));
    }
    if (!starts.length) return [];
    var p95 = rms.slice().sort(function (a, b) { return a - b; })[Math.floor(rms.length * 0.95)];
    var gate = Math.max(0.005, 0.1 * p95), d = new Float64Array(tauMax + 2), out = [];
    for (var i = 0; i < starts.length; i++) {
      var t = +(i * HOP).toFixed(2);
      if (rms[i] < gate) { out.push({ t: t, m: null, r: rms[i] }); continue; }
      s = starts[i];
      for (var tau = 1; tau <= tauMax; tau++) {
        var sum = 0; for (k = 0; k < W; k++) { var df = x[s + k] - x[s + k + tau]; sum += df * df; }
        d[tau] = sum;
      }
      // Cumulative mean normalised difference; first dip under the threshold, walked down to its local minimum.
      var run = 0, best = -1; d[0] = 1;
      var cm = new Float64Array(tauMax + 1); cm[0] = 1;
      for (tau = 1; tau <= tauMax; tau++) { run += d[tau]; cm[tau] = run > 0 ? d[tau] * tau / run : 1; }
      for (tau = tauMin; tau < tauMax; tau++) {
        if (cm[tau] < THR) { while (tau + 1 < tauMax && cm[tau + 1] < cm[tau]) tau++; best = tau; break; }
      }
      if (best < 0) { out.push({ t: t, m: null, r: rms[i] }); continue; }
      var a = cm[best - 1], b = cm[best], c = cm[best + 1], den = a - 2 * b + c;
      var tf = best + (den ? (a - c) / (2 * den) : 0), f = rate / tf;
      out.push({ t: t, m: f >= FMIN && f <= FMAX ? midi(f) : null, r: rms[i] });
    }
    // A 5-frame median removes single-frame octave jumps without blurring note changes.
    return out.map(function (fr, j) {
      if (fr.m == null) return fr;
      var win = out.slice(Math.max(0, j - 2), j + 3).map(function (o) { return o.m; }).filter(function (v) { return v != null; });
      return { t: fr.t, m: median(win), r: fr.r };
    });
  }

  // Notes from frames: a run of voiced frames at one pitch. A new note starts on a pitch jump of more than JUMP semitones
  // (measured on a 9-frame average, one vibrato cycle, so vibrato does not split a note), on a dip in loudness under DIP of the
  // note's own level (two "da"s on the same pitch), or after 60 ms of silence. Runs shorter than 0.12 s (slides) are dropped.
  // The pitch is the median of the middle 60% of the run.
  var JUMP = 0.8, DIP = 0.4, MIN_FRAMES = 6;
  function notes(frames) {
    var out = [], cur = null, gap = 0, floor = 0;
    var sm = frames.map(function (f, i) {
      if (f.m == null) return null;
      var w = frames.slice(Math.max(0, i - 4), i + 5).filter(function (o) { return o.m != null; });
      return w.reduce(function (a, o) { return a + o.m; }, 0) / w.length;
    });
    function close() {
      if (cur && cur.ms.length >= MIN_FRAMES) {
        var cut = Math.floor(cur.ms.length * 0.2), mid = cur.ms.slice(cut, cur.ms.length - cut);
        out.push({ start: +(cur.i0 * HOP).toFixed(2), dur: +((cur.i1 - cur.i0 + 1) * HOP).toFixed(2), m: median(mid) });
      }
      cur = null;
    }
    frames.forEach(function (f, i) {
      if (f.m == null) { gap++; if (gap > 2) close(); return; }
      if (cur && cur.rs.length >= 3 && f.r < DIP * median(cur.rs)) { floor = DIP * median(cur.rs); close(); }
      if (!cur && f.r < floor) return; // still in the dip
      floor = 0;
      if (cur && Math.abs(sm[i] - median(cur.sm.slice(-10))) > JUMP) close();
      if (!cur) cur = { i0: i, i1: i, ms: [], sm: [], rs: [] };
      cur.ms.push(f.m); cur.sm.push(sm[i]); cur.rs.push(f.r); cur.i1 = i; gap = 0;
    });
    close();
    return out;
  }

  // Tune: { bpm, base (MIDI), steps: [[semitones above base, beats], ...] } -> [{ m, sec }].
  function written(tune, base) {
    var beat = 60 / tune.bpm;
    return tune.steps.map(function (s) { return { m: base + s[0], sec: +(s[1] * beat).toFixed(2) }; });
  }

  // Compare sung notes with the written ones. People sing in their own key, so by default the key is free: every whole-semitone
  // shift is tried, the best fit is fine-tuned to the median of its matched notes, and each note is judged against the singer's own key.
  // Alignment is by order, not by clock, so a slow or uneven tempo is not a pitch mistake. ops: in | close | off | miss | extra.
  function align(target, sung, shift) {
    var n = target.length, k = sung.length, D = [], i, j;
    function cost(a, b) { return Math.min(2, Math.abs(sung[b].m - shift - target[a].m)); }
    for (i = 0; i <= n; i++) { D[i] = [i]; }
    for (j = 0; j <= k; j++) D[0][j] = j;
    for (i = 1; i <= n; i++) for (j = 1; j <= k; j++) D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + cost(i - 1, j - 1));
    var ops = [];
    i = n; j = k;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && Math.abs(D[i][j] - (D[i - 1][j - 1] + cost(i - 1, j - 1))) < 1e-9) {
        var c = Math.round((sung[j - 1].m - shift - target[i - 1].m) * 100), ac = Math.abs(c);
        ops.push({ type: ac <= IN_TUNE ? 'in' : ac <= CLOSE ? 'close' : 'off', i: i - 1, cents: c || 0, held: sung[j - 1].dur, start: sung[j - 1].start });
        i--; j--;
      } else if (i > 0 && D[i][j] === D[i - 1][j] + 1) { ops.push({ type: 'miss', i: i - 1 }); i--; }
      else { ops.push({ type: 'extra', m: sung[j - 1].m - shift, held: sung[j - 1].dur }); j--; }
    }
    return { ops: ops.reverse(), shift: shift, cost: D[n][k] };
  }
  function compare(target, sung, shift) {
    if (shift != null) return align(target, sung, shift);
    if (!sung.length) return align(target, sung, 0);
    var guess = median(sung.map(function (s) { return s.m; })) - median(target.map(function (t) { return t.m; })), best = null;
    for (var s = -36; s <= 36; s++) {
      var r = align(target, sung, s);
      if (!best || r.cost < best.cost - 1e-9 || (Math.abs(r.cost - best.cost) < 1e-9 && Math.abs(s - guess) < Math.abs(best.shift - guess))) best = r;
    }
    var off = best.ops.filter(function (o) { return o.cents != null; }).map(function (o) { return o.cents / 100; });
    return off.length ? align(target, sung, Math.round((best.shift + median(off)) * 100) / 100 || 0) : best;
  }

  // A sung-like tone: three harmonics, 5.5 Hz vibrato of +-vib semitones, 30 ms fades. notes: [{ m, sec, cents? }].
  function synth(list, rate, opts) {
    opts = opts || {};
    var vib = opts.vibrato == null ? 0.15 : opts.vibrato, amp = opts.amp || 0.3, gapSec = opts.gap == null ? 0.08 : opts.gap;
    var lead = Math.round(rate * (opts.lead == null ? 0.3 : opts.lead)), total = lead;
    list.forEach(function (nt) { total += Math.round(rate * (nt.sec + gapSec)); });
    var x = new Float32Array(total + lead), o = lead, ph = 0;
    list.forEach(function (nt) {
      var len = Math.round(rate * nt.sec), fade = Math.round(rate * 0.03);
      for (var q = 0; q < len; q++) {
        var m = nt.m + (nt.cents || 0) / 100 + vib * Math.sin(2 * Math.PI * 5.5 * q / rate);
        ph += 2 * Math.PI * hz(m) / rate;
        var env = Math.min(1, q / fade, (len - q) / fade);
        x[o + q] = amp * env * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph)) / 1.75;
      }
      o += len + Math.round(rate * gapSec);
    });
    if (opts.noise) for (var p = 0; p < x.length; p++) x[p] += opts.noise[p % opts.noise.length];
    return x;
  }

  // The quietest 0.3 s of the take: the room the pitch reader had to listen through.
  function roomNoise(x, rate) {
    var len = Math.round(rate * 0.3), step = Math.round(rate * 0.05), best = 0, bestE = Infinity;
    if (x.length <= len) return new Float32Array(x);
    for (var s = 0; s + len <= x.length; s += step) {
      var e = 0; for (var k = s; k < s + len; k++) e += x[k] * x[k];
      if (e > 0 && e < bestE) { bestE = e; best = s; }
    }
    return x.slice(best, best + len);
  }

  // The pitch-reader check: the same reader, on a clean tone of the written tune in the singer's octave with the take's own room noise.
  // Written notes it cannot read in tune even then are left out of the score. If it fails on most notes, the check is ignored instead.
  // amp: the tone is as loud as the singer was, so a quiet take in a loud room is checked at its own signal-to-noise ratio.
  function check(target, shift, noise, rate, amp) {
    var ref = synth(target.map(function (t) { return { m: t.m + shift, sec: t.sec }; }), rate, { noise: noise, amp: amp });
    var r = compare(target, notes(track(ref, rate)), shift), bad = {};
    r.ops.forEach(function (o) { if (o.i != null && o.type !== 'in') bad[o.i] = true; });
    var nBad = Object.keys(bad).length;
    return nBad * 2 > target.length ? { dropped: true, bad: {} } : { dropped: false, bad: bad };
  }

  // Everything in one call: frames, notes, comparison, check, counts.
  function score(samples, rate, target) {
    var frames = track(samples, rate), sung = notes(frames), cmp = compare(target, sung);
    var loud = frames.map(function (f) { return f.r; }).sort(function (a, b) { return a - b; });
    // The synth's rms is about 0.46 of its amp.
    var amp = loud.length ? Math.min(0.9, Math.max(0.01, loud[Math.floor(loud.length * 0.95)] / 0.46)) : 0.3;
    var chk = check(target, cmp.shift, roomNoise(samples, rate), rate, amp);
    var counted = 0, inTune = 0, excluded = 0;
    cmp.ops.forEach(function (o) {
      if (o.i == null) return;
      if (chk.bad[o.i]) { o.excused = true; excluded++; return; }
      counted++; if (o.type === 'in') inTune++;
    });
    return { frames: frames, sung: sung, ops: cmp.ops, shift: cmp.shift, counted: counted, inTune: inTune, excluded: excluded, checkDropped: chk.dropped,
      extras: cmp.ops.filter(function (o) { return o.type === 'extra'; }).length, voiced: frames.some(function (f) { return f.m != null; }) };
  }

  // Everything the coach may know. No audio.
  function card(tuneName, target, sc) {
    return {
      tune: tuneName,
      key: Math.abs(sc.shift) < 0.5 ? 'as played' : Math.abs(sc.shift).toFixed(1) + ' semitones ' + (sc.shift < 0 ? 'lower' : 'higher') + ' than played (fine: each note is judged in the key they chose)',
      notes: sc.ops.filter(function (o) { return o.i != null; }).map(function (o) {
        var t = target[o.i];
        return { note: name(t.m + sc.shift), result: o.excused ? 'not counted' : o.type === 'miss' ? 'missed' : o.type === 'in' ? 'in tune' : o.type, cents: o.cents == null ? null : o.cents, held_s: o.held == null ? null : o.held, written_s: t.sec };
      }),
      extra_notes: sc.extras,
      in_tune: sc.inTune,
      counted: sc.counted
    };
  }

  var COACH_RULES = 'You coach someone singing a short tune. You only know the scorecard below, measured by code, not by you. ' +
    'cents is how far each sung note was from the written one: negative is flat, positive is sharp; within 25 is in tune, 26 to 50 close, more is off. ' +
    'Do not invent notes or numbers it does not list. Plain text, no markdown. Write at most three short tips, one per line, each naming the exact note (like E4) and its number. ' +
    'If every counted note is in tune, say so in one line and give one tip on holding notes for their written length.';

  function messages(c) { return [{ role: 'system', content: COACH_RULES }, { role: 'user', content: 'Scorecard:\n' + JSON.stringify(c) }]; }

  var api = { name: name, hz: hz, midi: midi, median: median, track: track, notes: notes, written: written, compare: compare, synth: synth,
    roomNoise: roomNoise, check: check, score: score, card: card, messages: messages, COACH_RULES: COACH_RULES, IN_TUNE: IN_TUNE, CLOSE: CLOSE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.AL = root.AL || {}; root.AL.pitch = api; }
})(typeof window !== 'undefined' ? window : this);
