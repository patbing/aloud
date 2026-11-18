/* Aloud scoring: pure functions, no network, no DOM. Works in the browser (window.AL.score) and in node (require).
 * The scorer, not a model, decides which words were right. The coach model only reads the scorecard. */
(function (root) {
  'use strict';

  var NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

  var ORD = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth',
    'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth'];

  // Lowercase words, apostrophes dropped (sheikh's = sheikhs: you cannot hear the difference), 0-20 and 1st-20th spelled out.
  function words(s) {
    return String(s || '').toLowerCase().replace(/[‘’']/g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/-/g, ' ')
      .split(/\s+/).filter(Boolean)
      .map(function (w) {
        var m = /^(\d+)(st|nd|rd|th)?$/.exec(w);
        if (!m || Number(m[1]) > 20) return w;
        return (m[2] ? ORD : NUM)[Number(m[1])];
      });
  }

  function charDist(a, b) {
    var prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }

  // Word-level edit alignment. ops: ok | sub | miss (target word not heard) | extra (heard, not in target).
  function align(target, heard) {
    var T = words(target), H = words(heard), n = T.length, m = H.length, d = [], i, j;
    for (i = 0; i <= n; i++) { d[i] = [i]; }
    for (j = 0; j <= m; j++) d[0][j] = j;
    for (i = 1; i <= n; i++) for (j = 1; j <= m; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (T[i - 1] === H[j - 1] ? 0 : 1));
    }
    var ops = [];
    i = n; j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (T[i - 1] === H[j - 1] ? 0 : 1)) {
        var same = T[i - 1] === H[j - 1];
        var op = { type: same ? 'ok' : 'sub', want: T[i - 1], got: H[j - 1], i: i - 1 };
        if (!same && T[i - 1].length >= 4 && charDist(T[i - 1], H[j - 1]) <= 1) op.close = true;
        ops.push(op); i--; j--;
      } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { ops.push({ type: 'miss', want: T[i - 1], i: i - 1 }); i--; }
      else { ops.push({ type: 'extra', got: H[j - 1] }); j--; }
    }
    return { target: T, heard: H, ops: ops.reverse() };
  }

  // baseline: what the same transcriber heard from a clean synthetic reading of the target.
  // Target words it got wrong even then are marked asr and left out of the score: the transcriber, not the reader, missed them.
  function score(target, heard, baseline) {
    var a = align(target, heard), asr = {}, dropped = false;
    if (typeof baseline === 'string') {
      var b = align(target, baseline).ops, bad = b.filter(function (o) { return o.type !== 'ok' && o.i != null; });
      // A clean reading that comes back mostly wrong says nothing about single words: ignore it rather than excuse everything.
      if (bad.length * 2 > a.target.length) dropped = true;
      else bad.forEach(function (o) { asr[o.i] = o.type; });
    }
    var right = 0, counted = 0, excused = 0;
    a.ops.forEach(function (o) {
      if (o.i == null) return;
      // A word the reader skipped is only excused if the clean reading lost it the same way; a mis-heard word is not a skipped one.
      if (asr[o.i] && !(o.type === 'miss' && asr[o.i] !== 'miss')) { o.asr = true; excused++; return; }
      counted++; if (o.type === 'ok') right++;
    });
    return {
      ops: a.ops, total: a.target.length, counted: counted, right: right,
      accuracy: counted ? right / counted : null,
      extras: a.ops.filter(function (o) { return o.type === 'extra'; }).length,
      asrWords: excused,
      baselineDropped: dropped
    };
  }

  // Speech span and pauses from mono samples: 20 ms frames, a level threshold, silences of at least minPause inside speech.
  function pauses(samples, rate, minPause) {
    minPause = minPause || 0.35;
    var f = Math.max(1, Math.round(rate * 0.02)), rms = [], i, k;
    for (i = 0; i + f <= samples.length; i += f) {
      var s = 0; for (k = i; k < i + f; k++) s += samples[k] * samples[k];
      rms.push(Math.sqrt(s / f));
    }
    if (!rms.length) return { speechSec: 0, pauses: [], start: 0 };
    var sorted = rms.slice().sort(function (a, b) { return a - b; });
    var p95 = sorted[Math.floor(sorted.length * 0.95)];
    var thr = Math.max(0.006, 0.12 * p95);
    var voiced = rms.map(function (r) { return r >= thr; });
    var first = voiced.indexOf(true), last = voiced.lastIndexOf(true);
    if (first < 0) return { speechSec: 0, pauses: [], start: 0 };
    var out = [], run = 0;
    for (i = first; i <= last; i++) {
      if (!voiced[i]) { run++; continue; }
      if (run * 0.02 >= minPause) out.push({ at: +((i - run) * 0.02).toFixed(2), len: +(run * 0.02).toFixed(2) });
      run = 0;
    }
    return { speechSec: +((last - first + 1) * 0.02).toFixed(2), pauses: out, start: +(first * 0.02).toFixed(2) };
  }

  // Words actually said: target words not missed, plus extras. Pace is measured on these, not on the target.
  function spoken(sc) { return sc.ops.filter(function (o) { return o.type !== 'miss'; }).length; }

  function wpm(nWords, speechSec) { return speechSec > 0 ? Math.round(nWords / speechSec * 60) : null; }

  // Everything the coach may know. No audio, no transcript beyond the aligned words.
  function card(target, sc, timing) {
    return {
      target: target,
      words: sc.total,
      right: sc.right,
      counted: sc.counted,
      transcriber_misses_excluded: sc.asrWords,
      mistakes: sc.ops.filter(function (o) { return o.type !== 'ok' && !o.asr; }).map(function (o) {
        return o.type === 'extra' ? { kind: 'extra', heard: o.got } : { kind: o.type === 'miss' ? 'missed' : (o.close ? 'close' : 'swapped'), word: o.want, heard: o.got || null };
      }),
      words_per_minute: timing ? wpm(spoken(sc), timing.speechSec) : null,
      pauses: timing ? timing.pauses.map(function (p) { return p.len; }) : []
    };
  }

  var COACH_RULES = 'You coach someone reading a sentence aloud in English. You only know the scorecard below, measured by code, not by you. ' +
    'Do not invent mistakes or pauses it does not list. Plain text, no markdown. Write at most three short tips, one per line, each naming the exact word or number it is about. ' +
    'Pace above 170 words per minute is fast, below 110 slow; pauses over 0.8 s inside a sentence break the flow. If there are no mistakes, say so in one line and give one pace tip.';

  function messages(c) {
    return [{ role: 'system', content: COACH_RULES }, { role: 'user', content: 'Scorecard:\n' + JSON.stringify(c) }];
  }

  var api = { words: words, align: align, score: score, pauses: pauses, spoken: spoken, wpm: wpm, card: card, messages: messages, COACH_RULES: COACH_RULES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.AL = root.AL || {}; root.AL.score = api; }
})(typeof window !== 'undefined' ? window : this);
