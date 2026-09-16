# MiKS

The site of afro-house artist **MiKS** — three pages, all built in vanilla
HTML/CSS/JS with no build step.

## Pages

- **`index.html` — the self-mixing home.** The tracklist on the left, a
  three.js infinity on the right. Pick a track and it plays; pick another and
  it is beat-matched and faded into the one playing — no SYNC button, no
  crossfader. Two invisible decks sit underneath ([`js/engine.js`](js/engine.js)):
  the incoming track starts on the live deck's next bar at the live tempo, both
  gains follow an equal-power curve on the audio clock over 16 beats, the bass
  swaps hands at the midpoint, then the decks trade roles and the new one glides
  back to its own tempo. When a track has 16 beats left the next row mixes in by
  itself. EQ and volume live on the master, the waveform scrubs the playing
  track. The figure ([`js/figure.js`](js/figure.js)) is built from tube paths:
  a dark occluder so crossings read over/under, metal tiles, and a swarm of
  points that a wave, locked to the beat grid, pulls dense and bright as it runs
  left to right once per bar; a mix floods the incoming track's colour in from
  the left. Every track owns one of six shapes ([`js/shapes.js`](js/shapes.js):
  infinity, three rings, triquetra as a trefoil knot, triskelion, six-pointed star,
  twin loops, the stacked figure, a ring around a sphere) and
  a mix morphs the figure into the incoming track's shape in step with the fade —
  the tiles dissolve into the swarm, fly to the new figure and re-crystallise at
  the handoff. Shapes come from the manifest's optional `shape` field, otherwise
  from list position, never the same twice in a row. Tune them by eye in
  [`tools/shapes.html`](tools/shapes.html).
- **`music.html` — new releases.** A living three.js orb whose tones repaint to
  match whichever release is playing.
- **`tour.html` — tour dates.** A half-speed video backdrop over the live schedule.

## Editing the catalogue

Drop audio files into [`tracks/`](tracks), add them to
[`tracks/manifest.json`](tracks/manifest.json), then open
[`tools/analyze.html`](tools/analyze.html) over http:// and press
**Analyse catalogue**: it runs the mixer's own beat detector over every file
that has no grid yet and prints the manifest back with `bpm`, `offset`,
`duration` and `confidence` filled in. Paste it over the manifest. Entries without
a grid still work — the homepage analyses them in the browser on first play, it
is just slower.

Optional per-entry fields: `cueBeat` (the beat a mix should enter on, for tracks
whose first onset is not a downbeat), `title`, and `shape` (one of `infinity`,
`rings`, `trefoil`, `triskelion`, `star`, `loops`, `totem`, `target`).

```bash
python3 -m http.server 8080   # then open http://localhost:8080/tools/analyze.html
```

## Credits

Design & build with Claude. Video and artwork © MiKS.
