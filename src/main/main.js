const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const os = require('os');
const { autoUpdater } = require('electron-updater');

let mainWindow;
const panelWindows = new Map(); // panelType -> BrowserWindow

// ===== Auto Updater =====
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function setupAutoUpdater() {
  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus('checking');
  });

  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus('available', info);
  });

  autoUpdater.on('update-not-available', (info) => {
    sendUpdateStatus('not-available', info);
  });

  autoUpdater.on('error', (err) => {
    sendUpdateStatus('error', { message: err.message });
  });

  autoUpdater.on('download-progress', (progressObj) => {
    sendUpdateStatus('downloading', progressObj);
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus('downloaded', info);
  });
}

function sendUpdateStatus(status, data = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', { status, ...data });
  }
}

// Check for updates (called after window is ready)
function checkForUpdates() {
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch(err => {
      console.log('Update check failed:', err.message);
    });
  }
}
const terminals = new Map(); // Map of terminalId -> ptyProcess

// ===== DataStore (on-disk JSON persistence) =====
class DataStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    fs.mkdirSync(baseDir, { recursive: true });
  }
  read(filename) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.baseDir, filename), 'utf-8'));
    } catch {
      return null;
    }
  }
  write(filename, data) {
    const filePath = path.join(this.baseDir, filename);
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
  }
  listFiles() {
    try {
      return fs.readdirSync(this.baseDir).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }
  }
}

const dataStore = new DataStore(path.join(app.getPath('userData'), 'data'));

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#FAF9F7',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (process.argv.includes('--enable-logging')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    // Kill all terminal processes
    for (const [id, ptyProcess] of terminals) {
      ptyProcess.kill();
    }
    terminals.clear();
  });
}

app.whenReady().then(() => {
  // Custom app menu
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));

  createWindow();
  setupAutoUpdater();

  // Check for updates after a short delay
  setTimeout(checkForUpdates, 3000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// ===== Open External URLs =====
ipcMain.handle('open-external', async (event, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

// ===== Folder Dialog =====
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Project Folder'
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const folderPath = result.filePaths[0];
  const folderName = path.basename(folderPath);

  return { path: folderPath, name: folderName };
});

// ===== Create Project Folder =====
ipcMain.handle('create-project-folder', async (event, parentPath, folderName) => {
  const newFolderPath = path.join(parentPath, folderName);
  await fs.promises.mkdir(newFolderPath, { recursive: true });
  return { path: newFolderPath, name: folderName };
});

// ===== Terminal (PTY) - Multi-terminal support =====
ipcMain.handle('terminal-create', (event, { id, cwd, shell: customShell, env: customEnv, startup }) => {
  // Check if terminal already exists
  if (terminals.has(id)) {
    return { exists: true };
  }

  const shell = customShell || process.env.SHELL || '/bin/zsh';

  // Parse custom env vars (format: KEY=value, one per line)
  const extraEnv = {};
  if (customEnv) {
    const lines = customEnv.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && trimmed.includes('=')) {
        const eqIndex = trimmed.indexOf('=');
        const key = trimmed.substring(0, eqIndex).trim();
        const value = trimmed.substring(eqIndex + 1).trim();
        if (key) extraEnv[key] = value;
      }
    }
  }

  // Spawn as login shell (-l) to load user's profile and PATH
  const ptyProcess = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: cwd || os.homedir(),
    env: {
      ...process.env,
      ...extraEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      // Ensure common paths are included for tools like Claude CLI
      PATH: [
        process.env.PATH,
        '/usr/local/bin',
        '/opt/homebrew/bin',
        `${os.homedir()}/.local/bin`,
        `${os.homedir()}/.npm-global/bin`,
        `${os.homedir()}/.nvm/versions/node/*/bin`,
        '/opt/local/bin'
      ].filter(Boolean).join(':')
    }
  });

  // Run startup command if provided
  if (startup && startup.trim()) {
    setTimeout(() => {
      ptyProcess.write(startup.trim() + '\r');
    }, 500);
  }

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', { id, data });
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-exit', { id, exitCode });
    }
    terminals.delete(id);
  });

  terminals.set(id, ptyProcess);
  return { exists: false, created: true };
});

