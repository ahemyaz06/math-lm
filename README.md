# Math LM: an accessible maths notebook

A notebook for blind students doing maths, built for the NVDA screen reader with MathCAT and
used from the keyboard. Write notes and homework like in Word, with every equation stored as
real maths that NVDA and MathCAT read aloud. Open course PDFs and LaTeX files. Explore graphs
by sound. Hand in Word or PDF files that everyone else can open.

Everything runs on your own computer. Nothing is sent anywhere.

## What is in this repository

| Folder | What it is | Who it is for |
|---|---|---|
| [`notebook/`](notebook/README.md) | **Math Notebook**, the main app: the editor, PDF and LaTeX import, graphs, Word and PDF export, teacher mode | Students and teachers |
| [`sound-lab/`](sound-lab/README.md) | **Sound Lab**: the graph sounds and graph maths on their own, to try and tune the sounds. The notebook uses its engine. | Trying sounds; developers |
| [`recognition-lab/`](recognition-lab/README.txt) | **Recognition Lab**: reads graphs from pictures and PDF pages. The notebook uses its PDF reading. | Developers |

The notebook needs the other two folders, so keep them together.

## The quickest start: the portable app (Windows, no setup)

Download `Math Notebook (portable).zip` from this repository's **Releases** page, unzip it
anywhere, and run `Math Notebook.exe`. It carries everything it needs. It has no AI add-on,
which only matters for describing pictures. `Read me first.txt` inside explains the rest.

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
- **Ctrl+Shift+G** inserts a graph. On an equation, **Ctrl+G** graphs it. In graph mode:
  - **J** and **K** step along the curve; **Space** plays it;
  - **period** and **comma** jump between points of interest (zeros, peaks, holes, corners, dots);
  - **I** describes the graph; **L** plays each sound with its name; **Escape** goes back.
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

## Privacy and safety

- The apps listen only on this computer (127.0.0.1) and refuse requests from other websites.
- Opened documents and pasted text can never run code: they pass an allow-list cleaner.
- Settings and read PDFs stay in `%LOCALAPPDATA%\MathNotebook`. Your own file locations (model
  files, a PDF folder) can go in `local-paths.json` in this folder; git leaves that file out.

## Licence

MIT, see [LICENSE](LICENSE). Third-party parts are listed in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
