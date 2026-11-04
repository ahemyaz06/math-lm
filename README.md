# Math LM: an accessible maths notebook

A notebook for blind students doing maths, built for the NVDA screen reader with MathCAT and
used from the keyboard. Write notes and homework like in Word, with every equation stored as
real maths that NVDA and MathCAT read aloud. Open course PDFs and LaTeX files. Explore graphs
by sound. Hand in Word or PDF files that everyone else can open.

Everything runs on your own computer. Nothing is sent anywhere, except one question to GitHub
when you check for a newer version (below). It is a personal project of
one student, made for one calculus course first; see "What is tested and what is not" before
relying on it.

## In this README

Each section in a sentence; the details follow in the same order.

- **What is in this repository**: three folders. The notebook is the app; the two labs are parts it uses.
- **Download it (Windows)**: a setup or a portable zip from Releases, and the Windows warnings
  you will see because the app is not code-signed.
- **Running from this folder**: what to install to run it from the source code.
- **First minutes in the notebook**: the keys for writing, equations, comments, intervals,
  spelling and graphs.
- **The optional AI add-on**: only for describing pictures; how to add it.
- **What is tested and what is not**: what the automatic tests check, what has been heard with
  NVDA, and what has not been tried.
- **Privacy and safety**, **Licence**.

## What is in this repository

| Folder | What it is | Who it is for |
|---|---|---|
| [`notebook/`](notebook/README.md) | **Math Notebook**, the main app: the editor, PDF and LaTeX import, graphs, Word and PDF export, teacher mode | Students and teachers |
| [`sound-lab/`](sound-lab/README.md) | **Sound Lab**: the graph sounds and graph maths on their own, to try and tune the sounds. The notebook uses its engine. | Trying sounds; developers |
| [`recognition-lab/`](recognition-lab/README.txt) | **Recognition Lab**: reads graphs from pictures and PDF pages. The notebook uses its PDF reading. | Developers |

The notebook needs the other two folders, so keep them together.

## Download it (Windows)

**This is a beta.** The app is still being built and is updated often; things may change,
and some parts are not finished or fully tested (see "What is tested and what is not").
Help > Check for updates asks GitHub whether a newer version is out and offers its download
page; Settings > Writing can do this each time the app starts (off unless you turn it on).
Nothing is downloaded or installed by itself: a newer setup is run by you, installs over the
old one and keeps your settings.

This repository's **Releases** page has two ways to get the same app. Neither has the AI
add-on, which only matters for describing pictures.

- `Math-Notebook-Setup.exe` installs it: a Start menu shortcut, an uninstaller in
  Installed apps, and newer versions install over older ones and keep your settings. It
  installs for you only (no administrator needed) unless you choose all users.
- `Math-Notebook-portable.zip` needs no install: unzip it anywhere (even a USB stick) and run
  `Math Notebook.exe`. Its settings stay in a `data` folder beside it. `Read me first.txt`
  inside explains the rest.

The app is not code-signed, so Windows may warn before it runs the setup or the exe.
SmartScreen's "Windows protected your PC": choose "More info", then "Run anyway". An "Open
File - Security Warning" dialog ("The publisher could not be verified"): choose "Run".
`SHA256SUMS.txt` in each release lets you check that the files are the ones published.

## Running from this folder (Windows)