ipcMain.on('terminal-input', (event, { id, data }) => {
  const ptyProcess = terminals.get(id);
  if (ptyProcess) {
    ptyProcess.write(data);
  }
});

ipcMain.on('terminal-resize', (event, { id, cols, rows }) => {
  const ptyProcess = terminals.get(id);
  if (ptyProcess) {
    ptyProcess.resize(cols, rows);
  }
});

ipcMain.handle('terminal-kill', (event, id) => {
  const ptyProcess = terminals.get(id);
  if (ptyProcess) {
    ptyProcess.kill();
    terminals.delete(id);
  }
  return true;
});

// ===== File System =====
ipcMain.handle('read-directory', async (event, dirPath) => {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

    const items = entries
      .filter(entry => !entry.name.startsWith('.')) // Hide hidden files
      .map(entry => ({
        name: entry.name,
        path: path.join(dirPath, entry.name),
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile()
      }))
      .sort((a, b) => {
        // Directories first, then files, both alphabetically
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

    return { success: true, items };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp'];

ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath);

    // Handle image files
    if (IMAGE_EXTENSIONS.includes(ext)) {
      const buffer = await fs.promises.readFile(filePath);
      const base64 = buffer.toString('base64');
      const mimeType = ext === '.svg' ? 'image/svg+xml' :
                       ext === '.png' ? 'image/png' :
                       ext === '.gif' ? 'image/gif' :
                       ext === '.webp' ? 'image/webp' :
                       ext === '.ico' ? 'image/x-icon' :
                       ext === '.bmp' ? 'image/bmp' : 'image/jpeg';
      return { success: true, isImage: true, dataUrl: `data:${mimeType};base64,${base64}`, extension: ext, name };
    }

    // Handle text files
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return { success: true, content, extension: ext, name };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ===== Git =====
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

async function runGitCommand(cwd, args) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 });
    return { success: true, output: stdout.trim() };
  } catch (error) {
    return { success: false, error: error.message, output: error.stdout?.trim() || '' };
  }
}

ipcMain.handle('git-status', async (event, cwd) => {
  // Check if it's a git repo
  const isRepo = await runGitCommand(cwd, ['rev-parse', '--git-dir']);
  if (!isRepo.success) {
    return { isRepo: false };
  }

  // Get current branch
  const branch = await runGitCommand(cwd, ['branch', '--show-current']);

  // Get status with porcelain format for easy parsing
  const status = await runGitCommand(cwd, ['status', '--porcelain', '-u']);

  // Parse status output
  const files = {
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: []
  };

  if (status.success && status.output) {
    const lines = status.output.split('\n').filter(l => l);
    for (const line of lines) {
      const indexStatus = line[0];
      const workStatus = line[1];
      const fileName = line.substring(3);

      // Detect conflicted files (UU, AA, DD, etc.)
      if ((indexStatus === 'U' || workStatus === 'U') || (indexStatus === 'A' && workStatus === 'A') || (indexStatus === 'D' && workStatus === 'D')) {
        files.conflicted.push({ name: fileName, status: `${indexStatus}${workStatus}` });
      } else if (indexStatus === '?' && workStatus === '?') {
        files.untracked.push({ name: fileName, status: 'untracked' });
      } else {
        if (indexStatus !== ' ' && indexStatus !== '?') {
          files.staged.push({ name: fileName, status: indexStatus });
        }
        if (workStatus !== ' ' && workStatus !== '?') {
          files.unstaged.push({ name: fileName, status: workStatus });
        }
      }
    }
  }

  // Detect merge/rebase state
  let mergeState = null;
  const gitDir = isRepo.output || '.git';
  const mergeHeadCheck = await runGitCommand(cwd, ['rev-parse', '--verify', 'MERGE_HEAD']);
  if (mergeHeadCheck.success) {
    mergeState = 'merging';
  } else {
    const rebaseCheck = await runGitCommand(cwd, ['rev-parse', '--verify', 'REBASE_HEAD']);
    if (rebaseCheck.success) {
      mergeState = 'rebasing';
    }
  }

  return {
    isRepo: true,
    branch: branch.output || 'HEAD',
    files,
    mergeState
  };
});

