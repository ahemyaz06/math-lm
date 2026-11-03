# Math Notebook

An accessible maths notebook for blind students, built for NVDA and MathCAT and keyboard first.
It works like Word: notes and answers in one editable document, where every equation is real
maths that NVDA and MathCAT read. Graphs are explored by sound.

- Type maths as plain text (`(x^2 - 4)/(x - 2)`) and turn it into an equation. Convert between
  plain text, LaTeX and MathML. All conversions are rules, not AI.
- Open course PDFs and LaTeX (.tex) files. Equations become real maths and pgfplots graphs
  become graphs you can explore.
- Graph mode: step along a function and hear its height as pitch and its x position in stereo.
  Zeros, peaks, valleys, holes, jumps, asymptotes, corners and dots each have their own sound,
  and every point can be read out.
- Export to Word (real Word equations) and to PDF. Teacher mode makes student copies.
- Everything runs on your computer. The AI add-on, which describes pictures, is optional.

The full guide is in [notebook/README.md](notebook/README.md).

## Setup (Windows)

1. Install [Node.js](https://nodejs.org/) and [Python 3.12](https://www.python.org/).
2. In this folder:

   ```
   npm install
   py -3.12 -m venv recognition-lab\.venv
   recognition-lab\.venv\Scripts\python.exe -m pip install -r recognition-lab\requirements.txt
   ```

3. Double-click `notebook\Start Math Notebook.cmd`.

## Licence

MIT, see [LICENSE](LICENSE). Third-party parts: [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
