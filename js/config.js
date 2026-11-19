/* Aloud configuration. Classic script. */
(function () {
  'use strict';
  window.AL = window.AL || {};
  window.AL.config = {
    // Public App Key (pk_...) registered for this page's address. Safe to commit.
    APP_KEY: 'pk_UPzXN2el1WEJdyPE',
    REPO_URL: 'https://github.com/patbing/aloud',
    API: 'https://gen.pollinations.ai',
    TIMEOUT_MS: 60000,
    MAX_SEC: 15,
    // Pollen this page may spend per visit (estimated from listed prices). A take that could pass it is not sent.
    CAP: 0.05,
    // Free (paid_only: false) defaults, checked against the live model list when the page loads and before every take.
    TRANSCRIBE: 'openai/whisper-large-v3',
    SPEAK: 'openai/tts-1',
    VOICE: 'alloy',
    COACH: 'openai/gpt-5.4-nano',
    // Sing it: steps are [semitones above the key note, beats]. Any octave counts; the key note sets what Play plays.
    TUNES: [
      { name: 'Five notes up', bpm: 90, steps: [[0, 1], [2, 1], [4, 1], [5, 1], [7, 2]] },
      { name: 'Up and back down', bpm: 90, steps: [[0, 1], [4, 1], [7, 1], [12, 2], [7, 1], [4, 1], [0, 2]] },
      { name: 'Twinkle, first line', bpm: 100, steps: [[0, 1], [0, 1], [7, 1], [7, 1], [9, 1], [9, 1], [7, 2]] },
      { name: 'Do-re-mi to the top', bpm: 100, steps: [[0, 1], [2, 1], [4, 1], [5, 1], [7, 1], [9, 1], [11, 1], [12, 2]] }
    ],
    KEYS: [{ label: 'Low voice (C3)', midi: 48 }, { label: 'Middle voice (G3)', midi: 55 }, { label: 'High voice (C4)', midi: 60 }],
    SENTENCES: [
      'Thirteen thin thieves thought they had thrown the thread through the thimble.',
      'A proper copper coffee pot sits on the third shelf from the left.',
      'The sixth sick sheikh\'s sixth sheep is sick.',
      'Peter Piper picked a peck of pickled peppers before the weather turned.',
      'Red lorry, yellow lorry, red lorry, yellow lorry, all the way to Worcestershire.',
      'The library rarely regularly receives rural records in February.',
      'Unique New York, you know you need unique New York.',
      'She sells sea shells by the sea shore, and the shells she sells are surely sea shells.'
    ]
  };
})();
