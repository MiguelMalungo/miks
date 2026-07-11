# MiKS

The site of afro-house artist **MiKS** — three pages, all built in vanilla
HTML/CSS/JS with no build step.

## Pages

- **`index.html` — the mixer.** Two rotating track-roulettes feed a real two-deck
  mixer. Each track is BPM-analysed in the browser; **SYNC** retunes a deck's tempo
  (pitch preserved) and phase-locks its beat grid to the other deck. EQ, beat-snapped
  loops, a pitch fader, waveform scrubbing and an equal-power crossfader round it out.
  The catalogue is everything in [`tracks/`](tracks) — one shared library both crates
  draw from. First and last track load into the two decks by default.
- **`music.html` — new releases.** A living three.js blob whose tones repaint to match
  whichever release is playing.
- **`tour.html` — tour dates.** A half-speed video backdrop over the live schedule.

## Editing the catalogue

Drop audio files into [`tracks/`](tracks) and regenerate the manifest:

```bash
cd tracks && ls *.mp3 | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin]))" > manifest.json
```

`tracks/manifest.json` is what lets the catalogue load on static hosts (GitHub Pages
has no directory listing). Locally, the dev server's listing is used as a fallback.

## Credits

Design & build with Claude. Video and artwork © MiKS.
