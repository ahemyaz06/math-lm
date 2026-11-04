// Math Notebook desktop window: a real Windows menu bar (Alt), file dialogs, and the
// local reader server started in the background. Everything stays on this computer.
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const NOTEBOOK = path.join(__dirname, '..');
// The portable version carries its own Python next to the notebook folder and has no AI.
const PORTABLE_PYTHON = path.join(NOTEBOOK, '..', 'python', 'python.exe');
const PORTABLE = fs.existsSync(PORTABLE_PYTHON) && fs.existsSync(path.join(NOTEBOOK, 'PORTABLE'));
const PYTHON = PORTABLE ? PORTABLE_PYTHON : path.join(NOTEBOOK, '..', 'recognition-lab', '.venv', 'Scripts', 'python.exe');

// Portable: settings and read PDFs live in a "data" folder beside Math Notebook.exe, so the
// folder can be carried on a USB stick; if that folder cannot be written, the usual place is used.
function portableData() {
  const folder = path.join(path.dirname(process.execPath), 'data');
  try {
    fs.mkdirSync(folder, { recursive: true });
    fs.accessSync(folder, fs.constants.W_OK);
    return folder;
  } catch {
    return null;
  }
}
let server = null;
let serverUrl = null;
let win = null;
// Automated tests set MATH_NOTEBOOK_TEST=1: the window stays hidden and closes without
// the save question, so test runs never interrupt the person using the computer.
const TESTING = process.env.MATH_NOTEBOOK_TEST === '1';
let allowClose = TESTING;

function startServer() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PYTHON)) {
      reject(new Error(PORTABLE ? `The Python inside Math Notebook is missing at ${PYTHON}. Unzip the whole folder again.`
        : `Recognition Lab's Python is missing at ${PYTHON}. See recognition-lab\\README.txt.`));
      return;
    }
    const env = { ...process.env, MATH_NOTEBOOK_PORT: '0', PYTHONIOENCODING: 'utf-8' };
    if (PORTABLE) {
      env.MATH_NOTEBOOK_NO_AI = '1';
      const data = process.env.MATH_NOTEBOOK_DATA || portableData();
      if (data) env.MATH_NOTEBOOK_DATA = data;
    }
    server = spawn(PYTHON, ['server.py'], { cwd: NOTEBOOK, windowsHide: true, env });
    const timer = setTimeout(() => reject(new Error('The reader did not start within 60 seconds.')), 60000);
    let log = '';
    server.stdout.on('data', (chunk) => {
      const m = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    server.stderr.on('data', (chunk) => { log = (log + chunk).slice(-4000); });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`The reader stopped (code ${code}). ${log}`)); });
  });
}

const send = (command) => () => win?.webContents.send('command', command);

