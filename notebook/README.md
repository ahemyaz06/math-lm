# Math Notebook

A document editor for maths that works like Word: your notes and answers in one
editable document, PDFs converted into it with every equation as real maths, export to
Word and PDF, and graphs you explore by sound with Sound Lab's engine. Everything runs on
this computer. The AI is an add-on: without it everything except reading pictures works.
The version is in Help > About; Help > Check for updates asks GitHub if a newer one is out.

## In this guide

Each part in a sentence; the details follow in the same order.

- **Start**: how to open it, the menus, the toolbar and F1.
- **The portable version** and **The installed version**: the two downloads, where each keeps
  your settings, and how they are built.
- **Writing**: Word's keys for text, lists, tables, find, spelling (F7) and saving.
- **Moving around without changing NVDA's mode**: headings, notes and find while in focus mode.
- **Maths**: typing equations, moving through one symbol at a time, copying the one above
  (Shift+Enter), comments (`#`, `//`), intervals (`[0, 2pi]`, Ctrl+Shift+D), conversions.
- **LaTeX files (.tex)**: importing a teacher's source file exactly, graphs included.
- **Sharing documents**: Word and PDF out; a PDF from the notebook opens back exactly.
- **Teacher mode**: hiding lines, words, answers and parts of graphs for a student copy.
- **Graphs**: graphing an equation (on its interval, if it has one) and what is described.
- **Converting a PDF**: how pages are read (rules, or the optional AI) and review notes.
- **Settings**: what each Settings dialog holds.
- **Graph mode**: every key for exploring a graph by sound, and the sounds.
- **The reading model**: the optional AI model and what it needs.
- **Limits, and what is not tested**: what does not work yet, and what has not been heard
  with NVDA or tried at all.

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
## The installed version (a Windows setup)

