const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const os = require('os');
const { autoUpdater } = require('electron-updater');

let mainWindow;

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
    untracked: []
  };

  if (status.success && status.output) {
    const lines = status.output.split('\n').filter(l => l);
    for (const line of lines) {
      const indexStatus = line[0];
      const workStatus = line[1];
      const fileName = line.substring(3);

      if (indexStatus === '?' && workStatus === '?') {
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

  // Get recent commits
  const log = await runGitCommand(cwd, ['log', '--oneline', '-5']);
  const commits = log.success ? log.output.split('\n').filter(l => l).map(l => {
    const [hash, ...msg] = l.split(' ');
    return { hash, message: msg.join(' ') };
  }) : [];

  return {
    isRepo: true,
    branch: branch.output || 'HEAD',
    files,
    commits
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

// ===== Global Search =====
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'venv', '.venv', 'coverage', '.cache'];
const BINARY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib'];

async function searchInDirectory(dir, query, results, maxResults = 100) {
  if (results.length >= maxResults) return;

  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (results.length >= maxResults) break;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.includes(entry.name) && !entry.name.startsWith('.')) {
          await searchInDirectory(fullPath, query, results, maxResults);
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
                relativePath: path.relative(dir, fullPath).split(path.sep).slice(1).join('/') || entry.name,
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

ipcMain.handle('search-project', async (event, { cwd, query }) => {
  if (!query || query.length < 2) {
    return { success: true, results: [] };
  }

  const results = [];
  await searchInDirectory(cwd, query, results, 100);

  return { success: true, results };
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
