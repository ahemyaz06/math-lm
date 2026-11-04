# Sound Lab

The graph sounds of Math Notebook on their own: type a function, then step along it and hear it.
Use it to try the sound profiles, or to work on the sounds without the whole notebook.

## Start

Double-click `Start Sound Lab.cmd` (needs Node.js). It opens http://127.0.0.1:4180/ in your
browser. Press **S** for settings and **?** for the keys.

## How a graph sounds

- **Step notes:** each step plays a note for the curve's height. Below zero it is a warm low
  note, at zero a middle note, above zero a clear bell. Above 10 units the pitch starts again
  from low, and a small tick marks the change. Each note slides from the last one's pitch,
  so going up is a short rise and going down a short fall.
- **Sounds to choose from:** calm sounds, instruments (piano, guitar, harp, marimba, kalimba,
  vibraphone, flute, cello), beeps and game sounds. Every one uses the same pitch for the same
  height. In Math Notebook, Settings > Graph sound plays each one as you move through the list.
- **The bass line:** while playing (Space), a soft low line follows the curve, so the steps
  feel connected.
- **Points of interest:** a chime at the origin, a tick where the curve crosses an axis, a swell
  at peaks and valleys, a low knock where there is no curve (an asymptote).
- **Dots and corners:** a small bump for a solid dot, a breath of wind for an open dot (a hole),
  and a slide through a sharp corner (down then up for a valley, up then down for a peak).
  In Math Notebook, Settings > Graph sound > Dots and corners can switch back to the original
  dot sounds.

## Files

- `public/sound-engine.js`: the sounds (Web Audio). The notebook uses this file.
- `public/voices.js`: the instrument, beep and game voices for the step notes.
- `public/graph-math.js`: reading a function and finding its zeros, peaks, holes and asymptotes.
  The notebook uses this file too.
- `public/app.js`, `index.html`, `styles.css`: Sound Lab's own page.
- `server.mjs`: a small local server for the page (only on this computer).
- `SOUND-LAB-REPORT.md`: how the sound design came about and why.