ipcMain.handle('git-stage', async (event, { cwd, file }) => {
  const result = await runGitCommand(cwd, ['add', file]);
  return result;
});

ipcMain.handle('git-unstage', async (event, { cwd, file }) => {
  const result = await runGitCommand(cwd, ['reset', 'HEAD', file]);
  return result;
});

ipcMain.handle('git-stage-all', async (event, cwd) => {
  const result = await runGitCommand(cwd, ['add', '-A']);
  return result;
});

ipcMain.handle('git-unstage-all', async (event, cwd) => {
  const result = await runGitCommand(cwd, ['reset', 'HEAD']);
  return result;
});

ipcMain.handle('git-commit', async (event, { cwd, message }) => {
  if (!message || !message.trim()) {
    return { success: false, error: 'Commit message required' };
  }
  const result = await runGitCommand(cwd, ['commit', '-m', message.trim()]);
  return result;
});

ipcMain.handle('git-discard', async (event, { cwd, file }) => {
  const result = await runGitCommand(cwd, ['checkout', '--', file]);
  return result;
});

ipcMain.handle('git-branches', async (event, cwd) => {
  // Get all local branches
  const result = await runGitCommand(cwd, ['branch', '--list', '--format=%(refname:short)']);
  if (!result.success) {
    return { success: false, branches: [], current: '' };
  }

  const branches = result.output.split('\n').filter(b => b.trim());

  // Get current branch
  const current = await runGitCommand(cwd, ['branch', '--show-current']);

  return {
    success: true,
    branches,
    current: current.output || 'HEAD'
  };
});

ipcMain.handle('git-checkout', async (event, { cwd, branch }) => {
  const result = await runGitCommand(cwd, ['checkout', branch]);
  return result;
});

ipcMain.handle('git-create-branch', async (event, { cwd, name }) => {
  const result = await runGitCommand(cwd, ['checkout', '-b', name]);
  return result;
});

ipcMain.handle('git-push', async (event, cwd) => {
  const result = await runGitCommand(cwd, ['push']);
  return result;
});

ipcMain.handle('git-push-set-upstream', async (event, { cwd, branch }) => {
  const result = await runGitCommand(cwd, ['push', '-u', 'origin', branch]);
  return result;
});

ipcMain.handle('git-pull', async (event, cwd) => {
  const result = await runGitCommand(cwd, ['pull']);
  return result;
});

ipcMain.handle('git-remote-status', async (event, cwd) => {
  // Check if there's a remote and if we're ahead/behind
  const remote = await runGitCommand(cwd, ['remote']);
  if (!remote.success || !remote.output.trim()) {
    return { hasRemote: false };
  }

  // Fetch to update remote refs (silently)
  await runGitCommand(cwd, ['fetch', '--quiet']);

  // Check ahead/behind status
  const status = await runGitCommand(cwd, ['status', '-sb']);
  let ahead = 0, behind = 0;

  if (status.success && status.output) {
    const match = status.output.match(/\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/);
    if (match) {
      ahead = parseInt(match[1] || 0);
      behind = parseInt(match[2] || match[3] || 0);
    }
  }

  return { hasRemote: true, ahead, behind };
});

ipcMain.handle('git-diff', async (event, { cwd, file, staged }) => {
  const args = staged ? ['diff', '--cached', file] : ['diff', file];
  const result = await runGitCommand(cwd, args);
  return result;
});

ipcMain.handle('git-diff-all', async (event, { cwd, staged }) => {
  const args = staged ? ['diff', '--cached'] : ['diff'];
  const result = await runGitCommand(cwd, args);
  return result;
});

