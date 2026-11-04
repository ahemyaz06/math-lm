# Math Notebook 0.5

A document editor for maths that works like Word: your notes and answers in one
editable document, PDFs converted into it with every equation as real maths, export to
Word and PDF, and graphs you explore by sound with Sound Lab's engine. Everything runs on
this computer. The AI is an add-on: without it everything except reading pictures works.

## Start

Double-click `Start Math Notebook.cmd`. A window opens with the cursor in an empty
document. Everything is in the menu bar (Alt: File, Edit, Insert, Format, Table, Math,
Graph, Review, Teacher, Settings, Help), as in Word, and the most used commands are also
buttons on the toolbar above the document, each with its name written on it. The toolbar is
one Tab stop: the arrow keys move along it, and F6 goes between the toolbar and the document.
F1 opens the keyboard shortcuts page (made from the menus, so it is always right).

Needs: Recognition Lab's Python environment and `npm install` in the main folder
(for the window). The reading model is optional (see "The AI add-on").

## The portable version (no AI, nothing to install)

`recognition-lab\.venv\Scripts\python.exe notebook\build_portable.py` makes
`dist\Math Notebook\` and `dist\Math Notebook (portable).zip` (about 230 MB). Unzip it
anywhere on a 64-bit Windows PC and double-click `Math Notebook.exe`: it carries its own
Python and the window, and keeps its settings and read PDFs in a `data` folder beside
the exe. It is this same notebook without the AI add-on; `Read me first.txt` inside
explains it.
## Writing (the keys are Word's)

- Type normally. Ctrl+B, Ctrl+I, Ctrl+U: bold, italic, underline (the status line says
  "Bold on" or "off"). Ctrl+Alt+1, 2, 3 make headings of level 1, 2, 3 (NVDA says the
  same level); Ctrl+Alt+0 normal text.
- Ctrl+Shift+L bulleted list, Ctrl+Shift+7 numbered list; Tab and Shift+Tab move an item
  in and out a level; Enter on an empty item ends the list.
- Insert > Table: columns, rows, header row. Tab and Shift+Tab move between cells; Tab in
  the last cell adds a row. The Table menu adds and deletes rows and columns.
- Ctrl+Enter: page break. Ctrl+F find (Enter goes to the match), F3 and Shift+F3 find
  again, Ctrl+H replace (one, or all). Review > Word count.
- Ctrl+PageDown and Ctrl+PageUp: next and previous heading; Ctrl+Shift+H lists the
  headings. With these you can move around while typing, without NVDA's browse mode.
- Pasting from a web page keeps headings, lists, tables, bold and italic, and its MathML
  becomes real equations; styles, scripts and pictures are left out. Ctrl+Shift+V pastes
  plain text. The Applications key on a misspelled word lists corrections.
- Ctrl+S saves a `.mathnb` notebook. File > Export as Word document (Ctrl+Shift+W):
  every equation is a real Word equation, so Word, NVDA and MathCAT read it as maths;
  Word itself is not needed for this. File > Export as PDF makes a tagged PDF with the
  headings as bookmarks (equations in PDFs are hard for screen readers, so share Word
  files where you can). Ctrl+P prints.

## Moving around without changing NVDA's mode

The document is one edit field, as in Word, so NVDA stays in focus mode while you type.
Nothing is forced: NVDA+Space still switches to browse mode. To move without switching:
Ctrl+PageDown and Ctrl+PageUp go to the next and previous heading, Ctrl+Shift+H lists the
headings, F8 goes to the next review note, Ctrl+F finds text, and Ctrl+Shift+R reads the
current line with equations spelled out.

## Maths

- Type maths as plain text, for example `(x^2 - 4)/(x - 2)` or `sqrt(x+1)`, then press
  Ctrl+Shift+E: the line (or your selection) becomes a real equation.
- Alt+= inserts an equation. Enter on an equation line, or Ctrl+E next to an equation,
  edits it as plain text; inside, Ctrl+L switches between plain text and LaTeX.
- Ctrl+Shift+M converts between plain text, LaTeX and MathML, in any direction. The
  result updates as you type; a preview below it can be read with MathCAT; Enter copies
  the result and "Insert as equation" puts it in the document.
- Ctrl+Shift+R reads the current line with equations spelled out as plain text.
  Ctrl+Shift+T turns an equation back into plain text.
- All conversions are rules, not AI (`web/equation.js`, `web/mathml.js`). The Word
  equations were checked in Word itself against Microsoft's own converter on 119
  equations (`test-fixtures/math/latex-cases.txt`).

## LaTeX files (.tex)

File > Import LaTeX (.tex) reads a LaTeX source file, the file a teacher makes the PDF from.
It holds the exact maths, so nothing has to be recognised: sections become headings, inline
and display maths become equations (each row of an align its own line), itemize and enumerate
become lists with their parts, tabular becomes a table, bold and italic stay, and the file's own
\newcommand definitions are expanded. Graphs drawn with pgfplots (\addplot) become graphs you
explore by sound (pgfplots measures sin and cos in degrees unless deg() is used; this is
followed). TikZ drawings of functions (`\draw plot (\x, {formula})`) become graphs too: each
plot is a piece of the function, the axes drawn through 0 give the window, and `\node at
(x,y) {$\circ$}` or `{\textbullet}` are its open and solid dots. Other pictures and TikZ
drawings are named, not shown. Whatever could not be read is a
review note at the end (F8).

Asking a professor for the .tex files is a small request: they already have them, and
the result is exact. `test-fixtures/math/homework.tex` is a sample.

## Sharing documents: PDF and Word, nothing special

Nobody else needs this app. Hand in or send what everyone opens: File > Export as PDF or as
Word document. An exported PDF carries the notebook inside it as a standard PDF attachment
(the paperclip in Adobe Reader; e-invoices carry their data the same way). Every PDF reader
shows and prints it as usual; when Math Notebook imports that PDF, it opens the document
inside it exactly (equations, graphs with sound) instead of reading the printed page.

## Teacher mode

For a TA, a tutor or disability services making a worksheet, or for making your own
practice: Teacher > Teacher mode. Then:

- Teacher > Hide this line from students (Ctrl+Shift+F9) marks a whole line (a hint, a
  worked solution). Hide the selected words (Ctrl+F9) blanks words in a line: the student
  copy shows ______ there.
- Teacher > Insert answer box: write the answer in it; students get the box empty.
- Teacher > Graph for students (on a graph line): hide the formula (students get the curve's
  points and find the function), and any of the zeros, the y-intercept, peaks and valleys,
  holes and dots, asymptotes. Hidden points are not announced in graph mode either.
- Teacher > Preview student copy shows exactly what students get (read only); its graphs
  sound as the students' will.
- Teacher > Save student copy, or export the student copy as Word or PDF. The hidden parts
  are taken out of these files, not just hidden: a graph whose formula is hidden keeps only
  points along its curve. The teacher's own file is the answer key and reopens in Teacher mode.

## Graphs

- Ctrl+G on an equation in the document graphs it, LaTeX or plain text, piecewise functions
  (\begin{cases}) too. The graph line is put under the equation and graph mode opens.
- Insert > Graph from equations (Ctrl+Shift+G): one function per line, plain text or LaTeX,
  or pgfplots code pasted from a .tex file. The x range covers every hole and jump unless you
  give one; the y range is fitted to the graph.
- The description says where the graph crosses the axes, its peaks and valleys, holes,
  vertical asymptotes, and for piecewise functions each row and what happens where rows meet,
  in the course's words: a jump, or a hole (removable discontinuity) with the point elsewhere.
- Graph > Copy graph as LaTeX gives pgfplots code that draws the same graph in a .tex file.
- The Graph menu also has every graph mode action (play, next point, describe, step size).

## Converting a PDF

File > Import PDF (Ctrl+Shift+I; Ctrl+I is italic, as in Word). Pages are added at the end of the document as they finish; you
can keep working.

How a page is read is chosen in Settings > Reading PDFs:

- **Automatic** (the default): course PDFs made with LaTeX keep every character with its
  font, size and position, so the page is rebuilt from them by rules, without AI
  (`pdf_text_reader.py`): exponents are the smaller raised characters, fractions are what
  sits above and below a thin rule, square roots are a radical sign with a rule from its
  top, piecewise definitions are a tall brace, and so on. It cannot invent anything and
  takes about 0.07 seconds a page (101 course pages: 7.5 seconds). The 9-page
  Continuity notes are read in about 3 seconds instead of 41. Pictures keep their place
  in the document ("Picture 1 on page 1: its description is on the way") and wait in a
  queue for the AI, two at a time; each description replaces its placeholder when it
  arrives, and you can import another PDF meanwhile. Graphs drawn by LaTeX are still read
  exactly from the PDF, with no AI. Pages whose maths is not stored as text (scans, or
  textbooks such as OpenStax that draw formulas as shapes) go to the AI as before.
- **Text from the PDF only**: never asks the AI to read a page; such pages say why they
  were not read.
- **AI reads every page**: the earlier way, checked against the PDF's text (below). The
  model starts loading as soon as the file dialog opens and two pages are read at a time:
  a 15-page lecture took about 80 seconds.

Pages read by text have no checker notes (their text is the PDF's own); a review note
there means the text reader met something it could not place, such as an unknown symbol.
Changing the setting affects PDFs imported afterwards; pages already in the document stay.

- Blank pages (nothing but a page number) are marked "This page is blank." without asking
  the AI: asked about a blank page, it invented equations.
- Pages with no text in the PDF (scans, pictures of pages) cannot be checked; their page
  heading gets a review note saying so.
- If the AI starts repeating itself, it is stopped at once and the page is read again with
  anti-repetition sampling; if that fails too, the page says where the copy stops. Each page gets a level-1 heading,
each problem a level-2 heading, and an empty answer line under each problem.

- On pages the AI reads, equations are copied by the local model Qwen3.6-35B-A3B and then compared, character by
  character, with the text built into the PDF. Where they differ, the line gets a review
  note (underlined). F8 and Shift+F8 go to the next and previous note and read it; Review >
  Remove review note clears it once you have fixed the line. Example from real homework:
  the model wrote "f and q" where the PDF has "f and g".
- Graphs drawn by LaTeX are read exactly from the PDF (corners, peaks, zeros, dots, dashed
  lines, blank answer grids). Pasted pictures get an AI description marked "may be wrong".

## Settings

The Settings menu (Alt, then S) has three small dialogs: Reading PDFs (Ctrl+comma), AI
add-on, and Graph sound. Tab moves between the choices, Enter saves, Escape cancels. Restore defaults puts
everything back. Settings are saved in `%LOCALAPPDATA%\MathNotebook\settings.json`.

- The AI add-on: "Use the AI add-on" switches it off and on (first in the dialog). Off, the
  notebook works exactly as without the add-on and its choices are hidden. Not installed
  (no model launcher or reading model on this computer, or MATH_NOTEBOOK_NO_AI=1): one
  line says so and PDFs are read by rules only.
- Reading PDFs (from Recognition Lab and the reader): how pages are read (above);
  describe pictures with AI; estimate numbers from graph pictures; the reading model;
  a second model that re-reads AI pages with review notes; pages read at the same time.
- Graph sound (from Sound Lab): sound profile (Gentle by default), the bass line while
  playing (x and height, x only, height only, off), the step, playing speed, sounds for
  points of interest, step volume, bass volume.
- Moving freely: tones when the arrow keys land on a curve,
  a dot or the origin. With them off, the position is still read.

## Graph mode

Enter on a graph line (or Ctrl+G) opens graph mode; Escape returns to the same place.
Insert > Graph from equations (Ctrl+Shift+G) makes a graph from functions you type.

- K and J: step along the current function. The coordinate is read when you stop.
- Arrow keys: move freely, without the bass line. When you land on a curve its tone plays
  and the coordinate says "on" that function. C puts you back on the function.
- Space: play along the function with the bass line; Space again stops and reads the point.
- Tab and Shift+Tab: next and previous function.
- Period and comma: next and previous point of interest (peaks, zeros, corners, dots).
- Home and End: ends of the function. V reads the point, I describes the graph,
  F changes the step (0.1, 0.25, 0.5, 1), question mark lists the keys.
- Numbers are said rounded to the nearest half (a height of 4.19 is "4", a zero at 1.73 is
  "1.5", 0.00004 is "0"); where you are along x is said as you stepped. Settings > Graph sound >
  Numbers you hear can choose one decimal or exact. The document's own text stays exact.
- A graph drawn in a worksheet (TikZ) keeps only what the page shows: the curve, its points
  and dots, not its formula.
- Sounds: the gentle profile (soft attacks), a small bump for solid dots, a breath of wind
  for open dots (holes), a slide through sharp corners (down then up for a valley corner,
  up then down for a peak), a chime at the origin. At a jump both dots are heard, each at its
  own height. Settings > Graph sound > Dots and corners can switch back to the original
  held tone and air breath. The Progress beep profile plays one beep per step whose pitch
  climbs from the bottom of the graph to the top, softer below zero.

## The reading model

On 8 real course pages (29 Oct 2026), four local models were compared by how often the
checker found real copying errors: Qwen3-VL-8B 3, Qwen3.5-9B 2, Chandra OCR 2 one broken
page, Qwen3.6-35B-A3B none. Qwen3.6-35B-A3B is the default: by default its files are in
`recognition-lab\models\qwen3.6-35b-a3b` and it runs on a CUDA llama.cpp build in
`recognition-lab\bin\llama-cuda`; other locations go in `local-paths.json` in the main folder
(see `recognition-lab\vlm_helper.py`). Part of the model stays in system memory (needs about 8 GB VRAM and 16 GB free RAM). At
start-up it puts as many expert layers on the graphics card as fit in the free memory,
so close other programs that use the graphics card before importing a PDF.
Another model can be chosen in Settings > Reading PDFs (the environment variable
MATH_NOTEBOOK_MODELS sets the default).

## Limits

- How NVDA and MathCAT read equations inside the editable document (focus mode) has not
  been tested with real speech; Ctrl+Shift+R and editing an equation as plain text always work.
- Undo (Ctrl+Z) undoes typing and formatting, but not equations, tables, lists or page
  breaks inserted by commands, nor Replace.
- Vertical lines are described but not traced (they are not functions of x).
- Drawing graphs is not built yet (planned as its own lab). Font sizes, colours and
  alignment are not offered.
- pgfplots plots from tables, files or parametric coordinates, and TikZ drawings, are not
  read from .tex files; they are named in a review note.
- The older browser page (`/` instead of the desktop app) still works but is not developed further.


## Third-party files

`web/vendor/temml.mjs` and `Temml-Latin-Modern.css`: Temml 0.14.0, MIT licence
(`TEMML-LICENSE.txt`). `latinmodernmath.woff2`: Latin Modern Math, GUST font licence.
Electron (MIT) is installed by npm.
