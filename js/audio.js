/* Aloud audio: microphone to 16 kHz mono PCM, WAV encoding, decoding of uploaded or synthesised audio.
 * One PCM path for every browser, so iOS (mp4) and Chrome (webm) recordings never differ. Nothing is uploaded except to the transcriber. */
(function (root) {
  'use strict';
  var RATE = 16000;

  // Resample to 16 kHz. Downsampling averages each output window (a crude low-pass) so s, sh and th do not alias.
  function resample(x, from) {
    if (from === RATE) return Float32Array.from(x);
    var n = Math.floor(x.length * RATE / from), out = new Float32Array(n), r = from / RATE, i;
    if (r > 1) {
      for (i = 0; i < n; i++) {
        var a = Math.floor(i * r), b = Math.min(x.length, Math.max(a + 1, Math.floor((i + 1) * r))), s = 0;
        for (var k = a; k < b; k++) s += x[k];
        out[i] = s / (b - a);
      }
      return out;
    }
    for (i = 0; i < n; i++) {
      var p = i * r, j = Math.floor(p), t = p - j;
      out[i] = (x[j] || 0) * (1 - t) + (x[j + 1] || 0) * t;
    }
    return out;
  }

  // 16-bit PCM WAV bytes.
  function wavBytes(samples, rate) {
    var n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) { var s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return new Uint8Array(buf);
  }

  function ctx() { var A = root.AudioContext || root.webkitAudioContext; return new A(); }

  // Start recording; resolves to { stop() -> Promise<{ samples, rate, wav }>, level() }.
  function record(maxSec) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.reject(new Error('this browser gives no microphone access here'));
    return navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }).then(function (stream) {
      var ac;
      try { ac = ctx(); } catch (e) { stream.getTracks().forEach(function (t) { t.stop(); }); throw e; }
      // Called inside the click, not awaited: a resume that never settles must not hang the page.
      ac.resume();
      try {
        var src = ac.createMediaStreamSource(stream);
        // shortcut: ScriptProcessorNode is deprecated but works in every browser without a separate worklet file; move to AudioWorklet if browsers drop it.
        var node = ac.createScriptProcessor(4096, 1, 1), chunks = [], total = 0, peak = 0, done = null;
        var limit = Math.round(ac.sampleRate * maxSec);
        node.onaudioprocess = function (e) {
          var d = e.inputBuffer.getChannelData(0);
          if (total >= limit) { if (done) return; return finish(); }
          chunks.push(new Float32Array(d)); total += d.length;
          var m = 0; for (var i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i])); peak = m;
        };
        src.connect(node); node.connect(ac.destination); // the output buffer is never written, so nothing is played back
        var wall = setTimeout(function () { finish(); }, (maxSec + 1) * 1000); // in case the audio callback stalls
        var resolveStop;
        var stopped = new Promise(function (r) { resolveStop = r; });
        function finish() {
          if (done) return done;
          clearTimeout(wall);
          node.disconnect(); src.disconnect();
          stream.getTracks().forEach(function (t) { t.stop(); });
          var all = new Float32Array(total), o = 0;
          chunks.forEach(function (c) { all.set(c, o); o += c.length; });
          var rate = ac.sampleRate;
          ac.close();
          var samples = resample(all, rate);
          done = { samples: samples, rate: RATE, wav: new Blob([wavBytes(samples, RATE)], { type: 'audio/wav' }) };
          resolveStop(done);
          return done;
        }
        return { stop: function () { finish(); return stopped; }, stopped: stopped, level: function () { return peak; } };
      } catch (e) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        ac.close();
        throw e;
      }
    });
  }

  // Any audio blob (uploaded file, TTS reply, recorded take) to 16 kHz mono samples.
  function decode(blob) {
    var ac = ctx();
    return blob.arrayBuffer().then(function (b) {
      return new Promise(function (ok, bad) { ac.decodeAudioData(b, ok, bad); });
    }).then(function (buf) {
      var ch = buf.numberOfChannels, n = buf.length, mono = new Float32Array(n);
      for (var c = 0; c < ch; c++) { var d = buf.getChannelData(c); for (var i = 0; i < n; i++) mono[i] += d[i] / ch; }
      var samples = resample(mono, buf.sampleRate);
      return { samples: samples, rate: RATE, wav: new Blob([wavBytes(samples, RATE)], { type: 'audio/wav' }) };
    }).finally(function () { ac.close(); });
  }

  var api = { RATE: RATE, resample: resample, wavBytes: wavBytes, record: record, decode: decode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.AL = root.AL || {}; root.AL.audio = api; }
})(typeof window !== 'undefined' ? window : this);