// ===== Git: Commit History =====
ipcMain.handle('git-log', async (event, { cwd, skip = 0, limit = 20 }) => {
  const result = await runGitCommand(cwd, [
    'log', `--skip=${skip}`, `-${limit}`,
    '--format=%H%n%an%n%aI%n%s', '--'
  ]);
  if (!result.success) return { success: false, commits: [] };
  const lines = result.output.split('\n').filter(l => l);
  const commits = [];
  for (let i = 0; i + 3 < lines.length; i += 4) {
    commits.push({ hash: lines[i], author: lines[i + 1], date: lines[i + 2], message: lines[i + 3] });
  }
  return { success: true, commits };
});

ipcMain.handle('git-show', async (event, { cwd, hash }) => {
  const result = await runGitCommand(cwd, ['show', '--format=%H%n%an%n%aI%n%B', hash]);
  return result;
});

// ===== Git: Stash Management =====
ipcMain.handle('git-stash-list', async (event, cwd) => {
  const result = await runGitCommand(cwd, ['stash', 'list', '--format=%gd|%gs']);
  if (!result.success) return { success: true, stashes: [] };
  const stashes = result.output ? result.output.split('\n').filter(l => l).map(l => {
    const [index, ...msg] = l.split('|');
    return { index, message: msg.join('|') };
  }) : [];
  return { success: true, stashes };
});

ipcMain.handle('git-stash-save', async (event, { cwd, message }) => {
  const args = message ? ['stash', 'push', '-m', message] : ['stash', 'push'];
  return await runGitCommand(cwd, args);
});

ipcMain.handle('git-stash-pop', async (event, { cwd, index }) => {
  return await runGitCommand(cwd, ['stash', 'pop', index]);
});

ipcMain.handle('git-stash-apply', async (event, { cwd, index }) => {
  return await runGitCommand(cwd, ['stash', 'apply', index]);
});

ipcMain.handle('git-stash-drop', async (event, { cwd, index }) => {
  return await runGitCommand(cwd, ['stash', 'drop', index]);
});

// ===== Git: Tag Management =====
ipcMain.handle('git-tag-list', async (event, cwd) => {
  const result = await runGitCommand(cwd, ['tag', '-l', '--sort=-creatordate', '--format=%(refname:short)|%(objectname:short)|%(creatordate:iso)']);
  if (!result.success) return { success: true, tags: [] };
  const tags = result.output ? result.output.split('\n').filter(l => l).map(l => {
    const [name, hash, date] = l.split('|');
    return { name, hash, date };
  }) : [];
  return { success: true, tags };
});

ipcMain.handle('git-tag-create', async (event, { cwd, name, message }) => {
  const args = message ? ['tag', '-a', name, '-m', message] : ['tag', name];
  return await runGitCommand(cwd, args);
});

ipcMain.handle('git-tag-delete', async (event, { cwd, name }) => {
  return await runGitCommand(cwd, ['tag', '-d', name]);
});

ipcMain.handle('git-tag-push', async (event, { cwd, name }) => {
  const args = name === '--all' ? ['push', 'origin', '--tags'] : ['push', 'origin', name];
  return await runGitCommand(cwd, args);
});

// ===== Git: Merge/Rebase =====
ipcMain.handle('git-merge', async (event, { cwd, branch }) => {
  return await runGitCommand(cwd, ['merge', branch]);
});

ipcMain.handle('git-merge-abort', async (event, cwd) => {
  return await runGitCommand(cwd, ['merge', '--abort']);
});

ipcMain.handle('git-rebase', async (event, { cwd, branch }) => {
  return await runGitCommand(cwd, ['rebase', branch]);
});

ipcMain.handle('git-rebase-continue', async (event, cwd) => {
  return await runGitCommand(cwd, ['rebase', '--continue']);
});

ipcMain.handle('git-rebase-abort', async (event, cwd) => {
  return await runGitCommand(cwd, ['rebase', '--abort']);
});

// ===== Git: Blame =====
ipcMain.handle('git-blame', async (event, { cwd, file }) => {
  const result = await runGitCommand(cwd, ['blame', '--porcelain', file]);
  return result;
});

// ===== Global Search =====
const DEFAULT_SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage', '__pycache__', '.vscode', '.idea'];
const BINARY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib'];

