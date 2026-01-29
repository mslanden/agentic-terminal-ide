const { contextBridge, ipcRenderer } = require('electron');

// Store listeners so we can remove them
let terminalDataListener = null;
let terminalExitListener = null;

contextBridge.exposeInMainWorld('electronAPI', {
  // Folder selection
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  createProjectFolder: (parentPath, folderName) => ipcRenderer.invoke('create-project-folder', parentPath, folderName),

  // Terminal - multi-terminal support
  terminalCreate: (id, cwd, options = {}) => ipcRenderer.invoke('terminal-create', { id, cwd, ...options }),
  terminalInput: (id, data) => ipcRenderer.send('terminal-input', { id, data }),
  terminalResize: (id, cols, rows) => ipcRenderer.send('terminal-resize', { id, cols, rows }),
  terminalKill: (id) => ipcRenderer.invoke('terminal-kill', id),

  // Terminal listeners with cleanup
  onTerminalData: (callback) => {
    // Remove old listener if exists
    if (terminalDataListener) {
      ipcRenderer.removeListener('terminal-data', terminalDataListener);
    }
    terminalDataListener = (event, payload) => callback(payload.id, payload.data);
    ipcRenderer.on('terminal-data', terminalDataListener);
  },
  onTerminalExit: (callback) => {
    if (terminalExitListener) {
      ipcRenderer.removeListener('terminal-exit', terminalExitListener);
    }
    terminalExitListener = (event, payload) => callback(payload.id, payload.exitCode);
    ipcRenderer.on('terminal-exit', terminalExitListener);
  },

  // File system
  readDirectory: (dirPath) => ipcRenderer.invoke('read-directory', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),

  // Git
  gitStatus: (cwd) => ipcRenderer.invoke('git-status', cwd),
  gitStage: (cwd, file) => ipcRenderer.invoke('git-stage', { cwd, file }),
  gitUnstage: (cwd, file) => ipcRenderer.invoke('git-unstage', { cwd, file }),
  gitStageAll: (cwd) => ipcRenderer.invoke('git-stage-all', cwd),
  gitUnstageAll: (cwd) => ipcRenderer.invoke('git-unstage-all', cwd),
  gitCommit: (cwd, message) => ipcRenderer.invoke('git-commit', { cwd, message }),
  gitDiscard: (cwd, file) => ipcRenderer.invoke('git-discard', { cwd, file }),
  gitBranches: (cwd) => ipcRenderer.invoke('git-branches', cwd),
  gitCheckout: (cwd, branch) => ipcRenderer.invoke('git-checkout', { cwd, branch }),
  gitCreateBranch: (cwd, name) => ipcRenderer.invoke('git-create-branch', { cwd, name }),
  gitDiff: (cwd, file, staged = false) => ipcRenderer.invoke('git-diff', { cwd, file, staged }),
  gitDiffAll: (cwd, staged = false) => ipcRenderer.invoke('git-diff-all', { cwd, staged }),
  gitPush: (cwd) => ipcRenderer.invoke('git-push', cwd),
  gitPushSetUpstream: (cwd, branch) => ipcRenderer.invoke('git-push-set-upstream', { cwd, branch }),
  gitPull: (cwd) => ipcRenderer.invoke('git-pull', cwd),
  gitRemoteStatus: (cwd) => ipcRenderer.invoke('git-remote-status', cwd),

  // Search
  searchProject: (cwd, query) => ipcRenderer.invoke('search-project', { cwd, query }),

  // Utility
  getHomeDirectory: () => ipcRenderer.invoke('get-home-directory'),
  getDocumentsPath: () => ipcRenderer.invoke('get-documents-path'),

  // Auto Updater
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (event, data) => callback(data));
  },
});