`recognition-lab\.venv\Scripts\python.exe notebook\build_release.py` makes both release
files at once: `dist\Math-Notebook-portable.zip` and `dist\Math-Notebook-Setup.exe` (with
[Inno Setup 6](https://jrsoftware.org/isinfo.php); its script is `notebook\installer\MathNotebook.iss`),
plus `dist\SHA256SUMS.txt`. The setup holds the same files as the portable version and
an `INSTALLED` marker: the installed copy never writes beside its exe, and keeps its
settings, read PDFs and window files in `%LOCALAPPDATA%\MathNotebook`, as the full app
does. It installs for the current user by default (no administrator prompt), with all
users as a choice. A newer setup upgrades in place and keeps the data; uninstalling asks
whether to keep it (yes by default; `/REMOVEDATA` removes it in a silent uninstall). The
version is set once, in `notebook\VERSION`, and shown in Help > About.
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
- Spelling, as in Word: F7 goes through the words that are not in the dictionary, from the
  cursor on. Each is said with its line; choose a suggestion with the arrows and press Enter
  to change it, or Tab to Change all, Ignore once, Ignore all, Add to dictionary. A doubled
  word (the the) can be deleted. Change to takes a word of your own. Alt+F7 jumps to the next
  misspelled word without the box and says its suggestions. It is the Windows spell checker,
  the same one that draws the red underlines, so Add to dictionary teaches Word and Edge too.
  Equations and graph descriptions are not checked, nor maths names written as words
  (sin, ln, arcsin).
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
- Alt+= inserts an equation. Ctrl+E next to an equation (or Enter before an equation on its
  own line) edits it as plain text; inside, Ctrl+L switches between plain text and LaTeX.
- Working line by line: Enter after an equation starts a new line, always. Shift+Enter (or
  F11) copies the last equation above the cursor down (onto this line if it is empty, otherwise
  onto a new line below), ready to change.
- Moving through an equation: Right arrow into an equation (or Left into it from after it)
  shows it as its plain text, `f(x) = 3 sin(x), x in [0, pi]`, so the arrows move one symbol at
  a time and you can type to change it. When the cursor leaves it, it is an equation again,
  exactly as it was if you changed nothing; Enter there also finishes it and starts a new line.
  If what you typed is not maths, it stays as text and the notebook says why. Settings > Writing
  can turn this off (then the arrows go past an equation in one step).
- Letters in equations are given to NVDA as plain letters (x, not the maths letter 𝑥, which
  Chromium uses for italics and NVDA reads as "x normalized"). They still look italic.
- Comments, as in programming: anything after `#` or `//` is a comment and never becomes
  maths. Type `y = x^2 # the parabola` and press Ctrl+Shift+E: `y = x^2` is the equation and
  `# the parabola` stays as words beside it. The same works in the equation box (Alt+=) and
  in the graph box. In LaTeX text `%` starts a comment too, as in a .tex file (`\%` is the
  percent sign). Enter, F11 and Ctrl+G treat a line with a comment like a line that ends with
  its equation: the comment is never copied or graphed. A comment (also one you type yourself
  after an equation) is marked as one and shown in grey italics, and the word "comment" is
  given to the screen reader before it (it is not shown). In browse mode a comment after an
  equation that has its own line is read on the next line.
- Intervals: write where an equation applies after it, the way your class writes it:
  `y = sin x, [0, 2pi]`, `y = sin x on [0, 2pi)`, `y = tan x, x in (-pi/2, pi/2)`,
  `y = x^2, [0, inf)`, `y = x^2 for 0 < x < 1` or `y = x^2 {0 < x < 1}`. A square bracket
  keeps that end, a round one leaves it out. Or put the cursor on an equation and press
  Ctrl+Shift+D (Math > Interval for the equation): type `[0, 2pi]`, `(0, pi]`, `0 to 2pi`
  or `0 < x <= pi`; an empty box takes the interval away. The equation shows it as
  x ∈ [0, 2π], and its graph is only on that interval.
- Ctrl+Shift+M converts between plain text, LaTeX and MathML, in any direction. The
  result updates as you type; a preview below it can be read with MathCAT; Enter copies
  the result and "Insert as equation" puts it in the document.
- Ctrl+Shift+R reads the current line with equations spelled out as plain text.
  Ctrl+T (or Ctrl+Shift+T) turns an equation back into plain text, Ctrl+L into its LaTeX
  text; Ctrl+Shift+E makes either one an equation again.
- In focus mode NVDA reads only the start of an equation (MathCAT reads it whole in browse
  mode, NVDA+Space). So when the cursor comes to an equation, the notebook says it as plain
  text ("Equation: x = log(3^x)"). Settings > Writing can turn this off.
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
(x,y) {$\circ$}` or `{\textbullet}` are its open and solid dots; two labelled functions on the
same axes (`node{$f(x)$}`, `node{$g(x)$}`) stay two functions. In pgfplots graphs, open and solid
dots (drawn with `\fill ... circle`, or with the file's own styles such as `holdot`), dashed
lines (a dashed vertical line is how a page shows an asymptote) and arrowheads (the curve goes
on) are read too. The exam class works: each `\question` is a heading with its points, parts
and choices are lists, and solutions are left out unless the file prints answers. An empty
axis is said as an empty grid to draw on. Other pictures and TikZ drawings are named, not
shown. One mistake in the file (a `{` never closed, an environment never ended) loses only that
part, never the whole file. Whatever could not be read is a review note at the end (F8).

Asking a professor for the .tex files is a small request: they already have them, and
the result is exact. `test-fixtures/math/homework.tex` is a sample.

## Sharing documents: PDF and Word, nothing special

Nobody else needs this app. Hand in or send what everyone opens: File > Export as PDF or as
Word document. An exported PDF carries the notebook inside it as a standard PDF attachment
(the paperclip in Adobe Reader; e-invoices carry their data the same way). Every PDF reader
shows and prints it as usual; when Math Notebook imports that PDF, it opens the document
inside it exactly (equations, graphs with sound) instead of reading the printed page.

File > Export as braille (BRF) makes a braille ready file for an embosser or a braille display,
with BrailleBlaster (free, from the American Printing House: brailleblaster.org), which has to be
installed. The notebook hands it the document with every equation as MathML; BrailleBlaster
translates it with its own settings. For Nemeth maths, choose UEB with Nemeth in BrailleBlaster's
Translation settings; the notebook says which standard was used. Open BrailleBlaster once before
the first export: its first start asks you to accept its licence. The way of making the braille
follows Owen Petronick's Braille Check.

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
- A function with an interval (y = sin x, [0, 2pi), see Maths) is graphed only there, with a
  solid dot at an end it keeps and an open dot at an end it leaves out. The window fits the
  interval (here x from -0.35 to 7) instead of -5 to 5. Piecewise rows can use intervals too
  (x^2 & x \in [0, 1)), and pgfplots code keeps them as domain=0:6.28.
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

**Checking each equation against the page (optional, needs Tectonic).** With
[Tectonic](https://tectonic-typesetting.github.io/) installed, every equation read from a page
is typeset again and compared with that place on the page: the same characters in the same
order, raised or lowered alike, the same characters under each fraction bar and root. When an
equation does not match, readings close to it are tried (an exponent read as a subscript, a
root or fraction one character too long or short, a mark set over an equals sign), and one is
kept only if it matches the page exactly; otherwise the reading stays as it was. The switch is
Settings > Reading PDFs, "Check each equation" (on; it does nothing without Tectonic).
Tectonic is not included with Math Notebook. To use the check, install it yourself
([installing Tectonic](https://tectonic-typesetting.github.io/book/latest/installation/), or
the Windows zip from its [releases](https://github.com/tectonic-typesetting/tectonic/releases))
and either put `tectonic.exe` on your PATH, set the environment variable `TECTONIC` to its
full path, or (running from this folder) put it in `tools\tectonic\tectonic.exe` beside the
`notebook` folder. The first time it typesets, Tectonic downloads the TeX packages it needs
from its own servers (once; they are kept in its cache). Tried with Tectonic 0.17.0: on 868
equations from one calculus course's LaTeX PDFs, 863 matched their page as read, 1 was
corrected (an "=?" read as "= to the power ?"), and the other 4 were real misreadings it
caught but could not correct (left as read). It slows reading down: seconds per page, more
when an equation has to be corrected.

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

The Settings menu (Alt, then S) has small dialogs: Reading PDFs (Ctrl+comma), Writing, AI
add-on, and Graph sound. Tab moves between the choices, Enter saves, Escape cancels. Restore defaults puts
everything back. Settings are saved in `%LOCALAPPDATA%\MathNotebook\settings.json`.

- The AI add-on: "Use the AI add-on" switches it off and on (first in the dialog). Off, the
  notebook works exactly as without the add-on and its choices are hidden. Not installed
  (no model launcher or reading model on this computer, or MATH_NOTEBOOK_NO_AI=1): one
  line says so and PDFs are read by rules only.
- Reading PDFs (from Recognition Lab and the reader): how pages are read (above);
  describe pictures with AI; estimate numbers from graph pictures; the reading model;
  a second model that re-reads AI pages with review notes; pages read at the same time.
- Writing: the arrow keys go into an equation and step through it as plain text; an equation
  is said when the cursor comes to it (both on by default); check for a newer version when
  the app starts (off by default). The check asks GitHub's public "latest release" address once
  and, if a newer version is out, a message box offers its download page. Nothing is
  downloaded or installed by itself. Without internet the check at start says nothing;
  Help > Check for updates says why it could not check.
- Graph sound (from Sound Lab): the sound (Gentle by default; also instruments, beeps and game
  sounds, each heard as you move through the list, and Listen plays a whole example), clearer
  pitch (notes slide from the last height; off is the original sound), the slope sound, the bass
  line while playing (x and height, x only, height only, off), the step, playing speed, sounds
  for points of interest, step volume, bass volume. The Sound guide button there (also in the
  Help menu) plays every sound with what it means, and a quiz: play a mystery sound, then
  choose what it was.
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
- S: the slope where you are ("slope 2, rising", "flat", "vertical"); at a corner both
  sides' slopes, at a jump "the curve jumps here". On a graph drawn on a page (no formula) it is
  an estimate ("about").
- L: the limits from the left and the right and the value there, then what that means:
  continuous, a hole, a jump, a vertical asymptote, or the curve is only on one side.
- D: the slope sound on or off. After each step's note comes a soft second note for the slope,
  on the same pitch scale as heights: high is rising, the middle note is flat, low is falling.
  At a peak or a valley it passes the middle note. Settings > Graph sound can have it on from
  the start.
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

## Limits, and what is not tested

The automatic tests drive the real app with key presses and check what it does and what it
says in its status line. They cannot hear NVDA. What has been heard with NVDA so far, and what
has not:

- Heard and fixed: equations in focus mode said "normalized" on letters (fixed); stepping
  through an equation with the arrows works; intervals look right.
- Not yet heard with NVDA: whether NVDA says the word "comment" before a comment (it did not
  say the comment role itself, so the word was added for it); the Spelling box (F7) and
  Alt+F7; the Interval box (Ctrl+Shift+D); the Windows setup's own pages (whether its first
  "install for me or for all users" question reads its choices as buttons, the Welcome text,
  the checkboxes, and the uninstaller's "keep your data?" question); the newer graph sounds
  (instruments, beeps, game sounds, and "clearer pitch", which is on by default).
- Checking equations with Tectonic: tested with Tectonic 0.17.0 on one Windows computer, on
  LaTeX-made PDFs only (it compares with TeX's own fonts, so PDFs made with Word or scanned
  are not checked usefully). Tectonic is not bundled with the app or the setup. The check
  cannot see a mistake that splits one equation into pieces on separate lines (each piece
  matches its own place), and an equation it cannot correct stays as read, without a
  warning.
- With Access8Math as NVDA's maths voice, square brackets can be spoken in Chinese. That is
  in Access8Math's own English dictionary, not in the notebook; choosing MathCAT as the
  speech source in Access8Math's settings avoids it.
- Updates: the app only tells you about a newer version; you download and run the setup (or
  unzip the new portable copy) yourself. Its message box has not been heard with NVDA. The
  tests use a stand-in for GitHub, not the real site.
- Spelling: Add to dictionary is not run by the tests, because it writes to your real
  Windows dictionary (the one Word uses too). Only the language Windows uses for you is
  checked (US English if Windows has no spell checker for it). A document in another
  language, or mixing languages, has not been tried.
- Intervals: `y = 2x, (1, 2)` (round brackets straight after a comma) is not taken as an
  interval, because it could be a point; write `on (1, 2)` or `x in (1, 2)`. Only intervals of
  x are understood (not of y or t), and only one interval per equation.
- Comments: a `#` or `//` always starts a comment beside an equation; there is no way to
  write those signs as maths. Everything after the sign, to the end of the line, is the
  comment, even maths.
- Stepping through an equation shows it as plain text. Equations from PDFs with LaTeX that
  plain text cannot say exactly (matrices, unusual symbols) come back exactly only if you
  change nothing; if you change them, they are rebuilt from the plain text.
- Undo (Ctrl+Z) undoes typing and formatting, but not equations, tables, lists or page
  breaks inserted by commands, nor Replace, nor Spelling changes, nor stepping into an
  equation.
- Vertical lines are described but not traced (they are not functions of x).
- Drawing graphs is not built yet (planned as its own lab). Font sizes, colours and
  alignment are not offered.
- pgfplots plots from tables, files or parametric coordinates, and TikZ drawings that are not
  graphs of functions, are not read from .tex files; they are named in a review note.
- Braille: tried with BrailleBlaster 3.2.5 on the sample homework (UEB, and UEB with Nemeth); the
  automatic tests use a stand-in. A piecewise function is brailled one piece to a line, because
  BrailleBlaster makes the rows of a cases into an 8-dot cell an embosser cannot make; other
  tables in maths (matrices) can still give one, and the notebook then says on which lines. The
  braille was read back by a program on seven LaTeX files, which found missing list numbers (fixed);
  it has not been checked by a braille reader yet. BrailleBlaster must have been opened once
  (its licence and first questions) before the notebook can use it.
- Graphs: `1e-9` is not read as a number (it could also mean 1 times e, minus 9); write
  `10^(-9)`. floor, ceiling, round, max and min cannot be graphed yet.
- PDFs: the labels inside a drawn figure (y, y = f(x), (b, f(b))) can come out as separate
  short equations before the text when the figure is not found as a graph.
- The older browser page (`/` instead of the desktop app) still works but is not developed further.


## Third-party files

`web/vendor/temml.mjs` and `Temml-Latin-Modern.css`: Temml 0.14.0, MIT licence
(`TEMML-LICENSE.txt`). `latinmodernmath.woff2`: Latin Modern Math, GUST font licence.
Electron (MIT) is installed by npm.