async function searchInDirectory(dir, query, results, skipDirs = DEFAULT_SKIP_DIRS, maxResults = 100, rootDir = dir) {
  if (results.length >= maxResults) return;

  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (results.length >= maxResults) break;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!skipDirs.includes(entry.name) && !entry.name.startsWith('.')) {
          await searchInDirectory(fullPath, query, results, skipDirs, maxResults, rootDir);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (BINARY_EXTENSIONS.includes(ext)) continue;

        try {
          const content = await fs.promises.readFile(fullPath, 'utf-8');
          const lines = content.split('\n');
          const queryLower = query.toLowerCase();

          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            if (lines[i].toLowerCase().includes(queryLower)) {
              results.push({
                file: fullPath,
                relativePath: path.relative(rootDir, fullPath),
                line: i + 1,
                content: lines[i].trim().substring(0, 200),
                fileName: entry.name
              });
            }
          }
        } catch (e) {
          // Skip files that can't be read as text
        }
      }
    }
  } catch (e) {
    // Skip directories that can't be read
  }
}

ipcMain.handle('search-project', async (event, { cwd, query, skipDirs }) => {
  if (!query || query.length < 2) {
    return { success: true, results: [] };
  }

  const results = [];
  await searchInDirectory(cwd, query, results, skipDirs || DEFAULT_SKIP_DIRS, 100, cwd);

  return { success: true, results };
});

// ===== File Search (Quick Open) =====
const fileIndexCache = new Map(); // Map<dir, {files, timestamp}>

async function buildFileIndex(dir, skipDirs = DEFAULT_SKIP_DIRS, basePath = '', files = []) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skipDirs.includes(entry.name)) {
          await buildFileIndex(fullPath, skipDirs, relativePath, files);
        }
      } else if (entry.isFile()) {
        files.push({ name: entry.name, path: fullPath, relativePath });
      }
    }
  } catch (e) {
    // Skip unreadable directories
  }
  return files;
}

function serverFuzzyMatch(query, text) {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatchIndex = -1;
  for (let i = 0; i < textLower.length && qi < queryLower.length; i++) {
    if (textLower[i] === queryLower[qi]) {
      score += (lastMatchIndex === i - 1) ? 2 : 1; // Consecutive bonus
      if (i === 0 || text[i - 1] === '/' || text[i - 1] === '\\' || text[i - 1] === '.' || text[i - 1] === '-' || text[i - 1] === '_') {
        score += 3; // Word boundary bonus
      }
      lastMatchIndex = i;
      qi++;
    }
  }
  return qi === queryLower.length ? score : 0;
}

ipcMain.handle('search-files', async (event, { cwd, query, skipDirs, limit = 50 }) => {
  const resolvedSkipDirs = skipDirs || DEFAULT_SKIP_DIRS;
  const cached = fileIndexCache.get(cwd);
  let files;
  if (cached && (Date.now() - cached.timestamp < 30000)) {
    files = cached.files;
  } else {
    files = await buildFileIndex(cwd, resolvedSkipDirs);
    fileIndexCache.set(cwd, { files, timestamp: Date.now() });
  }

  if (!query || query.length === 0) {
    return { results: files.slice(0, limit), hasMore: files.length > limit };
  }

  const scored = [];
  for (const file of files) {
    const score = serverFuzzyMatch(query, file.relativePath);
    if (score > 0) scored.push({ ...file, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, limit).map(({ score, ...rest }) => rest);
  return { results, hasMore: scored.length > limit };
});

// ===== Streaming Search =====
const activeSearches = new Map(); // requestId -> { cancelled: boolean }

ipcMain.on('search-project-stream', async (event, { cwd, query, skipDirs, requestId }) => {
  const resolvedSkipDirs = skipDirs || DEFAULT_SKIP_DIRS;
  const searchState = { cancelled: false };
  activeSearches.set(requestId, searchState);

  async function searchStream(dir) {
    if (searchState.cancelled) return;
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (searchState.cancelled) return;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!resolvedSkipDirs.includes(entry.name) && !entry.name.startsWith('.')) {
            await searchStream(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (BINARY_EXTENSIONS.includes(ext)) continue;
          try {
            const content = await fs.promises.readFile(fullPath, 'utf-8');
            const lines = content.split('\n');
            const queryLower = query.toLowerCase();
            const matches = [];
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(queryLower)) {
                matches.push({ line: i + 1, content: lines[i].trim().substring(0, 200) });
              }
            }
            if (matches.length > 0 && !searchState.cancelled) {
              event.sender.send('search-result', {
                requestId,
                file: fullPath,
                relativePath: path.relative(cwd, fullPath),
                fileName: entry.name,
                matches
              });
            }
          } catch (e) { /* skip unreadable */ }
        }
      }
    } catch (e) { /* skip unreadable dirs */ }
  }

  await searchStream(cwd);
  if (!searchState.cancelled) {
    event.sender.send('search-complete', { requestId });
  }
  activeSearches.delete(requestId);
});

