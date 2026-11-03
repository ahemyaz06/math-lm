# Calculus Stereo Sound Lab — Origin, Design Rationale, and Purpose

**Date:** 25 October 2026  
**Location:** `%USERPROFILE%\Desktop\graphing\sound-lab`  
**Status:** Standalone Calculus Audio Prototype (`v0.2.0`)

> **IMPORTANT PROJECT ROADMAP & REMINDER (DO NOT FORGET):**
> 1. **Order of Work:** Focus on perfecting **Sound Lab** and **Recognition Lab** first. Leave `GTool` alone for now.
> 2. **Rewrite `GTool` as a Block-Based Math Editor (Not an Inspector):** When we return to `GTool`, do **not** keep extending it as a 2D coordinate inspector. Rewrite it into a **Block-Based Calculus Math Editor** (an *editor* instead of an *inspector*, where functions, derivatives, tangents, and integrals are structured blocks) powered by the `Sound Lab` audio engine and fed by `Recognition Lab`.
> 3. **Target Form Factor:** Package the final environment as a **Standalone Application** (not a heavy inside-NVDA add-on, so heavy CV/PDF/audio work never freezes NVDA).

---

## 1. How Sound Lab Came About (Summary of Our Design Conversation)

Sound Lab grew out of a critical look at what worked—and what did not work—in our earlier accessible graphing tools (`GTool` and `Recognition Lab`) when applied to real **Calculus** coursework for a totally blind student.

### The Core Problem We Identified with Standard Audio Graphing
Most accessible graphing tools rely on **continuous smooth pitch sweeps** (mapping $X$ to left/right stereo pan and $Y$ to a sliding oscillator frequency from low to high) combined with screen-reader coordinate announcements on every move. Through real use, several fundamental flaws stood out:

1. **You Cannot Read Exact Numbers from a Smooth Sliding Pitch:**
   Stereo panning and pitch clearly tell you which quadrant you are in ($X < 0$ vs. $X > 0$, and $Y < 0$ vs. $Y > 0$) and whether a curve is generally going up or down. However, without musical ear training, a smooth sliding wave cannot tell you *how many units* you moved horizontally or *what exact value* $Y$ reached.
2. **Smooth Waves Alone Smear Slope ($\Delta y / \Delta x$):**
   In a single continuous glide, horizontal travel ($\Delta x$) and vertical change ($\Delta y$) blur together. You cannot feel when you have moved $0.5$ or $1.0$ unit to the right.
3. **Disconnected Pulses Alone Lose the Continuous Line:**
   Conversely, playing *only* isolated step notes every $0.5$ or $1.0$ unit makes the points feel disconnected when moving or stopping.
4. **Auditory Fatigue and Screen-Reader Collision:**
   Harsh synthesizer tones tire the ears and talk directly over NVDA speech when the screen reader tries to announce coordinates on every step.

---

## 2. The Breakthrough Architecture: Two-Layer "Singer + Dark Bass Outline" System

Through iterative live ear-testing, we arrived at a **two-layer musical architecture** (similar to a lead singer or instrument stepping over a continuous dark background bass line):

### Layer 1: The Continuous Dark Bass Outline (The "Living Thread" During Continuous Playback)
- A warm, dark, low-register bass tone ($55\text{–}210\text{ Hz}$, low-pass filtered below $210\text{ Hz}$) plays in the background **during continuous Auto-Play (`A` / `Space`)** and **stops automatically as soon as the graph finishes or pauses** (and stays off during manual `J`/`K` single-stepping, when you are inspecting individual steps rather than following a continuous line).
- As you step or auto-play, it glides smoothly in stereo pan and low bass pitch so your ears always feel:
  1. **Continuous connection between points** (the points are no longer floating in dead silence).
  2. **Whether you are moving forward or backward in $X$** (rising as you move forward, lowering as you move backward).
  3. **Open Holes / Discontinuities:** When you land on an Open Point ($\circ$, a missing point/hole on the curve), the background bass outline dips its volume by 85% so you literally feel the thread drop out at the hole.