function buildMenu() {
  // The same menus and keys as Word wherever Word has them.
  const template = [
    { label: '&File', submenu: [
      { label: '&New', accelerator: 'Ctrl+N', click: send('new') },
      { label: '&Open notebook…', accelerator: 'Ctrl+O', click: send('open') },
      { label: '&Import PDF…', accelerator: 'Ctrl+Shift+I', click: send('importPdf') },
      { label: 'Import &LaTeX (.tex)…', click: send('importTex') },
      { type: 'separator' },
      { label: '&Save', accelerator: 'Ctrl+S', click: send('save') },
      { label: 'Save &as…', accelerator: 'Ctrl+Shift+S', click: send('saveAs') },
      { type: 'separator' },
      { label: 'Export as &Word document…', accelerator: 'Ctrl+Shift+W', click: send('exportDocx') },
      { label: 'Export as P&DF…', click: send('exportPdf') },
      { label: 'Export as w&eb page…', click: send('exportHtml') },
      { label: '&Print…', accelerator: 'Ctrl+P', click: send('print') },
      { type: 'separator' },
      { label: 'E&xit', role: 'quit' },
    ] },
    { label: '&Edit', submenu: [
      { role: 'undo', label: '&Undo' }, { role: 'redo', label: '&Redo' }, { type: 'separator' },
      { role: 'cut', label: 'Cu&t' }, { role: 'copy', label: '&Copy' }, { role: 'paste', label: '&Paste' },
      { label: 'Paste as plain te&xt', accelerator: 'Ctrl+Shift+V', click: send('pastePlain') },
      { role: 'selectAll', label: 'Select &all' },
      { type: 'separator' },
      { label: '&Find…', accelerator: 'Ctrl+F', click: send('find') },
      { label: 'Find &next', accelerator: 'F3', click: send('findNext') },
      { label: 'Find pre&vious', accelerator: 'Shift+F3', click: send('findPrevious') },
      { label: '&Replace…', accelerator: 'Ctrl+H', click: send('replace') },
      { type: 'separator' },
      { label: 'Next &heading', accelerator: 'Ctrl+PageDown', click: send('nextHeading') },
      { label: 'Previous h&eading', accelerator: 'Ctrl+PageUp', click: send('previousHeading') },
      { label: 'Headings &list…', accelerator: 'Ctrl+Shift+H', click: send('headingList') },
    ] },
    { label: '&Insert', submenu: [
      { label: '&Equation…', accelerator: 'Alt+=', click: send('insertEquation') },
      { label: '&Table…', click: send('insertTable') },
      { label: '&Graph from equations…', accelerator: 'Ctrl+Shift+G', click: send('insertGraph') },
      { label: 'Page &break', accelerator: 'Ctrl+Enter', click: send('pageBreak') },
    ] },
    { label: 'F&ormat', submenu: [
      { label: '&Bold', accelerator: 'Ctrl+B', click: send('bold') },
      { label: '&Italic', accelerator: 'Ctrl+I', click: send('italic') },
      { label: '&Underline', accelerator: 'Ctrl+U', click: send('underline') },
      { type: 'separator' },
      { label: 'Heading level &1', accelerator: 'Ctrl+Alt+1', click: send('heading1') },
      { label: 'Heading level &2', accelerator: 'Ctrl+Alt+2', click: send('heading2') },
      { label: 'Heading level &3', accelerator: 'Ctrl+Alt+3', click: send('heading3') },
      { label: '&Normal text', accelerator: 'Ctrl+Alt+0', click: send('normalText') },
      { type: 'separator' },
      { label: 'Bu&lleted list', accelerator: 'Ctrl+Shift+L', click: send('bulletList') },
      { label: 'Nu&mbered list', accelerator: 'Ctrl+Shift+7', click: send('numberedList') },
    ] },
    { label: 'T&able', submenu: [
      { label: '&Insert table…', click: send('insertTable') },
      { label: 'Add &row below', click: send('tableAddRow') },
      { label: 'Add &column to the right', click: send('tableAddColumn') },
      { label: '&Delete row', click: send('tableDeleteRow') },
      { label: 'D&elete column', click: send('tableDeleteColumn') },
      { label: 'Delete &table', click: send('tableDelete') },
    ] },
    { label: '&Math', submenu: [
      { label: '&Edit equation', accelerator: 'Ctrl+E', click: send('editEquation') },
      { label: '&Convert line or selection to equation', accelerator: 'Ctrl+Shift+E', click: send('toEquation') },
      { label: 'Convert equation to &plain text', accelerator: 'Ctrl+T', click: send('toPlainText') },
      { label: 'Convert equation to LaTe&X text', accelerator: 'Ctrl+L', click: send('toLatexText') },
      { label: 'Copy the equation above &down', accelerator: 'F11', click: send('copyEquationDown') },
      { label: 'Convert between plain text, &LaTeX and MathML…', accelerator: 'Ctrl+Shift+M', click: send('convertMath') },
      { label: '&Read line with equations spelled out', accelerator: 'Ctrl+Shift+R', click: send('readLine') },
    ] },
    { label: '&Graph', submenu: [
      { label: '&Explore graph by sound', accelerator: 'Ctrl+G', click: send('exploreGraph') },
      { label: '&New graph from equations…', click: send('insertGraph') },
      { label: '&Copy graph as LaTeX (pgfplots)', click: send('copyGraphLatex') },
      { type: 'separator' },
      { label: '&Play or stop (Space in graph mode)', click: send('graphPlay') },
      { label: 'Ne&xt point of interest (period)', click: send('graphNextPoint') },
      { label: 'Pre&vious point of interest (comma)', click: send('graphPreviousPoint') },
      { label: 'Next &function (Tab)', click: send('graphNextFunction') },
      { label: '&Read the point (V)', click: send('graphReadPoint') },
      { label: '&Describe the graph (I)', click: send('graphDescribe') },
      { label: 'S&lope here (S)', click: send('graphSlope') },
      { label: 'Li&mits from the left and right (L)', click: send('graphLimits') },
      { label: 'Slope s&ound on or off (D)', click: send('graphSlopeSound') },
      { label: 'Change the &step size (F)', click: send('graphStep') },
      { label: '&Back to the document (Escape)', click: send('graphClose') },
    ] },
    { label: '&Review', submenu: [
      { label: '&Word count', click: send('wordCount') },
      { type: 'separator' },
      { label: '&Next review note', accelerator: 'F8', click: send('nextNote') },
      { label: '&Previous review note', accelerator: 'Shift+F8', click: send('previousNote') },
      { label: '&Remove review note on this line', click: send('clearNote') },
    ] },
    { label: '&Teacher', submenu: [
      { id: 'teacherMode', label: '&Teacher mode', type: 'checkbox', click: send('teacherMode') },
      { type: 'separator' },
      { label: '&Hide this line from students', accelerator: 'Ctrl+Shift+F9', click: send('hideLine') },
      { label: 'Hide the selected &words from students', accelerator: 'Ctrl+F9', click: send('hideWords') },
      { label: 'Insert &answer box', click: send('answerBox') },
      { label: '&Graph for students…', click: send('studentGraph') },
      { type: 'separator' },
      { id: 'studentPreview', label: '&Preview student copy', type: 'checkbox', click: send('studentPreview') },
      { label: '&Save student copy…', click: send('saveStudentCopy') },
      { label: 'Export student copy as &Word document…', click: send('exportStudentDocx') },
      { label: 'Export student copy as P&DF…', click: send('exportStudentPdf') },
    ] },
    { label: '&Settings', submenu: [
      { label: '&Reading PDFs…', accelerator: 'Ctrl+,', click: send('settingsReading') },
      { label: '&Writing…', click: send('settingsWriting') },
      { label: '&AI add-on…', click: send('settingsAi') },
      { label: '&Graph sound…', click: send('settingsSound') },
      { label: 'Sound &guide…', click: send('soundGuide') },
      { type: 'separator' },
      { label: 'Restore &defaults', click: send('settingsReset') },
    ] },
    { label: '&Help', submenu: [
      { label: '&Keyboard shortcuts', accelerator: 'F1', click: send('keys') },
      { label: '&Sound guide: learn the graph sounds', click: send('soundGuide') },
      { label: '&Open the user guide', click: () => shell.openPath(path.join(NOTEBOOK, 'README.md')) },
    ] },
  ];
  // These keys are run by the page itself (editor.js, DOCUMENT_KEYS), so the menu shows them
  // but does not register them: otherwise a key press could run its command twice.
  const pageKeys = new Set(['Ctrl+B', 'Ctrl+I', 'Ctrl+U', 'Ctrl+Shift+L', 'Ctrl+Shift+7', 'Ctrl+Enter', 'Ctrl+Alt+1', 'Ctrl+Alt+2',
    'Ctrl+Alt+3', 'Ctrl+Alt+0', 'Ctrl+Shift+E', 'Ctrl+E', 'Alt+=', 'Ctrl+F', 'Ctrl+H', 'F3', 'Shift+F3', 'Ctrl+Shift+M', 'Ctrl+Shift+W',
    'Ctrl+Shift+V', 'Ctrl+PageDown', 'Ctrl+PageUp', 'Ctrl+Shift+H', 'F1', 'Ctrl+G', 'Ctrl+Shift+G', 'Ctrl+F9', 'Ctrl+Shift+F9', 'F11', 'Ctrl+T', 'Ctrl+Shift+T', 'Ctrl+L']);
  for (const menu of template) for (const item of menu.submenu) if (pageKeys.has(item.accelerator)) item.registerAccelerator = false;
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerFileHandlers() {
  ipcMain.handle('choose-pdf', async () => {
    const result = await dialog.showOpenDialog(win, { title: 'Import PDF', properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    return result.canceled ? null : result.filePaths[0];
  });
  // Files the person chose in a dialog: only these are saved over without asking again.
  const chosen = new Set();
  ipcMain.handle('open-notebook', async () => {
    const result = await dialog.showOpenDialog(win, { title: 'Open notebook', properties: ['openFile'], filters: [{ name: 'Math Notebook', extensions: ['mathnb'] }] });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    chosen.add(file);
    return { path: file, content: fs.readFileSync(file, 'utf8') };
  });
  ipcMain.handle('open-text', async (_event, { title, filters }) => {
    const result = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    return { path: file, content: fs.readFileSync(file, 'utf8') };
  });
  ipcMain.handle('save', async (_event, { path: target, name, content, filters }) => {
    let file = chosen.has(target) ? target : null;
    if (!file) {
      const result = await dialog.showSaveDialog(win, { title: 'Save', defaultPath: name, filters: filters || [{ name: 'Math Notebook', extensions: ['mathnb'] }] });
      if (result.canceled) return null;
      file = result.filePath;
      chosen.add(file);
    }
    fs.writeFileSync(file, content, 'utf8');
    return file;
  });
  ipcMain.handle('save-binary', async (_event, { name, bytes, filters }) => {
    const result = await dialog.showSaveDialog(win, { title: 'Export', defaultPath: name, filters });
    if (result.canceled) return null;
    fs.writeFileSync(result.filePath, Buffer.from(bytes));
    return result.filePath;
  });
  ipcMain.handle('export-pdf', async (_event, { name, notebook }) => {
    const result = await dialog.showSaveDialog(win, { title: 'Export as PDF', defaultPath: name, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (result.canceled) return null;
    // Tagged, with an outline from the headings, so a PDF reader can move by heading.
    const data = await win.webContents.printToPDF({ pageSize: 'Letter', printBackground: false, generateTaggedPDF: true, generateDocumentOutline: true });
    fs.writeFileSync(result.filePath, data);
    // The notebook goes inside as a standard PDF attachment; Math Notebook opens it exactly.
    if (notebook) {
      const response = await fetch(`${serverUrl}api/attach`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: result.filePath, notebook }) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'The notebook could not be attached.');
    }
    return result.filePath;
  });
  ipcMain.handle('print', () => new Promise((resolve) => win.webContents.print({}, (ok) => resolve(ok))));
  ipcMain.handle('copy-text', (_event, text) => clipboard.writeText(String(text)));
  ipcMain.handle('read-text', () => clipboard.readText());
  ipcMain.on('set-title', (_event, title) => win?.setTitle(String(title)));
  // The menus as words and keys, for the Keyboard shortcuts page (always the same as the menus).
  ipcMain.handle('get-menu', () => Menu.getApplicationMenu().items.map((m) => ({
    label: m.label.replace(/&/g, ''),
    items: m.submenu.items.filter((i) => i.type !== 'separator' && i.visible !== false)
      .map((i) => ({ label: i.label.replace(/&/g, ''), key: String(i.accelerator || '').replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl') })),
  })));
  // The page says when a checkbox item changes (opening a file can turn Teacher mode on).
  ipcMain.on('set-menu-checked', (_event, id, checked) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(String(id));
    if (item) item.checked = Boolean(checked);
  });
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 900, title: 'Math Notebook', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Stay on the local reader; links to anything else open in the normal browser.
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(serverUrl)) { event.preventDefault(); shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // The Applications key (or right click) on a misspelled word lists corrections, as in Word.
  win.webContents.on('context-menu', (_event, params) => {
    const items = [];
    if (params.misspelledWord) {
      for (const word of params.dictionarySuggestions.slice(0, 6)) items.push({ label: word, click: () => win.webContents.replaceMisspelling(word) });
      if (!params.dictionarySuggestions.length) items.push({ label: 'No spelling suggestions', enabled: false });
      items.push({ label: `Add "${params.misspelledWord}" to the dictionary`, click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      items.push({ type: 'separator' });
    }
    items.push({ role: 'cut', label: 'Cu&t' }, { role: 'copy', label: '&Copy' }, { role: 'paste', label: '&Paste' });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  win.on('close', async (event) => {
    if (allowClose) return;
    event.preventDefault();
    const dirty = await win.webContents.executeJavaScript('window.isDirty ? window.isDirty() : false').catch(() => false);
    if (dirty) {
      const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: ['Save', "Don't save", 'Cancel'], defaultId: 0, cancelId: 2,
        title: 'Math Notebook', message: 'Save changes before closing?' });
      if (response === 2) return;
      if (response === 0) {
        // Close only if the save really happened (the save dialog can be cancelled).
        const saved = await win.webContents.executeJavaScript('window.saveForClose()').catch(() => false);
        if (!saved) return;
      }
    }
    allowClose = true;
    win.close();
  });
  await win.loadURL(`${serverUrl}editor.html`);
  if (!TESTING) win.show();
}

app.whenReady().then(async () => {
  buildMenu();
  registerFileHandlers();
  try {
    serverUrl = await startServer();
  } catch (error) {
    dialog.showErrorBox('Math Notebook could not start', error.message);
    app.quit();
    return;
  }
  await createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('quit', () => { try { server?.kill(); } catch { /* already stopped */ } });