ipcMain.on('search-cancel', (event, requestId) => {
  const searchState = activeSearches.get(requestId);
  if (searchState) {
    searchState.cancelled = true;
  }
});

ipcMain.handle('get-default-skip-dirs', () => {
  return DEFAULT_SKIP_DIRS;
});

// ===== Utility =====
ipcMain.handle('get-home-directory', () => {
  return app.getPath('home');
});

ipcMain.handle('get-documents-path', () => {
  return app.getPath('documents');
});

// ===== Auto Updater IPC =====
ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) {
    return { status: 'dev-mode' };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    return { status: 'checking', result };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
});

ipcMain.handle('download-update', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// ===== DataStore IPC =====
ipcMain.handle('store-read', (_, filename) => {
  return dataStore.read(filename);
});

ipcMain.handle('store-write', (_, filename, data) => {
  dataStore.write(filename, data);
});

// ===== Detachable Panel Windows =====
ipcMain.handle('open-panel-window', (event, panelType) => {
  // If window already exists for this panel, focus it
  if (panelWindows.has(panelType)) {
    const existing = panelWindows.get(panelType);
    if (!existing.isDestroyed()) {
      existing.focus();
      return true;
    }
    panelWindows.delete(panelType);
  }

  const panelWin = new BrowserWindow({
    width: 400,
    height: 600,
    minWidth: 250,
    minHeight: 300,
    title: panelType.charAt(0).toUpperCase() + panelType.slice(1),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  panelWin.loadFile(path.join(__dirname, '../renderer/panel-window.html'), {
    query: { panel: panelType }
  });

  panelWindows.set(panelType, panelWin);

  panelWin.on('closed', () => {
    panelWindows.delete(panelType);
    // Notify main renderer that panel closed
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('panel-window-closed', panelType);
    }
  });

  return true;
});

ipcMain.on('panel-update', (event, { panelType, data }) => {
  const panelWin = panelWindows.get(panelType);
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.webContents.send('panel-state-update', { panelType, data });
  }
});

ipcMain.on('panel-action', (event, { panelType, action, payload }) => {
  // Forward action from panel window to main renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('panel-action', { panelType, action, payload });
  }
});

ipcMain.on('panel-request-state', (event, panelType) => {
  // Forward to main renderer to send current state
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('panel-request-state', panelType);
  }
});

ipcMain.handle('store-export', async () => {
  const date = new Date().toISOString().split('T')[0];
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export All Settings',
    defaultPath: `agentic-terminal-backup-${date}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { success: false };
  const bundle = { version: 1, exportedAt: new Date().toISOString(), data: {} };
  for (const file of dataStore.listFiles()) {
    bundle.data[file] = dataStore.read(file);
  }
  fs.writeFileSync(result.filePath, JSON.stringify(bundle, null, 2));
  return { success: true, path: result.filePath };
});

ipcMain.handle('store-import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Settings',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return { success: false };
  try {
    const raw = fs.readFileSync(result.filePaths[0], 'utf-8');
    const bundle = JSON.parse(raw);
    if (!bundle.version || !bundle.data) return { success: false, error: 'Invalid backup file' };
    for (const [filename, content] of Object.entries(bundle.data)) {
      if (filename.endsWith('.json') && content != null) {
        dataStore.write(filename, content);
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