- **Selectable Background Bass Modes in Settings (or press `B` in the Sound Pad):**
  - `Combined (Default)`: Tracks both forward/backward $X$ movement and curve $Y$ contour.
  - `Horizontal X Only`: Rises purely as $X$ moves forward ($-X \to +X$) and lowers as $X$ moves backward.
  - `Curve Y Only`: Acts as a dark bass mirror of the curve's height $Y$.
  - `Off`: Plays only the foreground step pulses with no continuous hold.

### Layer 2: Stepped Foreground Pulses Every $0.5$ or $1.0$ Units
- Riding on top of the dark bass outline, every $0.5$ or $1.0$ unit step in $X$ fires a clear foreground pulse:
  - **Below Zero ($Y < 0$):** Warm low-register pulse ($85\text{–}220\text{ Hz}$).
  - **Zero Line ($Y = 0$):** Balanced center marimba tone ($330\text{ Hz}$).
  - **Above Zero ($Y > 0$):** Clear treble/bell pulse ($440\text{–}1,600\text{ Hz}$), wrapped in **10-unit octave gears** so steep curves never squeak.
- **Selectable Foreground Sound Profiles in Settings:**
  Because different listeners find different timbres comfortable, Settings (`S`) offers four instrument profiles:
  1. `Warm Acoustic (Marimba & Glass Bell)` *(Default)*
  2. `Soft Synth Wave (Pure & Gentle)`
  3. `Crisp Piano / Pluck (Clear Step Attack)`
  4. `High-Contrast Bass vs. Tin (Sharp Split)`

### Optional Landmark Sound Cues (Toggle On/Off with `C`)
- Can be turned completely Off or On at any time (`C` key or in Settings).
- When enabled, at most one subtle acoustic cue layers onto a step without delaying the rhythm:
  - **Origin $(0,0)$ / Axis Crossing:** Soft wooden center-detent tick.
  - **Peak (Local Max) / Valley (Local Min):** Gentle harmonic fifth swell on the step note.
  - **Solid Point ($\bullet$):** Firm acoustic wood tap (mark/unmark with `P`).
  - **Open Point / Hole ($\circ$):** Background bass dips out + soft hollow air breath (mark/unmark with `H`, or auto-detected on rational holes like $y = \frac{x^2 - 4}{x - 2}$).

---

## 3. Edge Cases Handled

- **Anti-Clipping Master Limiter (`DynamicsCompressorNode`):** Prevents audio distortion when the continuous dark bass outline, foreground step pulse, and landmark cue play simultaneously.
- **Rapid Key-Repeat Protection:** Holding down `J`/`K` or `Left`/`Right` throttles step creation to at most once every `85 ms` and smoothly ducks the previous step note so notes never pile up into mud.
- **Automatic Silence When Leaving the Pad:** Pressing `Escape`, opening Settings (`S`), focusing the Equation input (`N`), or switching browser tabs automatically fades out the continuous background bass hold.
- **Extreme / Non-Finite Values:** Clamps all frequencies to safe audible ranges (`55 Hz .. 1,600 Hz`) and guards against `NaN`/`Infinity`.

---

## 4. What Sound Lab Will Be Used For

1. **Immediate Use in Calculus Classes and Homework:**
   - Entering calculus functions to feel continuous curve shape, forward/backward direction, sign intervals ($Y < 0$ vs. $Y > 0$), rate of change ($\Delta y$ per $0.5$/$1.0$ step), peaks/valleys, and open holes vs. solid points without NVDA speech overload.
2. **Core Audio Engine for Our Next Planned Modules:**
   - **Block-Based Calculus Math Editor:** Pairing this sound engine with a structured block editor where functions, derivatives ($f'$), tangent lines, and area slices between curves ($\int (f - g)\,dx$) are organized as navigable blocks with exact numbers.
   - **Laptop Touchpad Exploration & Drawing:** Using the laptop touchpad to trace and sketch curves with the same Dark Bass Outline + Stepped Pulse feedback.
   - **Bridge from `Recognition Lab`:** Exploring curves extracted from textbook images and PDFs with the same two-layer sound engine.