1. Install [Node.js](https://nodejs.org/) (version 20 or newer) and [Python 3.12](https://www.python.org/).
2. Open a terminal in this folder and run:

   ```
   npm install
   py -3.12 -m venv recognition-lab\.venv
   recognition-lab\.venv\Scripts\python.exe -m pip install -r recognition-lab\requirements.txt
   ```

3. Start the notebook: `notebook\Start Math Notebook.cmd`.
   - Sound Lab: `sound-lab\Start Sound Lab.cmd` (needs only Node.js).
   - Recognition Lab: `recognition-lab\Start Recognition Lab.cmd`.

## First minutes in the notebook (with NVDA)

- The document is one edit field, as in Word: NVDA stays in focus mode. **Alt** opens the
  menus, **F1** lists every keyboard shortcut. In a dialog, F1 or its **Help** button explains it.
- Type maths as plain text, such as `(x^2 - 4)/(x - 2)`, and press **Ctrl+Shift+E** to make it
  an equation. **Ctrl+Shift+R** reads the current line with its maths spelled out.
- **Right arrow** into an equation shows it as its plain text: the arrows move one symbol at a
  time and you can type to change it. When you leave it, it is an equation again.
- Working line by line: **Enter** after an equation starts a new line. **Shift+Enter** (or
  **F11**) copies the equation above down, ready to change.
- Comments, as in programming: anything after `#` or `//` stays words beside the equation and
  never becomes maths: `y = x^2 # the parabola`.
- Intervals, as written in class: `y = sin x, [0, 2pi]`, `y = sin x on (0, pi]`,
  `y = x^2 for 0 < x < 1`. On an equation, **Ctrl+Shift+D** adds or changes its interval. Its
  graph is then only on that interval, with solid and open dots at the ends.
- **F7** checks spelling, as in Word, with the Windows spell checker; **Alt+F7** goes to the
  next misspelled word. Equations are not checked.
- **Ctrl+Shift+G** inserts a graph. On an equation, **Ctrl+G** graphs it. In graph mode:
  - **J** and **K** step along the curve; **Space** plays it;
  - **period** and **comma** jump between points of interest (zeros, peaks, holes, corners, dots);
  - **S** says the slope, **L** the limits from the left and the right, **D** adds a soft
    second note for the slope after each step;
  - **I** describes the graph; **Escape** goes back.
- Help > Sound guide plays every sound with what it means, and has a short quiz.
- File > Import PDF or Import LaTeX (.tex) opens course files. File > Export as Word gives
  real Word equations.

The full guide is [notebook/README.md](notebook/README.md).

## The optional AI add-on

Most course PDFs (made with LaTeX) are read exactly, by rules, without any AI. A local vision
model is only for describing pictures and for pages whose maths is stored as images. It needs a
graphics card with about 8 GB of memory. Without it, everything else works.

To add it (about 6 GB of downloads, from GitHub and Hugging Face):

```
recognition-lab\.venv\Scripts\python.exe recognition-lab\download_vlm.py
recognition-lab\.venv\Scripts\python.exe recognition-lab\download_qwen35_9b.py
```

The first gets the llama.cpp runner and Qwen3-VL-8B; the second adds Qwen3.5-9B, which reads
better. Then choose the reading model in the notebook's Settings > Reading PDFs.

## What is tested and what is not

- **Automatic tests** drive the real app with key presses and check what it does and says
  in its status line. They also check the maths conversions, graphs, Word equations, PDF
  reading, the portable copy and the installed copy. They cannot hear a screen reader.
- **Heard with NVDA** by the author: writing, equations in focus and browse mode, stepping
  through an equation, intervals, graph mode and its sounds.
- **Not yet heard with NVDA**: whether the word "comment" is said before a comment, the
  Spelling box (F7), the Interval box (Ctrl+Shift+D), the setup's own pages, and the newer
  graph sounds (the instrument, beep and game voices, and "clearer pitch").
- **Tried on one computer only**: Windows 11 with NVDA, MathCAT and Access8Math, US English.
  Other screen readers (JAWS, Narrator), other languages, and macOS or Linux have not been tried.
- **Course material**: the PDF reader was built and checked on one calculus course's LaTeX
  PDFs and a few textbooks. PDFs made other ways (Word, scans) are less sure, and an
  unusual layout can be read wrongly without a warning.
- The full list is in the guide's "Limits, and what is not tested".

## Privacy and safety

- The apps listen only on this computer (127.0.0.1) and refuse requests from other websites.
- Opened documents and pasted text can never run code: they pass an allow-list cleaner.
- The app goes online only to check for a newer version: when you choose Help > Check for
  updates, or at each start if you turned that on in Settings > Writing. It asks GitHub's public
  "latest release" address once; nothing about you or your documents is sent.
- Spelling uses Windows' own spell checker on this computer; Add to dictionary adds the word
  to your Windows dictionary, which Word and Edge use too.
- Settings and read PDFs stay in `%LOCALAPPDATA%\MathNotebook`. Your own file locations (model
  files, a PDF folder) can go in `local-paths.json` in this folder; git leaves that file out.

## Licence

MIT, see [LICENSE](LICENSE). Third-party parts are listed in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
