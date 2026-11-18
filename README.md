# Aloud

[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

**Read it out, see which words came through.** Live: https://patbing.github.io/aloud/

![Aloud](docs/screenshot.png)

Pick a tongue twister or type your own sentence, then read it aloud. `openai/whisper-large-v3` writes down what it heard, with no hint of the sentence. Code lines that transcript up with the sentence word by word: heard right, heard as something else, not heard, or extra. Words per minute and pauses come from the recording itself.

The transcriber is tested too. A synthetic voice (`openai/tts-1`) reads the same sentence and the same transcriber writes it down. A word it gets wrong even from that clean reading is greyed out and not counted against you. A coach (`openai/gpt-5.4-nano`) then writes up to three tips from the scorecard only.

Without signing in you can replay recorded takes: a synthetic reader saying each sentence straight and with a planted slip, with the real transcripts and coaching from the recording run.

## Run it

Static files, no build. Serve the folder (for example `npx serve`) and open it. Sign in with Pollinations Connect to record; you pay with your own Pollen and the defaults are free-tier models. The page will not send a take that could push one visit past 0.05 Pollen (`CAP` in `js/config.js`). Tests: `npm test`.

## Files

- `js/score.js` word alignment, transcriber baseline, pauses, the coach's scorecard (pure, tested)
- `js/audio.js` microphone to 16 kHz WAV in every browser, decoding of uploads
- `js/net.js` the only file that talks to `gen.pollinations.ai`
- `tools/record.mjs` makes the recorded takes, with a spend cap

MIT licence.
