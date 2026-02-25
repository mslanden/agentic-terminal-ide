const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { SearchAddon } = require('@xterm/addon-search');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const { marked } = require('marked');
const hljs = require('highlight.js/lib/common');

// Configure marked
marked.setOptions({
  breaks: true,
  gfm: true
});

// ===== State =====
// Structure: projectPath -> { tabs: [{ id, name, terminal, fitAddon, searchAddon, container }], activeTabIndex }
const projectData = new Map();
let currentProject = null;
let activeTerminalId = null;
let listenersInitialized = false;
let terminalCounter = 0;

// ===== DataStore Cache (loaded from disk at startup) =====
let cachedProjects = [];
let cachedProjectSettings = {};
let cachedSessions = {};
let cachedNotes = {};
let cachedProfiles = { profiles: [], active: 'Default' };
let cachedPreferences = { theme: 'light', customShortcuts: {} };

// Preview state
let currentPreviewFile = null;
let currentPreviewContent = null;
let currentPreviewMode = 'raw'; // 'raw' or 'live'

// Diff viewer state
let currentDiffMode = 'unified'; // 'unified' or 'split'

// Broadcast mode state
let broadcastMode = false;

// Shortcut editor state
let capturingShortcutId = null;

// ===== Custom Keyboard Shortcuts =====
const CUSTOM_SHORTCUTS_KEY = 'programming-interface-custom-shortcuts';

function getCustomShortcuts() {
  return cachedPreferences.customShortcuts || {};
}

function saveCustomShortcuts(shortcuts) {
  cachedPreferences.customShortcuts = shortcuts;
  window.electronAPI.storeWrite('preferences.json', cachedPreferences);
}

// ===== Shortcut Registry =====
const SHORTCUT_REGISTRY = [
  // Terminal
  { id: 'new-terminal', label: 'New Terminal', category: 'Terminal', defaultBinding: { key: 't', metaKey: true, shiftKey: false, altKey: false }, action: () => { if (currentProject) createNewTab(currentProject.path, currentProject.path); } },
  { id: 'close-terminal', label: 'Close Terminal', category: 'Terminal', defaultBinding: { key: 'w', metaKey: true, shiftKey: false, altKey: false }, action: () => { if (currentProject && projectData.has(currentProject.path)) { const d = projectData.get(currentProject.path); if (d.tabs.length > 1) closeTab(d.activeTabIndex); } } },
  { id: 'terminal-search', label: 'Terminal Search', category: 'Terminal', defaultBinding: { key: 'f', metaKey: true, shiftKey: false, altKey: false }, action: () => openTerminalSearch() },
  { id: 'split-horizontal', label: 'Split Horizontal', category: 'Terminal', defaultBinding: { key: '\\', metaKey: true, shiftKey: false, altKey: false }, action: () => splitTerminal('horizontal') },
  { id: 'split-vertical', label: 'Split Vertical', category: 'Terminal', defaultBinding: { key: '\\', metaKey: true, shiftKey: true, altKey: false }, action: () => splitTerminal('vertical') },
  { id: 'broadcast-toggle', label: 'Toggle Broadcast', category: 'Terminal', defaultBinding: { key: 'b', metaKey: true, shiftKey: true, altKey: false }, action: () => toggleBroadcastMode() },
  // Navigation
  { id: 'tab-preview', label: 'Preview Tab', category: 'Navigation', defaultBinding: { key: '1', metaKey: true, shiftKey: false, altKey: false }, action: () => { const t = document.querySelector('[data-tab="preview"]'); if (t) t.click(); } },
  { id: 'tab-files', label: 'Files Tab', category: 'Navigation', defaultBinding: { key: '2', metaKey: true, shiftKey: false, altKey: false }, action: () => { const t = document.querySelector('[data-tab="files"]'); if (t) t.click(); } },
  { id: 'tab-git', label: 'Git Tab', category: 'Navigation', defaultBinding: { key: '3', metaKey: true, shiftKey: false, altKey: false }, action: () => { const t = document.querySelector('[data-tab="git"]'); if (t) t.click(); } },
  { id: 'tab-notes', label: 'Notes Tab', category: 'Navigation', defaultBinding: { key: '4', metaKey: true, shiftKey: false, altKey: false }, action: () => { const t = document.querySelector('[data-tab="notes"]'); if (t) t.click(); } },
  // Search
  { id: 'quick-open', label: 'Quick Open', category: 'Search', defaultBinding: { key: 'p', metaKey: true, shiftKey: false, altKey: false }, action: () => openQuickOpen() },
  { id: 'global-search', label: 'Global Search', category: 'Search', defaultBinding: { key: 'f', metaKey: true, shiftKey: true, altKey: false }, action: () => openGlobalSearch() },
  { id: 'command-palette', label: 'Command Palette', category: 'Search', defaultBinding: { key: 'p', metaKey: true, shiftKey: true, altKey: false }, action: () => openCommandPalette() },
  // Tools
  { id: 'theme-toggle', label: 'Toggle Theme', category: 'Tools', defaultBinding: null, action: () => { const cur = getCurrentTheme(); setTheme(cur === 'light' ? 'dark' : 'light'); } },
  { id: 'keyboard-shortcuts', label: 'Keyboard Shortcuts', category: 'Tools', defaultBinding: null, action: () => openShortcutEditor() },
  // Git (button-only, no default binding)
  { id: 'git-refresh', label: 'Git Refresh', category: 'Git', defaultBinding: null, action: () => { const btn = document.querySelector('.git-refresh-btn'); if (btn) btn.click(); } },
  { id: 'git-push', label: 'Git Push', category: 'Git', defaultBinding: null, action: () => { const btn = document.querySelector('.git-push-btn'); if (btn) btn.click(); } },
  { id: 'git-pull', label: 'Git Pull', category: 'Git', defaultBinding: null, action: () => { const btn = document.querySelector('.git-pull-btn'); if (btn) btn.click(); } },
  { id: 'git-stage-all', label: 'Git Stage All', category: 'Git', defaultBinding: null, action: () => { const btn = document.querySelector('.git-stage-all-btn'); if (btn) btn.click(); } },
  // Project
  { id: 'add-project', label: 'Add Project', category: 'Project', defaultBinding: null, action: () => { document.getElementById('add-project-btn').click(); } },
  { id: 'project-settings', label: 'Project Settings', category: 'Project', defaultBinding: null, action: () => { if (currentProject) openProjectSettings(currentProject.path); } },
  { id: 'select-profile', label: 'Select Profile', category: 'Terminal', defaultBinding: null, action: () => { document.getElementById('profile-btn').click(); } },
  // Data
  { id: 'export-settings', label: 'Export All Settings', category: 'Data', defaultBinding: null, action: () => { document.getElementById('settings-export').click(); } },
  { id: 'import-settings', label: 'Import Settings', category: 'Data', defaultBinding: null, action: () => { document.getElementById('settings-import').click(); } },
];

function getEffectiveBinding(id) {
  const custom = getCustomShortcuts();
  if (custom[id]) return custom[id];
  const entry = SHORTCUT_REGISTRY.find(e => e.id === id);
  return entry ? entry.defaultBinding : null;
}

function bindingMatchesEvent(binding, e) {
  if (!binding) return false;
  const key = binding.key.toLowerCase();
  const eventKey = e.key.toLowerCase();
  // Handle shift+\ producing | on US keyboards
  if (key === '\\' && binding.shiftKey && (eventKey === '\\' || eventKey === '|')) {
    return (e.metaKey || e.ctrlKey) === !!binding.metaKey && e.shiftKey === !!binding.shiftKey && e.altKey === !!binding.altKey;
  }
  if (eventKey !== key) return false;
  return (e.metaKey || e.ctrlKey) === !!binding.metaKey && e.shiftKey === !!binding.shiftKey && e.altKey === !!binding.altKey;
}

function formatShortcut(binding) {
  if (!binding) return '';
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const parts = [];
  if (binding.metaKey) parts.push(isMac ? '⌘' : 'Ctrl');
  if (binding.shiftKey) parts.push(isMac ? '⇧' : 'Shift');
  if (binding.altKey) parts.push(isMac ? '⌥' : 'Alt');
  const keyMap = { '\\': '\\', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', enter: '↵', escape: 'Esc', backspace: '⌫', delete: 'Del', ' ': 'Space' };
  const display = keyMap[binding.key.toLowerCase()] || binding.key.toUpperCase();
  parts.push(display);
  return parts.join(isMac ? '' : '+');
}

// ===== Theme Management =====
const THEME_KEY = 'programming-interface-theme';

const lightTerminalTheme = {
  background: '#1E1E1E',
  foreground: '#D4D4D4',
  cursor: '#D4D4D4',
  cursorAccent: '#1E1E1E',
  selectionBackground: '#264F78',
  black: '#1E1E1E',
  red: '#F44747',
  green: '#6A9955',
  yellow: '#DCDCAA',
  blue: '#569CD6',
  magenta: '#C586C0',
  cyan: '#4EC9B0',
  white: '#D4D4D4',
  brightBlack: '#808080',
  brightRed: '#F44747',
  brightGreen: '#6A9955',
  brightYellow: '#DCDCAA',
  brightBlue: '#569CD6',
  brightMagenta: '#C586C0',
  brightCyan: '#4EC9B0',
  brightWhite: '#FFFFFF'
};

const darkTerminalTheme = {
  background: '#0D0D0D',
  foreground: '#E8E6E3',
  cursor: '#E8E6E3',
  cursorAccent: '#0D0D0D',
  selectionBackground: '#3A3A3A',
  black: '#0D0D0D',
  red: '#F44747',
  green: '#6A9955',
  yellow: '#DCDCAA',
  blue: '#569CD6',
  magenta: '#C586C0',
  cyan: '#4EC9B0',
  white: '#E8E6E3',
  brightBlack: '#808080',
  brightRed: '#F44747',
  brightGreen: '#6A9955',
  brightYellow: '#DCDCAA',
  brightBlue: '#569CD6',
  brightMagenta: '#C586C0',
  brightCyan: '#4EC9B0',
  brightWhite: '#FFFFFF'
};

function getCurrentTheme() {
  return cachedPreferences.theme || 'light';
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  cachedPreferences.theme = theme;
  window.electronAPI.storeWrite('preferences.json', cachedPreferences);

  // Update all terminal themes
  const terminalTheme = theme === 'dark' ? darkTerminalTheme : lightTerminalTheme;
  for (const [, data] of projectData) {
    for (const tab of data.tabs) {
      tab.terminal.options.theme = terminalTheme;
    }
  }
}

function initTheme() {
  const savedTheme = getCurrentTheme();
  setTheme(savedTheme);
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  const currentTheme = getCurrentTheme();
  setTheme(currentTheme === 'light' ? 'dark' : 'light');
});

// Theme init deferred to initDataStore()

// ===== Terminal Management =====
function generateTerminalId() {
  return `term-${Date.now()}-${++terminalCounter}`;
}

function createTerminalInstance(options = {}) {
  const theme = getCurrentTheme() === 'dark' ? darkTerminalTheme : lightTerminalTheme;

  const terminal = new Terminal({
    theme,
    fontFamily: options.fontFamily || '"SF Mono", "Fira Code", "JetBrains Mono", monospace',
    fontSize: options.fontSize ? parseInt(options.fontSize) : 13,
    lineHeight: 1.4,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 10000
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const webLinksAddon = new WebLinksAddon((event, url) => {
    window.electronAPI.openExternal(url);
  });
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(webLinksAddon);

  return { terminal, fitAddon, searchAddon };
}

function initGlobalTerminalListeners() {
  if (listenersInitialized) return;
  listenersInitialized = true;

  window.electronAPI.onTerminalData((id, data) => {
    for (const [path, data_] of projectData) {
      for (const tab of data_.tabs) {
        if (tab.id === id) {
          tab.terminal.write(data);
          return;
        }
      }
    }
  });

  window.electronAPI.onTerminalExit((id, exitCode) => {
    for (const [path, data_] of projectData) {
      for (const tab of data_.tabs) {
        if (tab.id === id) {
          tab.terminal.write(`\r\n\x1b[90mProcess exited with code ${exitCode}\x1b[0m\r\n`);
          return;
        }
      }
    }
  });
}

function getProjectData(projectPath) {
  if (!projectData.has(projectPath)) {
    projectData.set(projectPath, { tabs: [], activeTabIndex: 0 });
  }
  return projectData.get(projectPath);
}

function renderTerminalTabs() {
  const tabsContainer = document.getElementById('terminal-tabs');

  if (!currentProject) {
    tabsContainer.innerHTML = '';
    return;
  }

  const data = getProjectData(currentProject.path);

  tabsContainer.innerHTML = data.tabs.map((tab, index) => {
    // Determine if this tab is in split view and which pane
    let splitIndicator = '';
    let splitClass = '';
    let broadcastClass = broadcastMode ? 'broadcast-active' : '';
    let broadcastIndicator = broadcastMode ? '<span class="broadcast-indicator"></span>' : '';
    if (splitState.active && isTerminalInSplit(tab.id)) {
      splitClass = 'in-split';
      const isVertical = splitState.direction === 'vertical';
      if (tab.id === splitState.leftId) {
        const label = isVertical ? 'Top pane' : 'Left pane';
        const icon = isVertical ? '⬆' : '◧';
        splitIndicator = `<span class="split-indicator split-left" title="${label}">${icon}</span>`;
      } else {
        const label = isVertical ? 'Bottom pane' : 'Right pane';
        const icon = isVertical ? '⬇' : '◨';
        splitIndicator = `<span class="split-indicator split-right" title="${label}">${icon}</span>`;
      }
    }

    return `
      <div class="terminal-tab ${index === data.activeTabIndex ? 'active' : ''} ${splitClass} ${broadcastClass}"
           data-index="${index}" data-id="${tab.id}" draggable="true">
        ${broadcastIndicator}
        ${splitIndicator}
        <span class="terminal-tab-name">${tab.name}</span>
        ${data.tabs.length > 1 ? `
          <button class="terminal-tab-close" data-index="${index}" title="Close">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        ` : ''}
      </div>
    `;
  }).join('');

  // Add click handlers
  tabsContainer.querySelectorAll('.terminal-tab').forEach(tabEl => {
    tabEl.addEventListener('click', (e) => {
      if (e.target.closest('.terminal-tab-close')) return;
      const index = parseInt(tabEl.dataset.index);
      switchToTab(index);
    });

    // Drag and drop for tab reordering and splitting
    tabEl.addEventListener('dragstart', (e) => {
      tabEl.classList.add('dragging');
      e.dataTransfer.setData('text/plain', tabEl.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
    });

    tabEl.addEventListener('dragend', () => {
      tabEl.classList.remove('dragging');
      tabsContainer.querySelectorAll('.terminal-tab').forEach(t => {
        t.classList.remove('drag-over', 'drag-over-split');
      });
    });

    tabEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      const draggingTab = tabsContainer.querySelector('.terminal-tab.dragging');
      if (draggingTab === tabEl) return;

      // Show split indicator when hovering over another tab
      tabEl.classList.add('drag-over-split');
    });

    tabEl.addEventListener('dragleave', () => {
      tabEl.classList.remove('drag-over', 'drag-over-split');
    });

    tabEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const draggedId = e.dataTransfer.getData('text/plain');
      const targetId = tabEl.dataset.id;

      if (draggedId === targetId) return;

      tabEl.classList.remove('drag-over', 'drag-over-split');

      // Enter split mode with these two terminals
      enterSplitMode(targetId, draggedId);
    });
  });

  // Add close handlers
  tabsContainer.querySelectorAll('.terminal-tab-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = parseInt(btn.dataset.index);
      closeTab(index);
    });
  });

  updateTabScrollButtons();
}

function switchToTab(index) {
  if (!currentProject) return;

  const data = getProjectData(currentProject.path);
  if (index < 0 || index >= data.tabs.length) return;

  const tab = data.tabs[index];

  // If in split mode, handle differently
  if (splitState.active) {
    // If this tab is already in split view, just focus it
    if (isTerminalInSplit(tab.id)) {
      data.activeTabIndex = index;
      activeTerminalId = tab.id;
      tab.terminal.focus();
      renderTerminalTabs();
      return;
    }

    // Otherwise, swap it into the currently active pane
    // Determine which pane is active based on activeTerminalId
    const pane = activeTerminalId === splitState.leftId ? 'left' : 'right';
    swapTerminalToPane(tab.id, pane);
    data.activeTabIndex = index;
    activeTerminalId = tab.id;
    return;
  }

  const terminalContent = document.getElementById('terminal-content');

  // Hide all containers
  data.tabs.forEach(t => {
    t.container.style.display = 'none';
  });

  // Show selected
  data.activeTabIndex = index;
  tab.container.style.display = 'block';
  activeTerminalId = tab.id;

  // Refit and focus
  setTimeout(() => {
    tab.fitAddon.fit();
    window.electronAPI.terminalResize(tab.id, tab.terminal.cols, tab.terminal.rows);
    tab.terminal.focus();
  }, 50);

  renderTerminalTabs();
  scrollActiveTabIntoView();
}

async function closeTab(index) {
  if (!currentProject) return;

  const data = getProjectData(currentProject.path);
  if (data.tabs.length <= 1) return; // Keep at least one tab

  const tab = data.tabs[index];

  // If closing a tab that's in split mode, exit split first
  if (splitState.active && isTerminalInSplit(tab.id)) {
    // Determine which terminal will remain
    const remainingId = tab.id === splitState.leftId ? splitState.rightId : splitState.leftId;
    const remainingTab = getTabById(remainingId);

    exitSplitMode(false);

    // Show the remaining terminal
    if (remainingTab) {
      const remainingIndex = getTabIndex(remainingId);
      data.activeTabIndex = remainingIndex;
      activeTerminalId = remainingId;
    }
  }

  // Kill PTY process
  await window.electronAPI.terminalKill(tab.id);

  // Remove container
  tab.container.remove();

  // Remove from array
  data.tabs.splice(index, 1);

  // Adjust active index
  if (data.activeTabIndex >= data.tabs.length) {
    data.activeTabIndex = data.tabs.length - 1;
  }

  // Show the new active tab
  const newActiveTab = data.tabs[data.activeTabIndex];
  if (newActiveTab) {
    data.tabs.forEach(t => {
      t.container.style.display = 'none';
    });
    newActiveTab.container.style.display = 'block';
    activeTerminalId = newActiveTab.id;
    setTimeout(() => {
      newActiveTab.fitAddon.fit();
      window.electronAPI.terminalResize(newActiveTab.id, newActiveTab.terminal.cols, newActiveTab.terminal.rows);
      newActiveTab.terminal.focus();
    }, 50);
  }

  renderTerminalTabs();
}

async function createNewTab(projectPath, cwd, name = null) {
  initGlobalTerminalListeners();

  const data = getProjectData(projectPath);
  const tabNumber = data.tabs.length + 1;
  const tabName = name || `Terminal ${tabNumber}`;
  const id = generateTerminalId();

  const terminalContent = document.getElementById('terminal-content');

  // Hide placeholder
  const placeholder = terminalContent.querySelector('.terminal-placeholder');
  if (placeholder) placeholder.style.display = 'none';

  // Hide other containers
  data.tabs.forEach(tab => {
    tab.container.style.display = 'none';
  });

  // Create container
  const container = document.createElement('div');
  container.className = 'terminal-container';
  container.id = `terminal-${id}`;
  terminalContent.appendChild(container);

  // Resolve active profile for font options
  const activeProfile = getActiveProfile();
  const profileFontOpts = {};
  if (activeProfile) {
    if (activeProfile.fontSize) profileFontOpts.fontSize = activeProfile.fontSize;
    if (activeProfile.fontFamily) profileFontOpts.fontFamily = activeProfile.fontFamily;
  }

  const fontOpts = { ...profileFontOpts };

  // Create terminal
  const { terminal, fitAddon, searchAddon } = createTerminalInstance(fontOpts);
  terminal.open(container);

  // Handle input (with broadcast support)
  terminal.onData((inputData) => {
    if (broadcastMode && currentProject && projectData.has(currentProject.path)) {
      const tabs = projectData.get(currentProject.path).tabs;
      for (const tab of tabs) {
        window.electronAPI.terminalInput(tab.id, inputData);
      }
    } else {
      window.electronAPI.terminalInput(id, inputData);
    }
  });

  // Copy/Paste support
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    const isMeta = event.metaKey || event.ctrlKey;

    // Cmd/Ctrl+C: copy selection if text is selected, otherwise send SIGINT
    if (isMeta && event.key === 'c') {
      if (terminal.hasSelection()) {
        navigator.clipboard.writeText(terminal.getSelection());
        terminal.clearSelection();
        return false;
      }
      return true;
    }

    // Cmd/Ctrl+V: paste from clipboard (with broadcast support)
    if (isMeta && event.key === 'v') {
      navigator.clipboard.readText().then(text => {
        if (text) {
          if (broadcastMode && currentProject && projectData.has(currentProject.path)) {
            const tabs = projectData.get(currentProject.path).tabs;
            for (const tab of tabs) {
              window.electronAPI.terminalInput(tab.id, text);
            }
          } else {
            window.electronAPI.terminalInput(id, text);
          }
        }
      });
      return false;
    }

    return true;
  });

  // Get project settings for shell, env, and startup command
  const settings = getProjectSettings(projectPath);
  const terminalOptions = {};

  // Profile provides shell/env defaults, project settings override
  if (activeProfile && activeProfile.shell) terminalOptions.shell = activeProfile.shell;
  if (activeProfile && activeProfile.env) terminalOptions.env = activeProfile.env;
  if (settings.shell) terminalOptions.shell = settings.shell;
  if (settings.env) terminalOptions.env = settings.env;
  // Only run startup command on first terminal of a project
  if (settings.startup && data.tabs.length === 0) {
    terminalOptions.startup = settings.startup;
  }

  // Create PTY with project settings
  await window.electronAPI.terminalCreate(id, cwd, terminalOptions);

  // Store tab data
  const tabData = { id, name: tabName, terminal, fitAddon, searchAddon, container };
  data.tabs.push(tabData);
  data.activeTabIndex = data.tabs.length - 1;
  activeTerminalId = id;

  // Fit after delay
  setTimeout(() => {
    fitAddon.fit();
    window.electronAPI.terminalResize(id, terminal.cols, terminal.rows);
    terminal.focus();
  }, 100);

  // Setup resize observer
  const resizeObserver = new ResizeObserver(() => {
    if (activeTerminalId === id && container.style.display !== 'none') {
      fitAddon.fit();
      window.electronAPI.terminalResize(id, terminal.cols, terminal.rows);
    }
  });
  resizeObserver.observe(terminalContent);

  renderTerminalTabs();
}

async function initTerminalForProject(projectPath, cwd) {
  const terminalContent = document.getElementById('terminal-content');

  // Check if project already has terminals
  if (projectData.has(projectPath) && projectData.get(projectPath).tabs.length > 0) {
    const data = projectData.get(projectPath);

    // Hide all other project containers first
    terminalContent.querySelectorAll('.terminal-container').forEach(c => {
      c.style.display = 'none';
    });

    // Hide placeholder
    const placeholder = terminalContent.querySelector('.terminal-placeholder');
    if (placeholder) placeholder.style.display = 'none';

    // Show this project's active tab
    switchToTab(data.activeTabIndex);
    renderTerminalTabs();
    return;
  }

  // Hide everything first
  terminalContent.querySelectorAll('.terminal-container').forEach(c => {
    c.style.display = 'none';
  });

  // Create first tab for this project
  await createNewTab(projectPath, cwd, 'Terminal 1');
}

// New terminal button
document.getElementById('new-terminal-btn').addEventListener('click', () => {
  if (currentProject) {
    createNewTab(currentProject.path, currentProject.path);
  }
});

// Split terminal state - tracks which terminals are in split view
let splitState = {
  active: false,
  leftId: null,
  rightId: null,
  direction: 'horizontal'
};

// Helper functions to work with terminal tabs by ID
function getTabById(terminalId) {
  if (!currentProject || !projectData.has(currentProject.path)) return null;
  const data = projectData.get(currentProject.path);
  return data.tabs.find(t => t.id === terminalId) || null;
}

function getTabIndex(terminalId) {
  if (!currentProject || !projectData.has(currentProject.path)) return -1;
  const data = projectData.get(currentProject.path);
  return data.tabs.findIndex(t => t.id === terminalId);
}

// Enter split mode with two specific terminals
async function enterSplitMode(leftId, rightId, direction = 'horizontal') {
  if (!currentProject || !projectData.has(currentProject.path)) return;

  const data = projectData.get(currentProject.path);
  const terminalContent = document.getElementById('terminal-content');

  // Get the tabs
  let leftTab = getTabById(leftId);
  let rightTab = getTabById(rightId);

  // If no right terminal specified, create one
  if (!rightTab) {
    await createNewTab(currentProject.path, currentProject.path);
    rightTab = data.tabs[data.tabs.length - 1];
    rightId = rightTab.id;
  }

  if (!leftTab || !rightTab) return;

  // Exit any existing split first
  if (splitState.active) {
    exitSplitMode(false);
  }

  // Update split state
  splitState = {
    active: true,
    leftId: leftId,
    rightId: rightId,
    direction: direction
  };

  // Hide all containers first
  data.tabs.forEach(tab => {
    tab.container.style.display = 'none';
  });

  // Hide placeholder and search
  const placeholder = terminalContent.querySelector('.terminal-placeholder');
  if (placeholder) placeholder.style.display = 'none';

  const searchBar = terminalContent.querySelector('.terminal-search');
  if (searchBar) searchBar.style.display = 'none';

  // Remove any existing split container
  const existingSplit = terminalContent.querySelector('.terminal-split-container');
  if (existingSplit) existingSplit.remove();

  // Create split container
  const splitContainer = document.createElement('div');
  splitContainer.className = `terminal-split-container ${direction}`;

  // Create panes
  const pane1 = document.createElement('div');
  pane1.className = 'terminal-split-pane';
  pane1.dataset.terminalId = leftId;

  const resizeHandle = document.createElement('div');
  resizeHandle.className = `split-resize-handle ${direction}`;

  const pane2 = document.createElement('div');
  pane2.className = 'terminal-split-pane';
  pane2.dataset.terminalId = rightId;

  // Move terminal containers into panes
  pane1.appendChild(leftTab.container);
  leftTab.container.style.display = 'block';

  pane2.appendChild(rightTab.container);
  rightTab.container.style.display = 'block';

  // Add click handlers to focus pane
  pane1.addEventListener('click', () => {
    activeTerminalId = leftId;
    data.activeTabIndex = getTabIndex(leftId);
    renderTerminalTabs();
  });

  pane2.addEventListener('click', () => {
    activeTerminalId = rightId;
    data.activeTabIndex = getTabIndex(rightId);
    renderTerminalTabs();
  });

  splitContainer.appendChild(pane1);
  splitContainer.appendChild(resizeHandle);
  splitContainer.appendChild(pane2);

  terminalContent.appendChild(splitContainer);

  // Fit both terminals after DOM update
  setTimeout(() => {
    leftTab.fitAddon.fit();
    rightTab.fitAddon.fit();
    window.electronAPI.terminalResize(leftId, leftTab.terminal.cols, leftTab.terminal.rows);
    window.electronAPI.terminalResize(rightId, rightTab.terminal.cols, rightTab.terminal.rows);
    leftTab.terminal.focus();
  }, 100);

  // Setup split resize
  setupSplitResize(resizeHandle, pane1, pane2, direction);
  renderTerminalTabs();
}

// Exit split mode
function exitSplitMode(rerender = true) {
  if (!splitState.active) return;
  if (!currentProject || !projectData.has(currentProject.path)) return;

  const data = projectData.get(currentProject.path);
  const terminalContent = document.getElementById('terminal-content');

  // Move all terminals back to terminalContent
  data.tabs.forEach(tab => {
    terminalContent.appendChild(tab.container);
    tab.container.style.display = 'none';
  });

  // Remove split container
  const splitContainer = terminalContent.querySelector('.terminal-split-container');
  if (splitContainer) splitContainer.remove();

  // Reset split state
  splitState = {
    active: false,
    leftId: null,
    rightId: null,
    direction: 'horizontal'
  };

  // Show active tab
  if (rerender) {
    const activeTab = data.tabs[data.activeTabIndex];
    if (activeTab) {
      activeTab.container.style.display = 'block';
      setTimeout(() => {
        activeTab.fitAddon.fit();
        window.electronAPI.terminalResize(activeTab.id, activeTab.terminal.cols, activeTab.terminal.rows);
        activeTab.terminal.focus();
      }, 50);
    }
    renderTerminalTabs();
  }
}

// Toggle split: if active with same direction, exit; different direction, re-enter; not split, enter
async function splitTerminal(direction = 'horizontal') {
  if (!currentProject || !projectData.has(currentProject.path)) return;

  const data = projectData.get(currentProject.path);
  if (data.tabs.length === 0) return;

  if (splitState.active) {
    if (splitState.direction === direction) {
      // Same direction: toggle off
      exitSplitMode();
    } else {
      // Different direction: re-enter with swapped direction, keeping same terminals
      const leftId = splitState.leftId;
      const rightId = splitState.rightId;
      exitSplitMode(false);
      await enterSplitMode(leftId, rightId, direction);
    }
  } else {
    // Enter split mode with current tab on left, new tab on right
    const currentTab = data.tabs[data.activeTabIndex];
    await enterSplitMode(currentTab.id, null, direction);
  }
}

// Swap a terminal into a split pane (for drag-drop)
function swapTerminalToPane(terminalId, pane) {
  if (!splitState.active) return;
  if (!currentProject || !projectData.has(currentProject.path)) return;

  const data = projectData.get(currentProject.path);
  const terminalContent = document.getElementById('terminal-content');
  const splitContainer = terminalContent.querySelector('.terminal-split-container');
  if (!splitContainer) return;

  const newTab = getTabById(terminalId);
  if (!newTab) return;

  // Determine which pane
  const panes = splitContainer.querySelectorAll('.terminal-split-pane');
  const targetPane = pane === 'left' ? panes[0] : panes[1];
  const oldId = pane === 'left' ? splitState.leftId : splitState.rightId;

  // Don't swap if it's the same terminal
  if (oldId === terminalId) return;

  // Don't allow same terminal in both panes
  if ((pane === 'left' && splitState.rightId === terminalId) ||
      (pane === 'right' && splitState.leftId === terminalId)) {
    // Swap the panes instead
    const temp = splitState.leftId;
    splitState.leftId = splitState.rightId;
    splitState.rightId = temp;

    const leftTab = getTabById(splitState.leftId);
    const rightTab = getTabById(splitState.rightId);

    panes[0].innerHTML = '';
    panes[1].innerHTML = '';

    if (leftTab) {
      panes[0].appendChild(leftTab.container);
      leftTab.container.style.display = 'block';
    }
    if (rightTab) {
      panes[1].appendChild(rightTab.container);
      rightTab.container.style.display = 'block';
    }

    renderTerminalTabs();
    return;
  }

  // Get old tab and hide it
  const oldTab = getTabById(oldId);
  if (oldTab) {
    terminalContent.appendChild(oldTab.container);
    oldTab.container.style.display = 'none';
  }

  // Move new tab into pane
  targetPane.innerHTML = '';
  targetPane.appendChild(newTab.container);
  newTab.container.style.display = 'block';

  // Update state
  if (pane === 'left') {
    splitState.leftId = terminalId;
  } else {
    splitState.rightId = terminalId;
  }

  // Fit and focus
  setTimeout(() => {
    newTab.fitAddon.fit();
    window.electronAPI.terminalResize(terminalId, newTab.terminal.cols, newTab.terminal.rows);
    newTab.terminal.focus();
  }, 50);

  renderTerminalTabs();
}

// Check if a terminal is currently in split view
function isTerminalInSplit(terminalId) {
  return splitState.active && (splitState.leftId === terminalId || splitState.rightId === terminalId);
}

// Split terminal buttons
document.getElementById('split-terminal-btn').addEventListener('click', () => {
  splitTerminal('horizontal');
});
document.getElementById('split-terminal-v-btn').addEventListener('click', () => {
  splitTerminal('vertical');
});

function setupSplitResize(handle, pane1, pane2, direction) {
  let isResizing = false;
  let startPos = 0;
  let startSize1 = 0;
  let startSize2 = 0;

  handle.addEventListener('mousedown', (e) => {
    isResizing = true;
    startPos = direction === 'horizontal' ? e.clientX : e.clientY;
    startSize1 = direction === 'horizontal' ? pane1.offsetWidth : pane1.offsetHeight;
    startSize2 = direction === 'horizontal' ? pane2.offsetWidth : pane2.offsetHeight;
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    const currentPos = direction === 'horizontal' ? e.clientX : e.clientY;
    const delta = currentPos - startPos;
    const newSize1 = startSize1 + delta;
    const newSize2 = startSize2 - delta;

    if (newSize1 > 100 && newSize2 > 100) {
      if (direction === 'horizontal') {
        pane1.style.width = `${newSize1}px`;
        pane1.style.flex = 'none';
        pane2.style.flex = '1';
      } else {
        pane1.style.height = `${newSize1}px`;
        pane1.style.flex = 'none';
        pane2.style.flex = '1';
      }
    }
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      // Refit terminals in split mode
      if (splitState.active) {
        const leftTab = getTabById(splitState.leftId);
        const rightTab = getTabById(splitState.rightId);
        if (leftTab) {
          leftTab.fitAddon.fit();
          window.electronAPI.terminalResize(splitState.leftId, leftTab.terminal.cols, leftTab.terminal.rows);
        }
        if (rightTab) {
          rightTab.fitAddon.fit();
          window.electronAPI.terminalResize(splitState.rightId, rightTab.terminal.cols, rightTab.terminal.rows);
        }
      }
    }
  });
}

// Placeholder click
document.getElementById('terminal-content').addEventListener('click', async (e) => {
  if (e.target.closest('.terminal-placeholder')) {
    const homePath = await window.electronAPI.getHomeDirectory();
    currentProject = { path: '__home__', name: 'Home' };
    await createNewTab('__home__', homePath, 'Terminal 1');
  }
});

// ===== Git Panel =====
async function loadGitStatus(projectPath) {
  const gitPanel = document.getElementById('git-panel');

  if (!projectPath) {
    gitPanel.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"/>
          <circle cx="6" cy="6" r="2" stroke="currentColor" stroke-width="1.5"/>
          <circle cx="18" cy="18" r="2" stroke="currentColor" stroke-width="1.5"/>
          <path d="M7.5 7.5L10 10M14 14l2.5 2.5" stroke="currentColor" stroke-width="1.5"/>
        </svg>
        <p>Git Status</p>
        <span>Select a project to view</span>
      </div>
    `;
    return;
  }

  gitPanel.innerHTML = '<div class="loading">Loading...</div>';

  const status = await window.electronAPI.gitStatus(projectPath);

  if (!status.isRepo) {
    gitPanel.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"/>
          <circle cx="6" cy="6" r="2" stroke="currentColor" stroke-width="1.5"/>
          <circle cx="18" cy="18" r="2" stroke="currentColor" stroke-width="1.5"/>
          <path d="M7.5 7.5L10 10M14 14l2.5 2.5" stroke="currentColor" stroke-width="1.5"/>
        </svg>
        <p>Not a Git Repository</p>
        <span>Initialize with 'git init'</span>
      </div>
    `;
    return;
  }

  const { branch, files, mergeState } = status;
  const hasChanges = files.staged.length > 0 || files.unstaged.length > 0 || files.untracked.length > 0 || files.conflicted.length > 0;

  // Fetch branches and remote status
  const branchData = await window.electronAPI.gitBranches(projectPath);
  const branches = branchData.success ? branchData.branches : [branch];
  const remoteStatus = await window.electronAPI.gitRemoteStatus(projectPath);

  let html = `
    <div class="git-content">
      <div class="git-header">
        <div class="git-branch-selector">
          <div class="git-branch" id="git-branch-toggle">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9" stroke="currentColor" stroke-width="1.5"/>
            </svg>
            <span>${branch}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" style="margin-left: 4px;">
              <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="git-branch-dropdown" id="git-branch-dropdown">
            ${branches.map(b => `
              <div class="git-branch-item ${b === branch ? 'current' : ''}" data-branch="${b}">
                <span class="check">${b === branch ? '✓' : ''}</span>
                <span class="git-branch-item-name">${b}</span>
                ${b !== branch ? `
                  <div class="git-branch-item-actions">
                    <button class="git-branch-merge-btn" data-branch="${b}" title="Merge into current">Merge</button>
                    <button class="git-branch-rebase-btn" data-branch="${b}" title="Rebase onto this">Rebase</button>
                  </div>
                ` : ''}
              </div>
            `).join('')}
            <div class="git-branch-new">
              <input type="text" class="git-branch-new-input" id="git-new-branch-input" placeholder="New branch name...">
            </div>
          </div>
        </div>
        <button class="icon-btn git-refresh" title="Refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>

      ${remoteStatus.hasRemote ? `
        <div class="git-sync-section">
          <div class="git-sync-status">
            ${remoteStatus.ahead > 0 ? `<span class="git-ahead" title="${remoteStatus.ahead} commit(s) to push">↑${remoteStatus.ahead}</span>` : ''}
            ${remoteStatus.behind > 0 ? `<span class="git-behind" title="${remoteStatus.behind} commit(s) to pull">↓${remoteStatus.behind}</span>` : ''}
            ${remoteStatus.ahead === 0 && remoteStatus.behind === 0 ? '<span class="git-synced">✓ Synced</span>' : ''}
          </div>
          <div class="git-sync-actions">
            <button class="git-sync-btn" id="git-pull-btn" title="Pull changes" ${remoteStatus.behind === 0 ? 'disabled' : ''}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M12 3v18M5 14l7 7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              Pull
            </button>
            <button class="git-sync-btn git-push-btn" id="git-push-btn" title="Push changes">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M12 21V3M5 10l7-7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              Push
            </button>
          </div>
        </div>
      ` : `
        <div class="git-sync-section git-no-remote">
          <span class="git-no-remote-text">No remote configured</span>
        </div>
      `}
  `;

  // Merge/Rebase warning banner
  if (mergeState) {
    const isMerging = mergeState === 'merging';
    html += `
      <div class="git-merge-banner ${mergeState}">
        <span class="git-merge-banner-text">${isMerging ? 'Merge in progress' : 'Rebase in progress'}</span>
        <div class="git-merge-banner-actions">
          ${!isMerging ? '<button class="git-merge-banner-btn continue" data-action="rebase-continue">Continue</button>' : ''}
          <button class="git-merge-banner-btn abort" data-action="${isMerging ? 'merge-abort' : 'rebase-abort'}">Abort</button>
        </div>
      </div>
    `;
  }

  // Conflicted files
  if (files.conflicted.length > 0) {
    html += `
      <div class="git-section">
        <div class="git-section-header"><span>Conflicts (${files.conflicted.length})</span></div>
        <div class="git-files">
          ${files.conflicted.map(f => `
            <div class="git-file conflicted">
              <span class="git-status">${f.status}</span>
              <span class="git-filename">${f.name}</span>
              <button class="git-file-action resolve" data-action="stage" data-file="${f.name}" title="Mark Resolved">&#10003;</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // Staged changes
  if (files.staged.length > 0) {
    html += `
      <div class="git-section">
        <div class="git-section-header">
          <span>Staged Changes (${files.staged.length})</span>
          <button class="git-action-btn" data-action="unstage-all" title="Unstage All">−</button>
        </div>
        <div class="git-files">
          ${files.staged.map(f => `
            <div class="git-file staged">
              <span class="git-status">${f.status}</span>
              <span class="git-filename">${f.name}</span>
              <button class="git-file-action" data-action="unstage" data-file="${f.name}" title="Unstage">−</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // Unstaged changes
  if (files.unstaged.length > 0) {
    html += `
      <div class="git-section">
        <div class="git-section-header">
          <span>Changes (${files.unstaged.length})</span>
          <button class="git-action-btn" data-action="stage-modified" title="Stage All Changes">+</button>
        </div>
        <div class="git-files">
          ${files.unstaged.map(f => `
            <div class="git-file modified">
              <span class="git-status">${f.status}</span>
              <span class="git-filename">${f.name}</span>
              <div class="git-file-actions">
                <button class="git-file-action" data-action="stage" data-file="${f.name}" title="Stage">+</button>
                <button class="git-file-action discard" data-action="discard" data-file="${f.name}" title="Discard">×</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // Untracked files
  if (files.untracked.length > 0) {
    html += `
      <div class="git-section">
        <div class="git-section-header">
          <span>Untracked (${files.untracked.length})</span>
          <button class="git-action-btn" data-action="stage-all" title="Stage All">+</button>
        </div>
        <div class="git-files">
          ${files.untracked.map(f => `
            <div class="git-file untracked">
              <span class="git-status">?</span>
              <span class="git-filename">${f.name}</span>
              <button class="git-file-action" data-action="stage" data-file="${f.name}" title="Stage">+</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // Clean state
  if (!hasChanges) {
    html += `
      <div class="git-section">
        <div class="git-clean">Working tree clean</div>
      </div>
    `;
  }

  // Commit section (only show if there are staged changes)
  if (files.staged.length > 0) {
    html += `
      <div class="git-section git-commit-section">
        <input type="text" class="git-commit-input" id="git-commit-message" placeholder="Commit message...">
        <button class="git-commit-btn" id="git-commit-btn">Commit</button>
      </div>
    `;
  }

  // Stash section
  html += `
    <div class="git-section git-stash-section">
      <div class="git-section-header">
        <span>Stashes</span>
        <div class="git-stash-actions-header">
          <button class="git-action-btn git-stash-save-btn" title="Stash changes">+</button>
        </div>
      </div>
      <div class="git-stash-save-form" id="git-stash-form" style="display:none;">
        <input type="text" class="git-stash-input" id="git-stash-message" placeholder="Stash message (optional)...">
        <button class="git-stash-confirm" id="git-stash-confirm">Save</button>
      </div>
      <div class="git-stash-list" id="git-stash-list">
        <div class="loading" style="font-size:11px;">Loading...</div>
      </div>
    </div>
  `;

  // Tags section
  html += `
    <div class="git-section git-tags-section">
      <div class="git-section-header">
        <span>Tags</span>
        <div class="git-tags-actions-header">
          <button class="git-action-btn git-tag-create-btn" title="Create tag">+</button>
          ${remoteStatus.hasRemote ? '<button class="git-action-btn git-tag-push-all-btn" title="Push all tags">&#8593;</button>' : ''}
        </div>
      </div>
      <div class="git-tag-create-form" id="git-tag-form" style="display:none;">
        <input type="text" class="git-tag-input" id="git-tag-name" placeholder="Tag name...">
        <input type="text" class="git-tag-input" id="git-tag-message" placeholder="Message (optional, for annotated)...">
        <button class="git-tag-confirm" id="git-tag-confirm">Create</button>
      </div>
      <div class="git-tag-list" id="git-tag-list">
        <div class="loading" style="font-size:11px;">Loading...</div>
      </div>
    </div>
  `;

  // Recent commits (paginated)
  html += `
    <div class="git-section">
      <div class="git-section-header"><span>Commits</span></div>
      <div class="git-commits-scroll" id="git-commits-scroll">
        <div class="loading" style="font-size:11px;">Loading...</div>
      </div>
    </div>
  `;

  html += '</div>';
  gitPanel.innerHTML = html;

  // Load async sections
  loadCommitHistory(projectPath);
  loadStashList(projectPath);
  loadTagList(projectPath);

  // Add event listeners
  attachGitEventListeners(projectPath);
}

function attachGitEventListeners(projectPath) {
  const gitPanel = document.getElementById('git-panel');

  // Branch toggle dropdown
  const branchToggle = gitPanel.querySelector('#git-branch-toggle');
  const branchDropdown = gitPanel.querySelector('#git-branch-dropdown');

  if (branchToggle && branchDropdown) {
    branchToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      branchDropdown.classList.toggle('active');
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', () => {
      branchDropdown.classList.remove('active');
    });

    // Branch selection
    branchDropdown.querySelectorAll('.git-branch-item').forEach(item => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        const branchName = item.dataset.branch;
        if (item.classList.contains('current')) {
          branchDropdown.classList.remove('active');
          return;
        }

        const result = await window.electronAPI.gitCheckout(projectPath, branchName);
        if (result.success) {
          branchDropdown.classList.remove('active');
          loadGitStatus(projectPath);
        } else {
          alert('Failed to switch branch: ' + result.error);
        }
      });
    });

    // New branch input
    const newBranchInput = gitPanel.querySelector('#git-new-branch-input');
    if (newBranchInput) {
      newBranchInput.addEventListener('click', (e) => e.stopPropagation());
      newBranchInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          const name = newBranchInput.value.trim();
          if (!name) return;

          const result = await window.electronAPI.gitCreateBranch(projectPath, name);
          if (result.success) {
            newBranchInput.value = '';
            branchDropdown.classList.remove('active');
            loadGitStatus(projectPath);
          } else {
            alert('Failed to create branch: ' + result.error);
          }
        }
      });
    }
  }

  // Refresh button
  gitPanel.querySelector('.git-refresh')?.addEventListener('click', () => {
    loadGitStatus(projectPath);
  });

  // Stage/unstage individual files
  gitPanel.querySelectorAll('.git-file-action').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const file = btn.dataset.file;

      if (action === 'stage') {
        await window.electronAPI.gitStage(projectPath, file);
      } else if (action === 'unstage') {
        await window.electronAPI.gitUnstage(projectPath, file);
      } else if (action === 'discard') {
        if (confirm(`Discard changes to ${file}?`)) {
          await window.electronAPI.gitDiscard(projectPath, file);
        }
      }

      loadGitStatus(projectPath);
    });
  });

  // Bulk actions
  gitPanel.querySelectorAll('.git-action-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;

      if (action === 'stage-all' || action === 'stage-modified') {
        await window.electronAPI.gitStageAll(projectPath);
      } else if (action === 'unstage-all') {
        await window.electronAPI.gitUnstageAll(projectPath);
      }

      loadGitStatus(projectPath);
    });
  });

  // Commit
  const commitBtn = gitPanel.querySelector('#git-commit-btn');
  const commitInput = gitPanel.querySelector('#git-commit-message');

  if (commitBtn && commitInput) {
    const doCommit = async () => {
      const message = commitInput.value.trim();
      if (!message) {
        commitInput.focus();
        return;
      }

      const result = await window.electronAPI.gitCommit(projectPath, message);
      if (result.success) {
        commitInput.value = '';
        loadGitStatus(projectPath);
      } else {
        alert('Commit failed: ' + result.error);
      }
    };

    commitBtn.addEventListener('click', doCommit);
    commitInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doCommit();
    });
  }

  // Push button
  const pushBtn = gitPanel.querySelector('#git-push-btn');
  if (pushBtn) {
    pushBtn.addEventListener('click', async () => {
      pushBtn.disabled = true;
      pushBtn.textContent = 'Pushing...';

      try {
        const result = await window.electronAPI.gitPush(projectPath);
        if (result.success) {
          loadGitStatus(projectPath);
        } else {
          // Check if we need to set upstream
          if (result.error && result.error.includes('no upstream branch')) {
            const branchData = await window.electronAPI.gitBranches(projectPath);
            const upstreamResult = await window.electronAPI.gitPushSetUpstream(projectPath, branchData.current);
            if (upstreamResult.success) {
              loadGitStatus(projectPath);
            } else {
              alert('Push failed: ' + upstreamResult.error);
            }
          } else {
            alert('Push failed: ' + result.error);
          }
        }
      } catch (err) {
        alert('Push failed: ' + err.message);
      }

      pushBtn.disabled = false;
      pushBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M12 21V3M5 10l7-7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Push
      `;
    });
  }

  // Pull button
  const pullBtn = gitPanel.querySelector('#git-pull-btn');
  if (pullBtn) {
    pullBtn.addEventListener('click', async () => {
      pullBtn.disabled = true;
      pullBtn.textContent = 'Pulling...';

      try {
        const result = await window.electronAPI.gitPull(projectPath);
        if (result.success) {
          loadGitStatus(projectPath);
        } else {
          alert('Pull failed: ' + result.error);
        }
      } catch (err) {
        alert('Pull failed: ' + err.message);
      }

      pullBtn.disabled = false;
      pullBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M12 3v18M5 14l7 7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Pull
      `;
    });
  }

  // File click to show diff
  gitPanel.querySelectorAll('.git-file').forEach(fileEl => {
    fileEl.addEventListener('click', async (e) => {
      if (e.target.closest('.git-file-action')) return;
      const fileName = fileEl.querySelector('.git-filename').textContent;
      const isStaged = fileEl.classList.contains('staged');
      await showGitDiff(projectPath, fileName, isStaged);
    });
  });

  // Merge/Rebase banner actions
  gitPanel.querySelectorAll('.git-merge-banner-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      let result;
      if (action === 'merge-abort') result = await window.electronAPI.gitMergeAbort(projectPath);
      else if (action === 'rebase-abort') result = await window.electronAPI.gitRebaseAbort(projectPath);
      else if (action === 'rebase-continue') result = await window.electronAPI.gitRebaseContinue(projectPath);
      if (result && !result.success) alert('Failed: ' + result.error);
      loadGitStatus(projectPath);
    });
  });

  // Merge/Rebase from branch dropdown
  gitPanel.querySelectorAll('.git-branch-merge-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const branchName = btn.dataset.branch;
      const result = await window.electronAPI.gitMerge(projectPath, branchName);
      if (!result.success) alert('Merge failed: ' + result.error);
      gitPanel.querySelector('#git-branch-dropdown')?.classList.remove('active');
      loadGitStatus(projectPath);
    });
  });

  gitPanel.querySelectorAll('.git-branch-rebase-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const branchName = btn.dataset.branch;
      const result = await window.electronAPI.gitRebase(projectPath, branchName);
      if (!result.success) alert('Rebase failed: ' + result.error);
      gitPanel.querySelector('#git-branch-dropdown')?.classList.remove('active');
      loadGitStatus(projectPath);
    });
  });

  // Stash section
  const stashSaveBtn = gitPanel.querySelector('.git-stash-save-btn');
  const stashForm = gitPanel.querySelector('#git-stash-form');
  if (stashSaveBtn && stashForm) {
    stashSaveBtn.addEventListener('click', () => {
      stashForm.style.display = stashForm.style.display === 'none' ? 'flex' : 'none';
    });
  }

  const stashConfirm = gitPanel.querySelector('#git-stash-confirm');
  if (stashConfirm) {
    stashConfirm.addEventListener('click', async () => {
      const msg = gitPanel.querySelector('#git-stash-message').value.trim();
      const result = await window.electronAPI.gitStashSave(projectPath, msg || null);
      if (!result.success) { alert('Stash failed: ' + result.error); return; }
      stashForm.style.display = 'none';
      gitPanel.querySelector('#git-stash-message').value = '';
      loadStashList(projectPath);
      loadGitStatus(projectPath);
    });
  }

  // Tag section
  const tagCreateBtn = gitPanel.querySelector('.git-tag-create-btn');
  const tagForm = gitPanel.querySelector('#git-tag-form');
  if (tagCreateBtn && tagForm) {
    tagCreateBtn.addEventListener('click', () => {
      tagForm.style.display = tagForm.style.display === 'none' ? 'flex' : 'none';
    });
  }

  const tagConfirm = gitPanel.querySelector('#git-tag-confirm');
  if (tagConfirm) {
    tagConfirm.addEventListener('click', async () => {
      const name = gitPanel.querySelector('#git-tag-name').value.trim();
      if (!name) return;
      const msg = gitPanel.querySelector('#git-tag-message').value.trim();
      const result = await window.electronAPI.gitTagCreate(projectPath, name, msg || null);
      if (!result.success) { alert('Tag creation failed: ' + result.error); return; }
      tagForm.style.display = 'none';
      gitPanel.querySelector('#git-tag-name').value = '';
      gitPanel.querySelector('#git-tag-message').value = '';
      loadTagList(projectPath);
    });
  }

  const tagPushAllBtn = gitPanel.querySelector('.git-tag-push-all-btn');
  if (tagPushAllBtn) {
    tagPushAllBtn.addEventListener('click', async () => {
      const result = await window.electronAPI.gitTagPush(projectPath, '--all');
      if (!result.success) alert('Push tags failed: ' + result.error);
    });
  }
}

// ===== Commit History (Paginated) =====
let commitHistorySkip = 0;

async function loadCommitHistory(projectPath, append = false) {
  const container = document.getElementById('git-commits-scroll');
  if (!container) return;

  if (!append) {
    commitHistorySkip = 0;
    container.innerHTML = '<div class="loading" style="font-size:11px;">Loading...</div>';
  }

  const result = await window.electronAPI.gitLog(projectPath, commitHistorySkip, 20);
  if (!result.success) {
    if (!append) container.innerHTML = '<div class="git-clean">No commits yet</div>';
    return;
  }

  if (!append) container.innerHTML = '';

  // Remove existing load-more button
  container.querySelector('.git-load-more')?.remove();

  for (const c of result.commits) {
    const div = document.createElement('div');
    div.className = 'git-commit clickable';
    div.innerHTML = `
      <span class="git-hash">${c.hash.substring(0, 7)}</span>
      <span class="git-message">${escapeHtml(c.message)}</span>
      <span class="git-commit-meta">${c.author} &middot; ${formatRelativeDate(c.date)}</span>
    `;
    div.addEventListener('click', () => showCommitDetail(projectPath, c.hash));
    container.appendChild(div);
  }

  commitHistorySkip += result.commits.length;

  // Add load more button if we got a full page
  if (result.commits.length >= 20) {
    const loadMore = document.createElement('button');
    loadMore.className = 'git-load-more';
    loadMore.textContent = 'Load more...';
    loadMore.addEventListener('click', () => loadCommitHistory(projectPath, true));
    container.appendChild(loadMore);
  }
}

async function showCommitDetail(projectPath, hash) {
  const result = await window.electronAPI.gitShow(projectPath, hash);
  const previewTab = document.getElementById('preview-tab');

  // Switch to preview tab
  document.querySelectorAll('.context-tabs .tab').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="preview"]').classList.add('active');
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  previewTab.classList.add('active');

  if (!result.success || !result.output) {
    previewTab.innerHTML = `<div class="file-preview"><div class="preview-header"><span class="preview-filename">Commit ${hash.substring(0, 7)}</span></div><div class="diff-empty">Could not load commit</div></div>`;
    return;
  }

  // Split header from diff content
  const output = result.output;
  const diffStart = output.indexOf('\ndiff --git');
  const header = diffStart !== -1 ? output.substring(0, diffStart) : output;
  const diffText = diffStart !== -1 ? output.substring(diffStart + 1) : '';

  // Parse header lines
  const headerLines = header.split('\n');
  const commitHash = headerLines[0] || hash;
  const author = headerLines[1] || '';
  const date = headerLines[2] || '';
  const message = headerLines.slice(3).join('\n').trim();

  let html = `
    <div class="file-preview">
      <div class="preview-header">
        <span class="preview-filename">Commit ${commitHash.substring(0, 7)}</span>
      </div>
      <div class="commit-detail">
        <div class="commit-detail-header">
          <div class="commit-detail-hash">${commitHash.substring(0, 10)}</div>
          <div class="commit-detail-meta">${escapeHtml(author)} &middot; ${formatRelativeDate(date)}</div>
          <div class="commit-detail-message">${escapeHtml(message)}</div>
        </div>
  `;

  if (diffText) {
    renderDiffView(previewTab, diffText, `Commit ${commitHash.substring(0, 7)}`);
    // Prepend the commit detail header
    const viewer = previewTab.querySelector('.file-preview');
    if (viewer) {
      const detailDiv = document.createElement('div');
      detailDiv.className = 'commit-detail-header';
      detailDiv.innerHTML = `
        <div class="commit-detail-hash">${commitHash.substring(0, 10)}</div>
        <div class="commit-detail-meta">${escapeHtml(author)} &middot; ${formatRelativeDate(date)}</div>
        <div class="commit-detail-message">${escapeHtml(message)}</div>
      `;
      const diffViewer = viewer.querySelector('.diff-viewer');
      if (diffViewer) viewer.insertBefore(detailDiv, diffViewer);
    }
  } else {
    html += '<div class="diff-empty">No diff content</div></div></div>';
    previewTab.innerHTML = html;
  }
}

function formatRelativeDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  if (weeks < 5) return `${weeks}w ago`;
  if (months < 12) return `${months}mo ago`;
  return date.toLocaleDateString();
}

// ===== Stash List =====
async function loadStashList(projectPath) {
  const container = document.getElementById('git-stash-list');
  if (!container) return;

  const result = await window.electronAPI.gitStashList(projectPath);
  if (!result.success || result.stashes.length === 0) {
    container.innerHTML = '<div class="git-clean" style="font-size:11px;padding:6px;">No stashes</div>';
    return;
  }

  container.innerHTML = result.stashes.map(s => `
    <div class="git-stash-item">
      <span class="git-stash-index">${s.index}</span>
      <span class="git-stash-message">${escapeHtml(s.message)}</span>
      <div class="git-stash-actions">
        <button class="git-stash-action" data-action="apply" data-index="${s.index}" title="Apply">&#8631;</button>
        <button class="git-stash-action" data-action="pop" data-index="${s.index}" title="Pop">&#8593;</button>
        <button class="git-stash-action discard" data-action="drop" data-index="${s.index}" title="Drop">&#215;</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.git-stash-action').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const index = btn.dataset.index;
      let result;
      if (action === 'apply') result = await window.electronAPI.gitStashApply(projectPath, index);
      else if (action === 'pop') result = await window.electronAPI.gitStashPop(projectPath, index);
      else if (action === 'drop') {
        if (!confirm(`Drop ${index}?`)) return;
        result = await window.electronAPI.gitStashDrop(projectPath, index);
      }
      if (result && !result.success) alert('Stash action failed: ' + result.error);
      loadStashList(projectPath);
      loadGitStatus(projectPath);
    });
  });
}

// ===== Tag List =====
async function loadTagList(projectPath) {
  const container = document.getElementById('git-tag-list');
  if (!container) return;

  const result = await window.electronAPI.gitTagList(projectPath);
  if (!result.success || result.tags.length === 0) {
    container.innerHTML = '<div class="git-clean" style="font-size:11px;padding:6px;">No tags</div>';
    return;
  }

  container.innerHTML = result.tags.map(t => `
    <div class="git-tag-item">
      <span class="git-tag-name">${escapeHtml(t.name)}</span>
      <span class="git-tag-hash">${t.hash}</span>
      <div class="git-tag-actions">
        <button class="git-tag-action" data-action="push" data-name="${escapeHtml(t.name)}" title="Push">&#8593;</button>
        <button class="git-tag-action discard" data-action="delete" data-name="${escapeHtml(t.name)}" title="Delete">&#215;</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.git-tag-action').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const name = btn.dataset.name;
      let result;
      if (action === 'push') {
        result = await window.electronAPI.gitTagPush(projectPath, name);
      } else if (action === 'delete') {
        if (!confirm(`Delete tag "${name}"?`)) return;
        result = await window.electronAPI.gitTagDelete(projectPath, name);
      }
      if (result && !result.success) alert('Tag action failed: ' + result.error);
      loadTagList(projectPath);
    });
  });
}

// ===== Blame View =====
async function showBlameView(filePath) {
  if (!currentProject) return;

  const previewTab = document.getElementById('preview-tab');
  const relativePath = filePath.startsWith(currentProject.path)
    ? filePath.substring(currentProject.path.length + 1) : filePath;

  const result = await window.electronAPI.gitBlame(currentProject.path, relativePath);

  if (!result.success || !result.output) {
    // Not in git or no blame data — do nothing
    return null;
  }

  // Parse porcelain blame output
  const lines = result.output.split('\n');
  const blameData = [];
  let currentEntry = null;
  let lineContent = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.match(/^[0-9a-f]{40}\s/)) {
      const parts = line.split(' ');
      currentEntry = {
        hash: parts[0],
        origLine: parseInt(parts[1]),
        finalLine: parseInt(parts[2]),
        author: '',
        date: ''
      };
    } else if (line.startsWith('author ') && currentEntry) {
      currentEntry.author = line.substring(7);
    } else if (line.startsWith('author-time ') && currentEntry) {
      const timestamp = parseInt(line.substring(12));
      currentEntry.date = new Date(timestamp * 1000).toISOString();
    } else if (line.startsWith('\t') && currentEntry) {
      lineContent = line.substring(1);
      blameData.push({ ...currentEntry, content: lineContent });
      currentEntry = null;
    }
  }

  return blameData;
}

function renderBlameView(previewTab, blameData, fileName, extension) {
  let html = `
    <div class="file-preview">
      <div class="preview-header">
        <span class="preview-filename">${escapeHtml(fileName)}</span>
        <div class="preview-mode-toggle">
          <button class="preview-mode-btn blame-toggle active" data-mode="blame">Blame</button>
          <button class="preview-mode-btn blame-toggle" data-mode="raw">Raw</button>
        </div>
      </div>
      <div class="blame-viewer">
        <table class="blame-table">
  `;

  for (const entry of blameData) {
    const shortHash = entry.hash.substring(0, 7);
    const isUncommitted = entry.hash === '0000000000000000000000000000000000000000';
    const annotation = isUncommitted
      ? '<span class="blame-uncommitted">Not committed</span>'
      : `<span class="blame-hash clickable" data-hash="${entry.hash}">${shortHash}</span>
         <span class="blame-author">${escapeHtml(entry.author)}</span>
         <span class="blame-date">${formatRelativeDate(entry.date)}</span>`;

    const highlighted = highlightCode(entry.content, extension);

    html += `
      <tr class="blame-line">
        <td class="blame-annotation">${annotation}</td>
        <td class="blame-ln">${entry.finalLine}</td>
        <td class="blame-code"><code class="hljs">${highlighted}</code></td>
      </tr>
    `;
  }

  html += '</table></div></div>';
  previewTab.innerHTML = html;

  // Mode toggle to switch back to raw
  previewTab.querySelectorAll('.blame-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode === 'raw') {
        renderPreview();
      }
    });
  });

  // Clickable hashes
  previewTab.querySelectorAll('.blame-hash.clickable').forEach(el => {
    el.addEventListener('click', () => {
      showCommitDetail(currentProject.path, el.dataset.hash);
    });
  });
}

async function showGitDiff(projectPath, fileName, staged = false) {
  const result = await window.electronAPI.gitDiff(projectPath, fileName, staged);
  const previewTab = document.getElementById('preview-tab');

  // Switch to preview tab
  document.querySelectorAll('.context-tabs .tab').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="preview"]').classList.add('active');
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  previewTab.classList.add('active');

  if (!result.success || !result.output) {
    previewTab.innerHTML = `
      <div class="file-preview">
        <div class="preview-header">
          <span class="preview-filename">${fileName} (${staged ? 'staged' : 'unstaged'})</span>
        </div>
        <div class="diff-empty">No changes to display</div>
      </div>
    `;
    return;
  }

  renderDiffView(previewTab, result.output, `${fileName} (${staged ? 'staged' : 'unstaged'})`);
}

function renderDiffView(container, diffText, title) {
  const parsed = parseDiff(diffText);
  const diffHtml = currentDiffMode === 'split' ? renderSplitDiff(parsed) : renderUnifiedDiff(parsed);

  container.innerHTML = `
    <div class="file-preview">
      <div class="preview-header">
        <span class="preview-filename">${escapeHtml(title)}</span>
        <div class="diff-controls">
          <div class="diff-nav">
            <button class="diff-nav-btn" id="diff-prev-hunk" title="Previous hunk">&#9650;</button>
            <button class="diff-nav-btn" id="diff-next-hunk" title="Next hunk">&#9660;</button>
          </div>
          <div class="diff-mode-toggle">
            <button class="diff-mode-btn ${currentDiffMode === 'unified' ? 'active' : ''}" data-mode="unified">Unified</button>
            <button class="diff-mode-btn ${currentDiffMode === 'split' ? 'active' : ''}" data-mode="split">Split</button>
          </div>
        </div>
      </div>
      <div class="diff-viewer">${diffHtml}</div>
    </div>
  `;

  // Mode toggle
  container.querySelectorAll('.diff-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentDiffMode = btn.dataset.mode;
      renderDiffView(container, diffText, title);
    });
  });

  // Hunk navigation
  const viewer = container.querySelector('.diff-viewer');
  container.querySelector('#diff-prev-hunk')?.addEventListener('click', () => navigateHunk(viewer, -1));
  container.querySelector('#diff-next-hunk')?.addEventListener('click', () => navigateHunk(viewer, 1));
}

function navigateHunk(viewer, direction) {
  const hunks = viewer.querySelectorAll('.diff-hunk-header');
  if (hunks.length === 0) return;

  const viewerRect = viewer.getBoundingClientRect();
  const scrollTop = viewer.scrollTop;
  let targetIndex = -1;

  if (direction > 0) {
    // Find next hunk below current scroll position
    for (let i = 0; i < hunks.length; i++) {
      const hunkTop = hunks[i].offsetTop;
      if (hunkTop > scrollTop + 10) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex === -1) targetIndex = hunks.length - 1;
  } else {
    // Find previous hunk above current scroll position
    for (let i = hunks.length - 1; i >= 0; i--) {
      const hunkTop = hunks[i].offsetTop;
      if (hunkTop < scrollTop - 10) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex === -1) targetIndex = 0;
  }

  hunks[targetIndex].scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function parseDiff(diffText) {
  const lines = diffText.split('\n');
  const hunks = [];
  let currentHunk = null;

  for (const line of lines) {
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      continue;
    }
    if (line.startsWith('@@')) {
      // Parse @@ -oldStart,oldCount +newStart,newCount @@
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      const oldStart = match ? parseInt(match[1]) : 1;
      const newStart = match ? parseInt(match[2]) : 1;
      currentHunk = { header: line, oldStart, newStart, lines: [] };
      hunks.push(currentHunk);
    } else if (currentHunk) {
      if (line.startsWith('+')) {
        currentHunk.lines.push({ type: 'add', text: line });
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({ type: 'del', text: line });
      } else {
        currentHunk.lines.push({ type: 'ctx', text: line });
      }
    }
  }
  return hunks;
}

function renderUnifiedDiff(hunks) {
  if (hunks.length === 0) return '<div class="diff-empty">No diff content</div>';

  let html = '<table class="diff-table unified">';
  for (const hunk of hunks) {
    html += `<tr class="diff-hunk-header"><td colspan="3">${escapeHtml(hunk.header)}</td></tr>`;
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const l of hunk.lines) {
      if (l.type === 'add') {
        html += `<tr class="diff-line addition"><td class="diff-ln"></td><td class="diff-ln">${newLine++}</td><td class="diff-text">${escapeHtml(l.text)}</td></tr>`;
      } else if (l.type === 'del') {
        html += `<tr class="diff-line deletion"><td class="diff-ln">${oldLine++}</td><td class="diff-ln"></td><td class="diff-text">${escapeHtml(l.text)}</td></tr>`;
      } else {
        html += `<tr class="diff-line context"><td class="diff-ln">${oldLine++}</td><td class="diff-ln">${newLine++}</td><td class="diff-text">${escapeHtml(l.text)}</td></tr>`;
      }
    }
  }
  html += '</table>';
  return html;
}

function renderSplitDiff(hunks) {
  if (hunks.length === 0) return '<div class="diff-empty">No diff content</div>';

  let html = '<table class="diff-table split">';
  for (const hunk of hunks) {
    html += `<tr class="diff-hunk-header"><td colspan="6">${escapeHtml(hunk.header)}</td></tr>`;
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    // Pair deletions and additions for side-by-side
    const rows = [];
    let i = 0;
    const lines = hunk.lines;

    while (i < lines.length) {
      if (lines[i].type === 'ctx') {
        rows.push({ left: { type: 'ctx', ln: oldLine++, text: lines[i].text }, right: { type: 'ctx', ln: newLine++, text: lines[i].text } });
        i++;
      } else {
        // Collect consecutive del/add blocks
        const dels = [];
        const adds = [];
        while (i < lines.length && lines[i].type === 'del') { dels.push(lines[i]); i++; }
        while (i < lines.length && lines[i].type === 'add') { adds.push(lines[i]); i++; }
        const max = Math.max(dels.length, adds.length);
        for (let j = 0; j < max; j++) {
          rows.push({
            left: j < dels.length ? { type: 'del', ln: oldLine++, text: dels[j].text } : { type: 'empty', ln: '', text: '' },
            right: j < adds.length ? { type: 'add', ln: newLine++, text: adds[j].text } : { type: 'empty', ln: '', text: '' }
          });
        }
      }
    }

    for (const row of rows) {
      const leftClass = row.left.type === 'del' ? 'deletion' : row.left.type === 'empty' ? 'empty' : 'context';
      const rightClass = row.right.type === 'add' ? 'addition' : row.right.type === 'empty' ? 'empty' : 'context';
      html += `<tr class="diff-line split-row">
        <td class="diff-ln ${leftClass}">${row.left.ln}</td>
        <td class="diff-text ${leftClass}">${escapeHtml(row.left.text)}</td>
        <td class="diff-split-gutter"></td>
        <td class="diff-ln ${rightClass}">${row.right.ln}</td>
        <td class="diff-text ${rightClass}">${escapeHtml(row.right.text)}</td>
      </tr>`;
    }
  }
  html += '</table>';
  return html;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ===== File Tree (Virtualized) =====
const FILE_ITEM_HEIGHT = 30;
const VIRTUAL_OVERSCAN = 5;
let expandedFolders = new Set();
let fileTreeData = new Map(); // path -> children array
let visibleFileItems = []; // flattened visible items
let fileTreeScrollRAF = null;
const projectFileTreeState = new Map(); // projectPath -> { expandedFolders, fileTreeData, scrollTop }

async function loadFileTree(dirPath) {
  const result = await window.electronAPI.readDirectory(dirPath);
  if (!result.success) return [];
  return result.items;
}

function buildVisibleItems(items, depth = 0) {
  const result = [];
  for (const item of items) {
    result.push({
      name: item.name,
      path: item.path,
      isDir: item.isDirectory,
      depth,
      hasChildren: item.isDirectory
    });
    if (item.isDirectory && expandedFolders.has(item.path)) {
      const children = fileTreeData.get(item.path);
      if (children) {
        result.push(...buildVisibleItems(children, depth + 1));
      }
    }
  }
  return result;
}

function rebuildVisibleItems() {
  const rootItems = fileTreeData.get('__root__');
  if (!rootItems) {
    visibleFileItems = [];
    return;
  }
  visibleFileItems = buildVisibleItems(rootItems, 0);
}

async function renderFileTree(projectPath) {
  const fileTree = document.getElementById('file-tree');

  if (!projectPath) {
    fileTree.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z" stroke="currentColor" stroke-width="1.5"/>
        </svg>
        <p>Project Files</p>
        <span>Select a project to browse</span>
      </div>
    `;
    fileTreeData.clear();
    visibleFileItems = [];
    return;
  }

  fileTree.innerHTML = '<div class="loading">Loading...</div>';
  const items = await loadFileTree(projectPath);
  fileTreeData.clear();
  fileTreeData.set('__root__', items);

  // Setup virtual scroll container
  fileTree.innerHTML = '';
  fileTree.classList.add('file-tree-virtual');

  const sentinel = document.createElement('div');
  sentinel.className = 'file-tree-sentinel';
  fileTree.appendChild(sentinel);

  const viewport = document.createElement('div');
  viewport.className = 'file-tree-viewport';
  fileTree.appendChild(viewport);

  rebuildVisibleItems();
  updateFileTreeSentinel(fileTree);
  renderVisibleItems(fileTree);

  // Attach scroll handler
  fileTree.addEventListener('scroll', () => {
    if (fileTreeScrollRAF) return;
    fileTreeScrollRAF = requestAnimationFrame(() => {
      fileTreeScrollRAF = null;
      renderVisibleItems(fileTree);
    });
  });
}

function updateFileTreeSentinel(container) {
  const sentinel = container.querySelector('.file-tree-sentinel');
  if (sentinel) {
    sentinel.style.height = `${visibleFileItems.length * FILE_ITEM_HEIGHT}px`;
  }
}

function renderVisibleItems(container) {
  const viewport = container.querySelector('.file-tree-viewport');
  if (!viewport) return;

  const scrollTop = container.scrollTop;
  const containerHeight = container.clientHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / FILE_ITEM_HEIGHT) - VIRTUAL_OVERSCAN);
  const endIndex = Math.min(
    visibleFileItems.length,
    Math.ceil((scrollTop + containerHeight) / FILE_ITEM_HEIGHT) + VIRTUAL_OVERSCAN
  );

  viewport.style.transform = `translateY(${startIndex * FILE_ITEM_HEIGHT}px)`;
  viewport.innerHTML = '';

  for (let i = startIndex; i < endIndex; i++) {
    const item = visibleFileItems[i];
    const div = document.createElement('div');
    div.className = `file-item ${item.isDir ? 'folder' : 'file'}`;
    div.style.height = `${FILE_ITEM_HEIGHT}px`;
    div.style.paddingLeft = `${12 + item.depth * 16}px`;
    div.dataset.path = item.path;
    div.dataset.vindex = i;

    const isExpanded = item.isDir && expandedFolders.has(item.path);
    const icon = item.isDir
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z" stroke="currentColor" stroke-width="1.5"/></svg>`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="currentColor" stroke-width="1.5"/><path d="M14 2v6h6" stroke="currentColor" stroke-width="1.5"/></svg>`;

    const chevron = item.isDir
      ? `<svg class="folder-chevron${isExpanded ? ' expanded' : ''}" width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : '';

    div.innerHTML = `${chevron}${icon}<span>${item.name}</span>`;
    div.addEventListener('click', (e) => {
      e.stopPropagation();
      handleFileTreeClick(item, container);
    });
    viewport.appendChild(div);
  }
}

async function handleFileTreeClick(item, container) {
  if (item.isDir) {
    if (expandedFolders.has(item.path)) {
      expandedFolders.delete(item.path);
    } else {
      expandedFolders.add(item.path);
      // Load children if not cached
      if (!fileTreeData.has(item.path)) {
        const children = await loadFileTree(item.path);
        fileTreeData.set(item.path, children);
      }
    }
    rebuildVisibleItems();
    updateFileTreeSentinel(container);
    renderVisibleItems(container);
  } else {
    await previewFile(item.path);
  }
}

// ===== Breadcrumb Navigation =====
function buildBreadcrumbs(filePath) {
  if (!currentProject || !filePath) return '';
  const projectPath = currentProject.path;
  const relativePath = filePath.startsWith(projectPath)
    ? filePath.substring(projectPath.length + 1)
    : filePath;

  const parts = relativePath.split('/');
  const folderIcon = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z" stroke="currentColor" stroke-width="1.5"/></svg>';
  const fileIcon = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="currentColor" stroke-width="1.5"/><path d="M14 2v6h6" stroke="currentColor" stroke-width="1.5"/></svg>';

  let html = '<div class="preview-breadcrumbs">';

  // Project root segment
  let currentPath = projectPath;
  html += `<span class="breadcrumb-segment" data-breadcrumb-path="${escapeHtml(projectPath)}">${folderIcon}<span>${escapeHtml(currentProject.name)}</span></span>`;

  for (let i = 0; i < parts.length; i++) {
    html += '<span class="breadcrumb-separator">&#8250;</span>';
    currentPath += '/' + parts[i];
    const isLast = i === parts.length - 1;
    if (isLast) {
      html += `<span class="breadcrumb-segment breadcrumb-file">${fileIcon}<span>${escapeHtml(parts[i])}</span></span>`;
    } else {
      html += `<span class="breadcrumb-segment" data-breadcrumb-path="${escapeHtml(currentPath)}">${folderIcon}<span>${escapeHtml(parts[i])}</span></span>`;
    }
  }

  html += '</div>';
  return html;
}

function attachBreadcrumbListeners(container) {
  container.querySelectorAll('.breadcrumb-segment[data-breadcrumb-path]').forEach(seg => {
    seg.addEventListener('click', () => {
      const targetPath = seg.dataset.breadcrumbPath;
      // Switch to Files tab
      const filesTab = document.querySelector('[data-tab="files"]');
      if (filesTab) filesTab.click();
      // Expand to the folder
      expandToFolder(targetPath);
    });
  });
}

async function expandToFolder(targetPath) {
  if (!currentProject) return;
  const projectPath = currentProject.path;
  const fileTree = document.getElementById('file-tree');

  // Build the chain of folders from project root to target
  const relativePath = targetPath.startsWith(projectPath)
    ? targetPath.substring(projectPath.length + 1)
    : targetPath;
  const parts = relativePath.split('/').filter(Boolean);

  let currentPath = projectPath;
  for (const part of parts) {
    currentPath += '/' + part;
    if (!expandedFolders.has(currentPath)) {
      expandedFolders.add(currentPath);
      if (!fileTreeData.has(currentPath)) {
        const children = await loadFileTree(currentPath);
        fileTreeData.set(currentPath, children);
      }
    }
  }

  rebuildVisibleItems();
  updateFileTreeSentinel(fileTree);
  renderVisibleItems(fileTree);

  // Scroll to the target folder in the file tree
  const targetIndex = visibleFileItems.findIndex(item => item.path === targetPath);
  if (targetIndex >= 0) {
    fileTree.scrollTop = targetIndex * FILE_ITEM_HEIGHT;
    renderVisibleItems(fileTree);
  }
}

// ===== File Preview Minimap =====
function getMinimapColors() {
  const isDark = getCurrentTheme() === 'dark';
  return {
    text: isDark ? '#A8A5A0' : '#6B6966',
    keyword: isDark ? '#569CD6' : '#0033B3',
    string: isDark ? '#CE9178' : '#067D17',
    comment: isDark ? '#6A9955' : '#8C8C8C',
    bg: isDark ? '#2E2E2E' : '#EFEEEB',
  };
}

function initMinimap(container) {
  const codeEl = container.querySelector('.file-preview-content');
  const minimapEl = container.querySelector('.preview-minimap');
  const canvas = container.querySelector('.minimap-canvas');
  const indicator = container.querySelector('.minimap-viewport-indicator');

  if (!codeEl || !minimapEl || !canvas || !indicator) return;

  // Hide minimap if content fits in viewport
  if (codeEl.scrollHeight <= codeEl.clientHeight + 10) {
    minimapEl.style.display = 'none';
    return;
  }
  minimapEl.style.display = 'block';

  const colors = getMinimapColors();
  const lines = (currentPreviewContent?.content || '').split('\n');
  const lineHeight = 2;
  const canvasWidth = 56;
  const canvasHeight = Math.min(lines.length * lineHeight, minimapEl.clientHeight || 600);

  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvasWidth * dpr;
  canvas.height = canvasHeight * dpr;
  canvas.style.width = canvasWidth + 'px';
  canvas.style.height = canvasHeight + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // Draw lines as tiny rects
  const scale = canvasHeight / (lines.length * lineHeight);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const y = i * lineHeight * scale;
    const indent = line.search(/\S/);
    const x = Math.min(indent * 1.5, 20);
    const width = Math.min((line.trim().length) * 0.5, canvasWidth - x - 2);

    // Simple color heuristic
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      ctx.fillStyle = colors.comment;
    } else if (/^(import|export|const|let|var|function|class|if|else|for|while|return|async|await)\b/.test(trimmed)) {
      ctx.fillStyle = colors.keyword;
    } else if (/['"`]/.test(trimmed)) {
      ctx.fillStyle = colors.string;
    } else {
      ctx.fillStyle = colors.text;
    }

    ctx.globalAlpha = 0.6;
    ctx.fillRect(x + 2, y, Math.max(width, 3), Math.max(lineHeight * scale - 0.5, 1));
  }
  ctx.globalAlpha = 1;

  // Viewport indicator
  function updateIndicator() {
    const scrollRatio = codeEl.scrollTop / (codeEl.scrollHeight - codeEl.clientHeight);
    const viewportRatio = codeEl.clientHeight / codeEl.scrollHeight;
    const indicatorHeight = Math.max(viewportRatio * canvasHeight, 12);
    const maxTop = canvasHeight - indicatorHeight;
    indicator.style.height = indicatorHeight + 'px';
    indicator.style.top = (scrollRatio * maxTop) + 'px';
  }
  updateIndicator();
  codeEl.addEventListener('scroll', updateIndicator);

  // Click/drag on minimap to scroll
  let isDragging = false;
  function scrollToY(clientY) {
    const rect = canvas.getBoundingClientRect();
    const y = clientY - rect.top;
    const ratio = y / canvasHeight;
    codeEl.scrollTop = ratio * (codeEl.scrollHeight - codeEl.clientHeight);
  }

  minimapEl.addEventListener('mousedown', (e) => {
    isDragging = true;
    scrollToY(e.clientY);
  });
  document.addEventListener('mousemove', (e) => {
    if (isDragging) scrollToY(e.clientY);
  });
  document.addEventListener('mouseup', () => { isDragging = false; });
}

function canShowLivePreview(extension) {
  return ['.md', '.markdown', '.html', '.htm'].includes(extension.toLowerCase());
}

function getLanguageFromExtension(ext) {
  const map = {
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
    '.py': 'python', '.rb': 'ruby', '.java': 'java',
    '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cxx': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
    '.cs': 'csharp', '.go': 'go', '.rs': 'rust', '.swift': 'swift',
    '.kt': 'kotlin', '.php': 'php', '.sql': 'sql',
    '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
    '.json': 'json', '.xml': 'xml', '.svg': 'xml',
    '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'ini',
    '.css': 'css', '.scss': 'scss', '.less': 'less',
    '.html': 'xml', '.htm': 'xml',
    '.md': 'markdown', '.markdown': 'markdown',
    '.r': 'r', '.lua': 'lua', '.pl': 'perl', '.pm': 'perl',
    '.dockerfile': 'dockerfile', '.makefile': 'makefile',
    '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini',
    '.diff': 'diff', '.patch': 'diff',
    '.graphql': 'graphql', '.gql': 'graphql',
    '.wasm': 'wasm', '.proto': 'protobuf',
  };
  return map[ext.toLowerCase()] || null;
}

function highlightCode(content, extension) {
  const language = getLanguageFromExtension(extension);
  try {
    if (language) {
      return hljs.highlight(content, { language }).value;
    }
    const result = hljs.highlightAuto(content);
    return result.value;
  } catch {
    return content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

function renderPreview() {
  const previewTab = document.getElementById('preview-tab');

  if (!currentPreviewFile || !currentPreviewContent) {
    previewTab.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="currentColor" stroke-width="1.5"/>
          <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" stroke="currentColor" stroke-width="1.5"/>
        </svg>
        <p>File Preview</p>
        <span>Select a file to preview</span>
      </div>
    `;
    return;
  }

  const { name, extension, isImage, dataUrl, content } = currentPreviewContent;

  const breadcrumbHtml = buildBreadcrumbs(currentPreviewFile);

  // Handle image files
  if (isImage) {
    previewTab.innerHTML = `
      <div class="file-preview">
        <div class="preview-header">
          <span class="preview-filename">${name}</span>
        </div>
        ${breadcrumbHtml}
        <div class="preview-image-container">
          <img class="preview-image" src="${dataUrl}" alt="${name}">
        </div>
      </div>
    `;
    attachBreadcrumbListeners(previewTab);
    return;
  }

  const showLive = canShowLivePreview(extension);
  const showBlameBtn = currentProject && !isImage;

  // Build header with mode toggle
  let html = `
    <div class="file-preview">
      <div class="preview-header">
        <span class="preview-filename">${name}</span>
        <div class="preview-header-actions">
          ${showBlameBtn ? '<button class="preview-mode-btn blame-btn" id="preview-blame-btn">Blame</button>' : ''}
          ${showLive ? `
            <div class="preview-mode-toggle">
              <button class="preview-mode-btn ${currentPreviewMode === 'raw' ? 'active' : ''}" data-mode="raw">Raw</button>
              <button class="preview-mode-btn ${currentPreviewMode === 'live' ? 'active' : ''}" data-mode="live">Live</button>
            </div>
          ` : ''}
        </div>
      </div>
      ${breadcrumbHtml}
  `;

  if (currentPreviewMode === 'live' && showLive) {
    const ext = extension.toLowerCase();
    if (ext === '.md' || ext === '.markdown') {
      // Render markdown
      const renderedMd = marked.parse(content);
      html += `<div class="preview-live markdown-body">${renderedMd}</div>`;
    } else if (ext === '.html' || ext === '.htm') {
      // Render HTML in iframe
      html += `
        <div class="preview-iframe-container">
          <iframe class="preview-iframe" id="preview-iframe" sandbox="allow-scripts"></iframe>
        </div>
      `;
    }
  } else {
    // Raw mode with syntax highlighting + minimap
    const highlighted = highlightCode(content, extension);
    html += `<div class="preview-code-container">
      <pre class="file-preview-content"><code class="hljs">${highlighted}</code></pre>
      <div class="preview-minimap"><canvas class="minimap-canvas"></canvas><div class="minimap-viewport-indicator"></div></div>
    </div>`;
  }

  html += '</div>';
  previewTab.innerHTML = html;

  // Breadcrumb listeners
  attachBreadcrumbListeners(previewTab);

  // Add mode toggle listeners
  previewTab.querySelectorAll('.preview-mode-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      currentPreviewMode = btn.dataset.mode;
      renderPreview();
    });
  });

  // Blame button
  const blameBtn = previewTab.querySelector('#preview-blame-btn');
  if (blameBtn) {
    blameBtn.addEventListener('click', async () => {
      const blameData = await showBlameView(currentPreviewFile);
      if (blameData) {
        renderBlameView(previewTab, blameData, name, extension);
      }
    });
  }

  // Initialize minimap for raw mode
  if (currentPreviewMode === 'raw' || !showLive) {
    requestAnimationFrame(() => initMinimap(previewTab));
  }

  // Set iframe content for HTML files
  if (currentPreviewMode === 'live' && (extension.toLowerCase() === '.html' || extension.toLowerCase() === '.htm')) {
    const iframe = document.getElementById('preview-iframe');
    if (iframe) {
      iframe.srcdoc = content;
    }
  }
}

async function previewFile(filePath) {
  const result = await window.electronAPI.readFile(filePath);
  const previewTab = document.getElementById('preview-tab');

  if (!result.success) {
    previewTab.innerHTML = `<div class="empty-state"><p>Error</p><span>${result.error}</span></div>`;
    return;
  }

  // Switch to preview tab
  document.querySelectorAll('.context-tabs .tab').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="preview"]').classList.add('active');
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  previewTab.classList.add('active');

  // Store current preview data
  currentPreviewFile = filePath;
  currentPreviewContent = result;

  // Default to live mode for supported files
  if (canShowLivePreview(result.extension)) {
    currentPreviewMode = 'live';
  } else {
    currentPreviewMode = 'raw';
  }

  renderPreview();
}

// ===== Tab Switching =====
document.querySelectorAll('.context-tabs .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabId = tab.dataset.tab;

    document.querySelectorAll('.context-tabs .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.getElementById(`${tabId}-tab`).classList.add('active');

    if (tabId === 'git' && currentProject) {
      loadGitStatus(currentProject.path);
    }
  });
});

// ===== Panel Resizing =====
function initResize(handleId, element, minWidth, maxWidth, direction) {
  const handle = document.getElementById(handleId);
  if (!handle) return;

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startWidth = element.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const dx = direction === 'left' ? e.clientX - startX : startX - e.clientX;
    const newWidth = startWidth + dx;
    if (newWidth >= minWidth && newWidth <= maxWidth) {
      element.style.width = `${newWidth}px`;
    }
  });

  document.addEventListener('mouseup', () => {
    if (isResizing && currentProject && projectData.has(currentProject.path)) {
      const data = projectData.get(currentProject.path);
      const activeTab = data.tabs[data.activeTabIndex];
      if (activeTab) {
        activeTab.fitAddon.fit();
        window.electronAPI.terminalResize(activeTab.id, activeTab.terminal.cols, activeTab.terminal.rows);
      }
    }
    isResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

initResize('left-resize', document.getElementById('sidebar'), 180, 400, 'left');
initResize('right-resize', document.getElementById('context-panel'), 260, 500, 'right');

// ===== Notes (Per-Project) =====
const notesEditor = document.getElementById('notes-editor');
const NOTES_KEY = 'programming-interface-notes';
const GLOBAL_NOTES_KEY = 'programming-interface-global-notes';

function getProjectNotesKey(projectPath) {
  return `${NOTES_KEY}-${projectPath}`;
}

function loadNotesForProject(projectPath) {
  if (!projectPath) {
    const globalNotes = cachedNotes['__global__'] || '';
    notesEditor.value = globalNotes;
    notesEditor.placeholder = 'Write notes, draft prompts, or save code snippets...';
  } else {
    const notes = cachedNotes[projectPath] || '';
    notesEditor.value = notes;
    notesEditor.placeholder = `Notes for ${projectPath.split('/').pop()}...`;
  }
}

function saveNotesForProject(projectPath) {
  if (!projectPath) {
    cachedNotes['__global__'] = notesEditor.value;
  } else {
    cachedNotes[projectPath] = notesEditor.value;
  }
  window.electronAPI.storeWrite('notes.json', cachedNotes);
}

notesEditor.addEventListener('input', () => {
  saveNotesForProject(currentProject?.path);
});

// Notes load deferred to initDataStore()

// ===== Projects =====
const projectList = document.getElementById('project-list');
const addProjectBtn = document.getElementById('add-project-btn');
const PROJECTS_KEY = 'programming-interface-projects';

function getProjects() {
  return cachedProjects;
}

function saveProjects(projects) {
  cachedProjects = projects;
  window.electronAPI.storeWrite('projects.json', { list: projects, settings: cachedProjectSettings });
}

function selectProject(project) {
  // Reset split mode when switching projects
  if (splitState.active) {
    const terminalContent = document.getElementById('terminal-content');
    // Move terminals back if they belong to old project
    if (currentProject && projectData.has(currentProject.path)) {
      const oldData = projectData.get(currentProject.path);
      oldData.tabs.forEach(tab => {
        terminalContent.appendChild(tab.container);
        tab.container.style.display = 'none';
      });
    }
    const splitContainer = terminalContent.querySelector('.terminal-split-container');
    if (splitContainer) splitContainer.remove();

    splitState = { active: false, leftId: null, rightId: null };
  }

  // Save file tree state for the project we're leaving
  if (currentProject) {
    const fileTree = document.getElementById('file-tree');
    projectFileTreeState.set(currentProject.path, {
      expandedFolders: new Set(expandedFolders),
      fileTreeData: new Map(fileTreeData),
      scrollTop: fileTree ? fileTree.scrollTop : 0
    });
  }

  currentProject = project;

  document.querySelectorAll('.project-item').forEach(item => {
    item.classList.toggle('active', item.dataset.path === project.path);
  });

  initTerminalForProject(project.path, project.path);

  // Restore file tree state for the project we're switching to
  const savedState = projectFileTreeState.get(project.path);
  if (savedState) {
    expandedFolders = savedState.expandedFolders;
    fileTreeData = savedState.fileTreeData;
    rebuildVisibleItems();
    const fileTree = document.getElementById('file-tree');
    fileTree.innerHTML = '';
    fileTree.classList.add('file-tree-virtual');
    const sentinel = document.createElement('div');
    sentinel.className = 'file-tree-sentinel';
    fileTree.appendChild(sentinel);
    const viewport = document.createElement('div');
    viewport.className = 'file-tree-viewport';
    fileTree.appendChild(viewport);
    updateFileTreeSentinel(fileTree);
    renderVisibleItems(fileTree);
    fileTree.addEventListener('scroll', () => {
      if (fileTreeScrollRAF) return;
      fileTreeScrollRAF = requestAnimationFrame(() => {
        fileTreeScrollRAF = null;
        renderVisibleItems(fileTree);
      });
    });
    requestAnimationFrame(() => { fileTree.scrollTop = savedState.scrollTop; });
  } else {
    expandedFolders = new Set();
    renderFileTree(project.path);
  }

  loadGitStatus(project.path);
  loadNotesForProject(project.path);
  renderProjects(getProjects());
}

function renderProjects(projects) {
  if (projects.length === 0) {
    projectList.innerHTML = `
      <div class="empty-state">
        <p>No projects yet</p>
        <span>Add a folder to get started</span>
      </div>
    `;
    return;
  }

  projectList.innerHTML = projects.map((project, index) => {
    return `
    <div class="project-item" data-index="${index}" data-path="${project.path}">
      <svg class="project-icon" viewBox="0 0 24 24" fill="none">
        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z" stroke="currentColor" stroke-width="1.5"/>
      </svg>
      <span class="project-name">${project.name}</span>
      <button class="project-settings-btn" data-path="${project.path}" title="Settings">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
          <circle cx="12" cy="6" r="1.5" fill="currentColor"/>
          <circle cx="12" cy="18" r="1.5" fill="currentColor"/>
        </svg>
      </button>
    </div>
  `;
  }).join('');

  document.querySelectorAll('.project-item').forEach((item, index) => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.project-settings-btn')) return;
      const project = getProjects().find(p => p.path === item.dataset.path);
      if (project) selectProject(project);
    });
    // Add drag and drop
    makeDraggable(item, index);
  });

  // Settings button handlers
  document.querySelectorAll('.project-settings-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openProjectSettings(btn.dataset.path);
    });
  });
}

// ===== Add Project Dropdown =====
const addProjectDropdown = document.getElementById('add-project-dropdown');
const selectExistingBtn = document.getElementById('select-existing-btn');
const createNewBtn = document.getElementById('create-new-btn');
const folderNamePrompt = document.getElementById('folder-name-prompt');
const newFolderNameInput = document.getElementById('new-folder-name');
const promptCancelBtn = document.getElementById('prompt-cancel');
const promptCreateBtn = document.getElementById('prompt-create');

let pendingParentPath = null;

// Toggle dropdown on "+" button click
addProjectBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  addProjectDropdown.classList.toggle('active');
});

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.add-project-wrapper')) {
    addProjectDropdown.classList.remove('active');
  }
});

// Select Existing Folder (original behavior)
selectExistingBtn.addEventListener('click', async () => {
  addProjectDropdown.classList.remove('active');
  const result = await window.electronAPI.selectFolder();
  if (result) {
    const projects = getProjects();
    if (projects.some(p => p.path === result.path)) {
      selectProject(result);
      return;
    }
    projects.push(result);
    saveProjects(projects);
    renderProjects(projects);
    selectProject(result);
  }
});

// Create New Project
createNewBtn.addEventListener('click', async () => {
  addProjectDropdown.classList.remove('active');

  // First, select parent directory
  const parentResult = await window.electronAPI.selectFolder();
  if (!parentResult) return;

  pendingParentPath = parentResult.path;

  // Show prompt for folder name
  folderNamePrompt.classList.add('active');
  newFolderNameInput.value = '';
  newFolderNameInput.focus();
});

// Prompt modal - Cancel
promptCancelBtn.addEventListener('click', () => {
  folderNamePrompt.classList.remove('active');
  pendingParentPath = null;
});

// Close prompt when clicking outside
folderNamePrompt.addEventListener('click', (e) => {
  if (e.target === folderNamePrompt) {
    folderNamePrompt.classList.remove('active');
    pendingParentPath = null;
  }
});

// Prompt modal - Create folder
async function createNewProject() {
  const folderName = newFolderNameInput.value.trim();
  if (!folderName || !pendingParentPath) return;

  try {
    const result = await window.electronAPI.createProjectFolder(pendingParentPath, folderName);

    // Add to projects
    const projects = getProjects();
    if (!projects.some(p => p.path === result.path)) {
      projects.push(result);
      saveProjects(projects);
      renderProjects(projects);
    }
    selectProject(result);

    folderNamePrompt.classList.remove('active');
    pendingParentPath = null;
  } catch (err) {
    alert('Failed to create folder: ' + err.message);
  }
}

promptCreateBtn.addEventListener('click', createNewProject);

// Handle Enter key in folder name input
newFolderNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    createNewProject();
  } else if (e.key === 'Escape') {
    folderNamePrompt.classList.remove('active');
    pendingParentPath = null;
  }
});

// renderProjects deferred to initDataStore()

// ===== Terminal Search =====
const terminalSearchEl = document.getElementById('terminal-search');
const terminalSearchInput = document.getElementById('terminal-search-input');
const terminalSearchCount = document.getElementById('terminal-search-count');
let terminalSearchResults = { resultIndex: -1, resultCount: 0 };

function getActiveSearchAddon() {
  if (!currentProject || !projectData.has(currentProject.path)) return null;
  const data = projectData.get(currentProject.path);
  const activeTab = data.tabs[data.activeTabIndex];
  return activeTab?.searchAddon || null;
}

function openTerminalSearch() {
  terminalSearchEl.classList.add('active');
  terminalSearchInput.focus();
  terminalSearchInput.select();
}

function closeTerminalSearch() {
  terminalSearchEl.classList.remove('active');
  terminalSearchInput.value = '';
  terminalSearchCount.textContent = '';
  const searchAddon = getActiveSearchAddon();
  if (searchAddon) searchAddon.clearDecorations();
}

function doTerminalSearch(direction = 'next') {
  const searchAddon = getActiveSearchAddon();
  if (!searchAddon) return;

  const query = terminalSearchInput.value;
  if (!query) {
    searchAddon.clearDecorations();
    terminalSearchCount.textContent = '';
    return;
  }

  const options = { caseSensitive: false, wholeWord: false, regex: false };
  let found;
  if (direction === 'next') {
    found = searchAddon.findNext(query, options);
  } else {
    found = searchAddon.findPrevious(query, options);
  }

  terminalSearchCount.textContent = found ? 'Match found' : 'No matches';
}

terminalSearchInput.addEventListener('input', () => doTerminalSearch());
terminalSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doTerminalSearch(e.shiftKey ? 'prev' : 'next');
  } else if (e.key === 'Escape') {
    closeTerminalSearch();
  }
});

document.getElementById('terminal-search-next').addEventListener('click', () => doTerminalSearch('next'));
document.getElementById('terminal-search-prev').addEventListener('click', () => doTerminalSearch('prev'));
document.getElementById('terminal-search-close').addEventListener('click', closeTerminalSearch);

// ===== Drag and Drop for Projects =====
let draggedProject = null;
let draggedIndex = null;

function makeDraggable(item, index) {
  item.setAttribute('draggable', 'true');

  item.addEventListener('dragstart', (e) => {
    if (e.target.closest('.project-settings-btn')) { e.preventDefault(); return; }
    draggedProject = item;
    draggedIndex = index;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    document.querySelectorAll('.project-item').forEach(el => {
      el.classList.remove('drag-over', 'drag-over-bottom');
    });
    draggedProject = null;
    draggedIndex = null;
  });

  item.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (draggedProject === item) return;

    const rect = item.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;

    item.classList.remove('drag-over', 'drag-over-bottom');
    if (e.clientY < midY) {
      item.classList.add('drag-over');
    } else {
      item.classList.add('drag-over-bottom');
    }
  });

  item.addEventListener('dragleave', () => {
    item.classList.remove('drag-over', 'drag-over-bottom');
  });

  item.addEventListener('drop', (e) => {
    e.preventDefault();
    if (draggedProject === item) return;

    const projects = getProjects();
    const fromIndex = draggedIndex;
    const toIndex = parseInt(item.dataset.index);

    const rect = item.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const insertAfter = e.clientY >= midY;

    // Remove from old position
    const [moved] = projects.splice(fromIndex, 1);

    // Calculate new position
    let newIndex = toIndex;
    if (fromIndex < toIndex) newIndex--;
    if (insertAfter) newIndex++;

    // Insert at new position
    projects.splice(newIndex, 0, moved);

    saveProjects(projects);
    renderProjects(projects);
    // Re-apply active class to current project
    if (currentProject) {
      document.querySelectorAll('.project-item').forEach(el => {
        el.classList.toggle('active', el.dataset.path === currentProject.path);
      });
    }
  });
}

// ===== Quick File Open (Cmd+P) =====
const quickOpenOverlay = document.getElementById('quick-open-overlay');
const quickOpenInput = document.getElementById('quick-open-input');
const quickOpenResults = document.getElementById('quick-open-results');
let filteredFiles = [];
let selectedFileIndex = 0;
let quickOpenSearchTimeout = null;

function renderQuickOpenResults(loading = false) {
  if (loading) {
    quickOpenResults.innerHTML = '<div class="quick-open-empty">Searching...</div>';
    return;
  }

  if (filteredFiles.length === 0) {
    quickOpenResults.innerHTML = '<div class="quick-open-empty">No matching files</div>';
    return;
  }

  quickOpenResults.innerHTML = filteredFiles.map((file, index) => `
    <div class="quick-open-item ${index === selectedFileIndex ? 'selected' : ''}" data-index="${index}">
      <svg class="quick-open-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="currentColor" stroke-width="1.5"/>
        <path d="M14 2v6h6" stroke="currentColor" stroke-width="1.5"/>
      </svg>
      <span class="quick-open-name">${file.name}</span>
      <span class="quick-open-path">${file.relativePath}</span>
    </div>
  `).join('');

  // Add click handlers
  quickOpenResults.querySelectorAll('.quick-open-item').forEach(item => {
    item.addEventListener('click', () => {
      const index = parseInt(item.dataset.index);
      openQuickOpenFile(index);
    });
  });
}

async function searchQuickOpenFiles(query) {
  if (!currentProject) return;
  const skipDirs = await getSkipDirsForProject(currentProject.path);
  renderQuickOpenResults(true);
  const result = await window.electronAPI.searchFiles(currentProject.path, query, skipDirs, 50);
  filteredFiles = result.results;
  selectedFileIndex = 0;
  renderQuickOpenResults();
}

async function openQuickOpen() {
  if (!currentProject) return;

  quickOpenOverlay.classList.add('active');
  quickOpenInput.value = '';
  quickOpenInput.focus();

  // Load initial file list from server
  searchQuickOpenFiles('');
}

function closeQuickOpen() {
  quickOpenOverlay.classList.remove('active');
  quickOpenInput.value = '';
  clearTimeout(quickOpenSearchTimeout);
}

async function openQuickOpenFile(index) {
  const file = filteredFiles[index];
  if (!file) return;

  closeQuickOpen();
  await previewFile(file.path);
}

quickOpenInput.addEventListener('input', () => {
  clearTimeout(quickOpenSearchTimeout);
  quickOpenSearchTimeout = setTimeout(() => {
    searchQuickOpenFiles(quickOpenInput.value);
  }, 150);
});

quickOpenInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedFileIndex = Math.min(selectedFileIndex + 1, filteredFiles.length - 1);
    renderQuickOpenResults();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedFileIndex = Math.max(selectedFileIndex - 1, 0);
    renderQuickOpenResults();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    openQuickOpenFile(selectedFileIndex);
  } else if (e.key === 'Escape') {
    closeQuickOpen();
  }
});

quickOpenOverlay.addEventListener('click', (e) => {
  if (e.target === quickOpenOverlay) closeQuickOpen();
});

// ===== Global Search (Cmd+Shift+F) =====
const globalSearchOverlay = document.getElementById('global-search-overlay');
const globalSearchInput = document.getElementById('global-search-input');
const globalSearchResults = document.getElementById('global-search-results');
let globalSearchResultsList = [];
let globalSearchSelectedIndex = 0;
let globalSearchTimeout = null;
let activeSearchRequestId = null;
let globalSearchTotalMatches = 0;

function openGlobalSearch() {
  if (!currentProject) return;

  globalSearchOverlay.classList.add('active');
  globalSearchInput.value = '';
  globalSearchInput.focus();
  globalSearchResultsList = [];
  globalSearchSelectedIndex = 0;
  globalSearchTotalMatches = 0;
  globalSearchResults.innerHTML = '<div class="global-search-empty">Type to search across all files</div>';
}

function closeGlobalSearch() {
  globalSearchOverlay.classList.remove('active');
  globalSearchInput.value = '';
  cancelActiveSearch();
}

function cancelActiveSearch() {
  if (activeSearchRequestId) {
    window.electronAPI.cancelSearch(activeSearchRequestId);
    activeSearchRequestId = null;
  }
  window.electronAPI.removeSearchListeners();
}

async function doGlobalSearch(query) {
  if (!currentProject || query.length < 2) {
    globalSearchResults.innerHTML = '<div class="global-search-empty">Type at least 2 characters to search</div>';
    return;
  }

  // Cancel previous search
  cancelActiveSearch();

  const requestId = `search-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  activeSearchRequestId = requestId;
  globalSearchResultsList = [];
  globalSearchSelectedIndex = 0;
  globalSearchTotalMatches = 0;

  globalSearchResults.innerHTML = '<div class="global-search-loading">Searching...</div>';

  const skipDirs = await getSkipDirsForProject(currentProject.path);

  // Set up streaming listeners
  window.electronAPI.onSearchResult((data) => {
    if (data.requestId !== requestId) return;

    // Append results for this file
    for (const match of data.matches) {
      globalSearchResultsList.push({
        file: data.file,
        relativePath: data.relativePath,
        fileName: data.fileName,
        line: match.line,
        content: match.content
      });
      globalSearchTotalMatches++;
    }

    // Incrementally render
    appendSearchResultsDOM(data, query);
  });

  window.electronAPI.onSearchComplete((data) => {
    if (data.requestId !== requestId) return;
    activeSearchRequestId = null;

    // Remove spinner
    const spinner = globalSearchResults.querySelector('.global-search-loading');
    if (spinner) spinner.remove();

    if (globalSearchTotalMatches === 0) {
      globalSearchResults.innerHTML = '<div class="global-search-empty">No results found</div>';
    } else {
      // Add summary at top
      const summary = globalSearchResults.querySelector('.global-search-summary');
      if (summary) {
        summary.textContent = `${globalSearchTotalMatches} results in ${new Set(globalSearchResultsList.map(r => r.file)).size} files`;
      }
    }

    window.electronAPI.removeSearchListeners();
  });

  window.electronAPI.searchProjectStream(currentProject.path, query, skipDirs, requestId);
}

function appendSearchResultsDOM(data, query) {
  // Remove the spinner if first result
  const spinner = globalSearchResults.querySelector('.global-search-loading');
  if (spinner) {
    globalSearchResults.innerHTML = '<div class="global-search-summary global-search-loading">Searching...</div>';
  }

  const queryLower = query.toLowerCase();

  for (const match of data.matches) {
    const index = globalSearchResultsList.length - data.matches.length + data.matches.indexOf(match);
    const contentLower = match.content.toLowerCase();
    const matchIndex = contentLower.indexOf(queryLower);
    let highlightedContent = escapeHtml(match.content);

    if (matchIndex !== -1) {
      const before = escapeHtml(match.content.substring(0, matchIndex));
      const matched = escapeHtml(match.content.substring(matchIndex, matchIndex + query.length));
      const after = escapeHtml(match.content.substring(matchIndex + query.length));
      highlightedContent = `${before}<mark>${matched}</mark>${after}`;
    }

    const div = document.createElement('div');
    div.className = 'global-search-result';
    div.dataset.index = index;
    div.innerHTML = `
      <div class="global-search-result-header">
        <span class="global-search-filename">${data.fileName}</span>
        <span class="global-search-path">${data.relativePath}</span>
        <span class="global-search-line">:${match.line}</span>
      </div>
      <div class="global-search-content">${highlightedContent}</div>
    `;
    div.addEventListener('click', () => openGlobalSearchResult(index));
    globalSearchResults.appendChild(div);
  }
}

async function openGlobalSearchResult(index) {
  const result = globalSearchResultsList[index];
  if (!result) return;

  closeGlobalSearch();
  await previewFile(result.file);
}

globalSearchInput.addEventListener('input', () => {
  clearTimeout(globalSearchTimeout);
  globalSearchTimeout = setTimeout(() => {
    doGlobalSearch(globalSearchInput.value);
  }, 300);
});

globalSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    globalSearchSelectedIndex = Math.min(globalSearchSelectedIndex + 1, globalSearchResultsList.length - 1);
    updateGlobalSearchSelection();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    globalSearchSelectedIndex = Math.max(globalSearchSelectedIndex - 1, 0);
    updateGlobalSearchSelection();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    openGlobalSearchResult(globalSearchSelectedIndex);
  } else if (e.key === 'Escape') {
    closeGlobalSearch();
  }
});

function updateGlobalSearchSelection() {
  globalSearchResults.querySelectorAll('.global-search-result').forEach((el, i) => {
    el.classList.toggle('selected', i === globalSearchSelectedIndex);
    if (i === globalSearchSelectedIndex) {
      el.scrollIntoView({ block: 'nearest' });
    }
  });
}

globalSearchOverlay.addEventListener('click', (e) => {
  if (e.target === globalSearchOverlay) closeGlobalSearch();
});

// ===== Keyboard Shortcuts =====
document.addEventListener('keydown', (e) => {
  if (capturingShortcutId) return;
  // More specific bindings (with shift) should match first
  const sorted = [...SHORTCUT_REGISTRY].sort((a, b) => {
    const ba = getEffectiveBinding(a.id);
    const bb = getEffectiveBinding(b.id);
    const sa = ba && ba.shiftKey ? 1 : 0;
    const sb = bb && bb.shiftKey ? 1 : 0;
    return sb - sa;
  });
  for (const entry of sorted) {
    const binding = getEffectiveBinding(entry.id);
    if (bindingMatchesEvent(binding, e)) {
      e.preventDefault();
      entry.action();
      return;
    }
  }
});

// ===== Project Settings =====
const settingsOverlay = document.getElementById('settings-overlay');
const settingsTitle = document.getElementById('settings-title');
const settingsName = document.getElementById('settings-name');
const settingsShell = document.getElementById('settings-shell');
const settingsEnv = document.getElementById('settings-env');
const settingsStartup = document.getElementById('settings-startup');
const settingsSkipDirs = document.getElementById('settings-skip-dirs');
let editingProjectPath = null;
let cachedDefaultSkipDirs = null;

const PROJECT_SETTINGS_KEY = 'programming-interface-project-settings';

function getProjectSettings(projectPath) {
  return cachedProjectSettings[projectPath] || {};
}

function saveProjectSettings(projectPath, settings) {
  cachedProjectSettings[projectPath] = settings;
  window.electronAPI.storeWrite('projects.json', { list: cachedProjects, settings: cachedProjectSettings });
}

function deleteProjectSettings(projectPath) {
  delete cachedProjectSettings[projectPath];
  window.electronAPI.storeWrite('projects.json', { list: cachedProjects, settings: cachedProjectSettings });
}

async function getSkipDirsForProject(projectPath) {
  const settings = getProjectSettings(projectPath);
  if (settings.skipDirs) {
    return settings.skipDirs.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (!cachedDefaultSkipDirs) {
    cachedDefaultSkipDirs = await window.electronAPI.getDefaultSkipDirs();
  }
  return cachedDefaultSkipDirs;
}

async function openProjectSettings(projectPath) {
  editingProjectPath = projectPath;
  const projects = getProjects();
  const project = projects.find(p => p.path === projectPath);
  const settings = getProjectSettings(projectPath);

  settingsTitle.textContent = `Settings: ${project?.name || 'Project'}`;
  settingsName.value = project?.name || '';
  settingsShell.value = settings.shell || '';
  settingsEnv.value = settings.env || '';
  settingsStartup.value = settings.startup || '';

  // Load skip dirs - show project-specific or defaults
  if (settings.skipDirs) {
    settingsSkipDirs.value = settings.skipDirs;
  } else {
    if (!cachedDefaultSkipDirs) {
      cachedDefaultSkipDirs = await window.electronAPI.getDefaultSkipDirs();
    }
    settingsSkipDirs.value = cachedDefaultSkipDirs.join(', ');
  }

  settingsOverlay.classList.add('active');
}

function closeProjectSettings() {
  settingsOverlay.classList.remove('active');
  editingProjectPath = null;
}

document.getElementById('settings-close').addEventListener('click', closeProjectSettings);
document.getElementById('settings-cancel').addEventListener('click', closeProjectSettings);
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeProjectSettings();
});

document.getElementById('settings-save').addEventListener('click', () => {
  if (!editingProjectPath) return;

  // Update project name
  const projects = getProjects();
  const projectIndex = projects.findIndex(p => p.path === editingProjectPath);
  if (projectIndex !== -1) {
    projects[projectIndex].name = settingsName.value || projects[projectIndex].name;
    saveProjects(projects);
    renderProjects(projects);
  }

  // Save settings
  saveProjectSettings(editingProjectPath, {
    shell: settingsShell.value,
    env: settingsEnv.value,
    startup: settingsStartup.value,
    skipDirs: settingsSkipDirs.value
  });

  closeProjectSettings();
});

document.getElementById('settings-remove').addEventListener('click', () => {
  if (!editingProjectPath) return;

  if (confirm('Remove this project from the list?')) {
    // Remove project
    const projects = getProjects().filter(p => p.path !== editingProjectPath);
    saveProjects(projects);
    renderProjects(projects);

    // Clean up settings, notes, and file tree state
    deleteProjectSettings(editingProjectPath);
    delete cachedNotes[editingProjectPath];
    projectFileTreeState.delete(editingProjectPath);
    window.electronAPI.storeWrite('notes.json', cachedNotes);

    // Clear current project if it was removed
    if (currentProject?.path === editingProjectPath) {
      currentProject = null;
      document.getElementById('terminal-content').innerHTML = `
        <div class="terminal-search" id="terminal-search">
          <input type="text" class="terminal-search-input" id="terminal-search-input" placeholder="Search...">
          <span class="terminal-search-count" id="terminal-search-count"></span>
          <div class="terminal-search-nav">
            <button class="terminal-search-btn" id="terminal-search-prev" title="Previous">▲</button>
            <button class="terminal-search-btn" id="terminal-search-next" title="Next">▼</button>
          </div>
          <button class="terminal-search-btn terminal-search-close" id="terminal-search-close" title="Close">×</button>
        </div>
        <div class="terminal-placeholder">
          <div class="terminal-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
              <path d="M4 17l6-6-6-6M12 19h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <p>Select a project to start</p>
          <span class="hint">Or click to open terminal in home directory</span>
        </div>
      `;
      renderFileTree(null);
      loadGitStatus(null);
      loadNotesForProject(null);
      renderTerminalTabs();
    }

    closeProjectSettings();
  }
});

// ===== Export/Import Settings =====
document.getElementById('settings-export').addEventListener('click', async () => {
  const result = await window.electronAPI.storeExport();
  if (result.success) {
    alert('Settings exported successfully.');
  }
});

document.getElementById('settings-import').addEventListener('click', async () => {
  const result = await window.electronAPI.storeImport();
  if (result.success) {
    // Reload caches from disk and re-render
    const [projectsData, sessionsData, notesData, profilesData, prefsData] = await Promise.all([
      window.electronAPI.storeRead('projects.json'),
      window.electronAPI.storeRead('sessions.json'),
      window.electronAPI.storeRead('notes.json'),
      window.electronAPI.storeRead('profiles.json'),
      window.electronAPI.storeRead('preferences.json'),
    ]);
    if (projectsData) { cachedProjects = projectsData.list || []; cachedProjectSettings = projectsData.settings || {}; }
    if (sessionsData) cachedSessions = sessionsData;
    if (notesData) cachedNotes = notesData;
    if (profilesData) cachedProfiles = profilesData;
    if (prefsData) cachedPreferences = prefsData;
    initTheme();
    renderProjects(getProjects());
    loadNotesForProject(currentProject?.path || null);
    alert('Settings imported successfully.');
  } else if (result.error) {
    alert('Import failed: ' + result.error);
  }
});

// ===== Terminal Profiles =====
const TERMINAL_PROFILES_KEY = 'programming-interface-terminal-profiles';
const ACTIVE_PROFILE_KEY = 'programming-interface-active-profile';

function getTerminalProfiles() {
  return cachedProfiles.profiles || [];
}

function saveTerminalProfiles(profiles) {
  cachedProfiles.profiles = profiles;
  window.electronAPI.storeWrite('profiles.json', cachedProfiles);
}

function getActiveProfileName() {
  return cachedProfiles.active || 'Default';
}

function setActiveProfileName(name) {
  cachedProfiles.active = name;
  window.electronAPI.storeWrite('profiles.json', cachedProfiles);
}

function getActiveProfile() {
  const name = getActiveProfileName();
  if (name === 'Default') return null;
  const profiles = getTerminalProfiles();
  return profiles.find(p => p.name === name) || null;
}

function renderProfileDropdown() {
  const dropdown = document.getElementById('profile-dropdown');
  const profiles = getTerminalProfiles();
  const activeName = getActiveProfileName();

  let html = `
    <button class="profile-option" data-profile="Default">
      <span class="check">${activeName === 'Default' ? '✓' : ''}</span>
      <span class="profile-option-name">Default</span>
    </button>
  `;

  profiles.forEach(p => {
    html += `
      <button class="profile-option" data-profile="${p.name}">
        <span class="check">${activeName === p.name ? '✓' : ''}</span>
        <span class="profile-option-name">${p.name}</span>
      </button>
    `;
  });

  html += '<div class="profile-divider"></div>';
  html += '<button class="profile-option" data-action="manage"><span class="check"></span><span class="profile-option-name">Manage Profiles...</span></button>';

  dropdown.innerHTML = html;

  dropdown.querySelectorAll('.profile-option').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const action = btn.dataset.action;
      if (action === 'manage') {
        dropdown.classList.remove('active');
        openProfileManager();
        return;
      }
      const profileName = btn.dataset.profile;
      setActiveProfileName(profileName);
      dropdown.classList.remove('active');
      renderProfileDropdown();
    });
  });
}

document.getElementById('profile-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const dropdown = document.getElementById('profile-dropdown');
  const wasActive = dropdown.classList.contains('active');
  // Close any other open dropdowns
  document.querySelectorAll('.profile-dropdown.active').forEach(d => d.classList.remove('active'));
  if (!wasActive) {
    renderProfileDropdown();
    dropdown.classList.add('active');
  }
});

// Close profile dropdown on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.profile-selector')) {
    document.getElementById('profile-dropdown').classList.remove('active');
  }
});

function openProfileManager() {
  const overlay = document.getElementById('profile-overlay');
  overlay.classList.add('active');
  renderProfileList();
}

function closeProfileManager() {
  document.getElementById('profile-overlay').classList.remove('active');
}

document.getElementById('profile-close').addEventListener('click', closeProfileManager);
document.getElementById('profile-manager-close').addEventListener('click', closeProfileManager);
document.getElementById('profile-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'profile-overlay') closeProfileManager();
});

function renderProfileList() {
  const content = document.getElementById('profile-manager-content');
  const profiles = getTerminalProfiles();

  if (profiles.length === 0) {
    content.innerHTML = '<div class="empty-state" style="padding:24px"><p>No custom profiles</p><span>Click "Add Profile" to create one</span></div>';
  } else {
    content.innerHTML = profiles.map((p, i) => `
      <div class="profile-item" data-index="${i}">
        <span class="profile-item-name">${p.name}</span>
        <span class="profile-item-shell">${p.shell || 'default'}</span>
        <div class="profile-item-actions">
          <button class="edit" data-index="${i}" title="Edit">&#9998;</button>
          <button class="delete" data-index="${i}" title="Delete">&#10005;</button>
        </div>
      </div>
    `).join('');

    content.querySelectorAll('.profile-item-actions .edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index);
        editProfile(idx);
      });
    });

    content.querySelectorAll('.profile-item-actions .delete').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index);
        const profiles = getTerminalProfiles();
        const removed = profiles[idx];
        profiles.splice(idx, 1);
        saveTerminalProfiles(profiles);
        // If active profile was deleted, reset to Default
        if (getActiveProfileName() === removed.name) {
          setActiveProfileName('Default');
        }
        renderProfileList();
      });
    });
  }
}

document.getElementById('profile-add-btn').addEventListener('click', () => {
  editProfile(-1);
});

function editProfile(index) {
  const content = document.getElementById('profile-manager-content');
  const profiles = getTerminalProfiles();
  const profile = index >= 0 ? profiles[index] : { name: '', shell: '', env: '', fontSize: '', fontFamily: '' };

  content.innerHTML = `
    <div class="profile-edit-form">
      <div class="settings-section">
        <label class="settings-label">Profile Name</label>
        <input type="text" class="settings-input" id="profile-edit-name" value="${profile.name}" placeholder="My Profile">
      </div>
      <div class="settings-section">
        <label class="settings-label">Shell</label>
        <select class="settings-select" id="profile-edit-shell">
          <option value="" ${!profile.shell ? 'selected' : ''}>System default</option>
          <option value="/bin/zsh" ${profile.shell === '/bin/zsh' ? 'selected' : ''}>Zsh (/bin/zsh)</option>
          <option value="/bin/bash" ${profile.shell === '/bin/bash' ? 'selected' : ''}>Bash (/bin/bash)</option>
          <option value="/bin/sh" ${profile.shell === '/bin/sh' ? 'selected' : ''}>Sh (/bin/sh)</option>
        </select>
      </div>
      <div class="settings-section">
        <label class="settings-label">Environment Variables</label>
        <textarea class="settings-input" id="profile-edit-env" rows="3" placeholder="KEY=value&#10;ANOTHER=value">${profile.env || ''}</textarea>
      </div>
      <div class="settings-section">
        <label class="settings-label">Font Size</label>
        <input type="number" class="settings-input" id="profile-edit-fontsize" value="${profile.fontSize || ''}" placeholder="13" min="8" max="32">
      </div>
      <div class="settings-section">
        <label class="settings-label">Font Family</label>
        <input type="text" class="settings-input" id="profile-edit-fontfamily" value="${profile.fontFamily || ''}" placeholder='"SF Mono", "Fira Code", monospace'>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        <button class="settings-btn settings-btn-secondary" id="profile-edit-cancel">Cancel</button>
        <button class="settings-btn settings-btn-primary" id="profile-edit-save">Save</button>
      </div>
    </div>
  `;

  document.getElementById('profile-edit-cancel').addEventListener('click', renderProfileList);
  document.getElementById('profile-edit-save').addEventListener('click', () => {
    const name = document.getElementById('profile-edit-name').value.trim();
    if (!name) return;

    const updated = {
      name,
      shell: document.getElementById('profile-edit-shell').value,
      env: document.getElementById('profile-edit-env').value,
      fontSize: document.getElementById('profile-edit-fontsize').value,
      fontFamily: document.getElementById('profile-edit-fontfamily').value
    };

    const profiles = getTerminalProfiles();
    if (index >= 0) {
      // If name changed and was active, update active
      if (getActiveProfileName() === profiles[index].name && profiles[index].name !== name) {
        setActiveProfileName(name);
      }
      profiles[index] = updated;
    } else {
      profiles.push(updated);
    }
    saveTerminalProfiles(profiles);
    renderProfileList();
  });
}

// ===== Broadcast Mode =====
function toggleBroadcastMode() {
  broadcastMode = !broadcastMode;
  const btn = document.getElementById('broadcast-btn');
  if (broadcastMode) {
    btn.classList.add('active');
  } else {
    btn.classList.remove('active');
  }
  renderTerminalTabs();
}

document.getElementById('broadcast-btn').addEventListener('click', () => {
  toggleBroadcastMode();
});

// ===== Session Restore =====
const SESSION_KEY = 'programming-interface-session';

function getTerminalBuffer(term) {
  const buf = term.buffer.active;
  const lines = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (line) lines.push(line.translateToString(true));
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  // Cap at 5000 lines to avoid bloat
  if (lines.length > 5000) lines.splice(0, lines.length - 5000);
  return lines.join('\n');
}

function saveSession() {
  if (!currentProject) return;

  const session = {
    activeProject: currentProject.path,
    openTerminals: {}
  };

  // Save terminal tab info for each project (including buffer content)
  for (const [projectPath, data] of projectData) {
    session.openTerminals[projectPath] = {
      tabCount: data.tabs.length,
      activeTabIndex: data.activeTabIndex,
      tabs: data.tabs.map(t => ({
        name: t.name,
        bufferContent: getTerminalBuffer(t.terminal)
      }))
    };
  }

  cachedSessions = session;
  window.electronAPI.storeWrite('sessions.json', session);
}

async function restoreSession() {
  const session = cachedSessions;
  if (!session || !session.activeProject) return;

  try {
    const projects = getProjects();

    // Find and select the active project
    const project = projects.find(p => p.path === session.activeProject);
    if (project) {
      selectProject(project);

      // Restore buffer content into first tab if available
      const termData = session.openTerminals && session.openTerminals[project.path];
      if (termData && termData.tabs && termData.tabs.length > 0) {
        const pData = projectData.get(project.path);
        if (pData && pData.tabs.length > 0 && termData.tabs[0].bufferContent) {
          pData.tabs[0].terminal.write(termData.tabs[0].bufferContent);
        }
      }
    }
  } catch (e) {
    console.error('Failed to restore session:', e);
  }
}

// Save session periodically and on visibility change
setInterval(saveSession, 30000); // Every 30 seconds

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    saveSession();
  }
});

// ===== DataStore Initialization =====
async function initDataStore() {
  // Load all store files
  const [projectsData, sessionsData, notesData, profilesData, prefsData] = await Promise.all([
    window.electronAPI.storeRead('projects.json'),
    window.electronAPI.storeRead('sessions.json'),
    window.electronAPI.storeRead('notes.json'),
    window.electronAPI.storeRead('profiles.json'),
    window.electronAPI.storeRead('preferences.json'),
  ]);

  // Check if store files exist; if not, migrate from localStorage
  const hasStoreData = projectsData || sessionsData || notesData || profilesData || prefsData;

  if (!hasStoreData) {
    // One-time migration from localStorage
    migrateFromLocalStorage();
  } else {
    // Populate caches from disk
    if (projectsData) {
      cachedProjects = projectsData.list || [];
      cachedProjectSettings = projectsData.settings || {};
    }
    if (sessionsData) cachedSessions = sessionsData;
    if (notesData) cachedNotes = notesData;
    if (profilesData) cachedProfiles = profilesData;
    if (prefsData) cachedPreferences = prefsData;
  }

  // Apply theme and render
  initTheme();
  renderProjects(getProjects());
  loadNotesForProject(null);
  restoreSession();
}

function migrateFromLocalStorage() {
  // Projects
  try {
    const projects = JSON.parse(localStorage.getItem('programming-interface-projects') || '[]');
    const allSettings = JSON.parse(localStorage.getItem('programming-interface-project-settings') || '{}');
    cachedProjects = projects;
    cachedProjectSettings = allSettings;
    window.electronAPI.storeWrite('projects.json', { list: projects, settings: allSettings });
  } catch { /* ignore */ }

  // Sessions
  try {
    const sessionRaw = localStorage.getItem('programming-interface-session');
    if (sessionRaw) {
      cachedSessions = JSON.parse(sessionRaw);
      window.electronAPI.storeWrite('sessions.json', cachedSessions);
    }
  } catch { /* ignore */ }

  // Notes
  try {
    const notes = {};
    const globalNotes = localStorage.getItem('programming-interface-global-notes');
    if (globalNotes) notes['__global__'] = globalNotes;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('programming-interface-notes-')) {
        const projectPath = key.replace('programming-interface-notes-', '');
        notes[projectPath] = localStorage.getItem(key);
      }
    }
    cachedNotes = notes;
    window.electronAPI.storeWrite('notes.json', notes);
  } catch { /* ignore */ }

  // Profiles
  try {
    const profiles = JSON.parse(localStorage.getItem('programming-interface-terminal-profiles') || '[]');
    const active = localStorage.getItem('programming-interface-active-profile') || 'Default';
    cachedProfiles = { profiles, active };
    window.electronAPI.storeWrite('profiles.json', cachedProfiles);
  } catch { /* ignore */ }

  // Preferences
  try {
    const theme = localStorage.getItem('programming-interface-theme') || 'light';
    const shortcuts = JSON.parse(localStorage.getItem('programming-interface-custom-shortcuts') || '{}');
    cachedPreferences = { theme, customShortcuts: shortcuts };
    window.electronAPI.storeWrite('preferences.json', cachedPreferences);
  } catch { /* ignore */ }

  console.log('Migrated data from localStorage to DataStore');
}

// Start async initialization (replaces synchronous init calls below)
initDataStore();

// ===== Auto Updater UI =====
let updateAvailable = null;

function showUpdateNotification(info) {
  // Create update banner if it doesn't exist
  let banner = document.getElementById('update-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.className = 'update-banner';
    document.body.appendChild(banner);
  }

  banner.innerHTML = `
    <span class="update-message">Update available: v${info.version}</span>
    <div class="update-actions">
      <button class="update-btn update-download" id="update-download-btn">Download</button>
      <button class="update-btn update-dismiss" id="update-dismiss-btn">Later</button>
    </div>
  `;
  banner.classList.add('visible');

  document.getElementById('update-download-btn').addEventListener('click', async () => {
    banner.innerHTML = '<span class="update-message">Downloading update...</span>';
    await window.electronAPI.downloadUpdate();
  });

  document.getElementById('update-dismiss-btn').addEventListener('click', () => {
    banner.classList.remove('visible');
  });
}

function showUpdateReady() {
  let banner = document.getElementById('update-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.className = 'update-banner';
    document.body.appendChild(banner);
  }

  banner.innerHTML = `
    <span class="update-message">Update ready to install</span>
    <div class="update-actions">
      <button class="update-btn update-install" id="update-install-btn">Restart Now</button>
      <button class="update-btn update-dismiss" id="update-later-btn">Later</button>
    </div>
  `;
  banner.classList.add('visible');

  document.getElementById('update-install-btn').addEventListener('click', () => {
    window.electronAPI.installUpdate();
  });

  document.getElementById('update-later-btn').addEventListener('click', () => {
    banner.classList.remove('visible');
  });
}

// Listen for update status
if (window.electronAPI.onUpdateStatus) {
  window.electronAPI.onUpdateStatus((data) => {
    console.log('Update status:', data.status, data);

    if (data.status === 'available') {
      updateAvailable = data;
      showUpdateNotification(data);
    } else if (data.status === 'downloaded') {
      showUpdateReady();
    }
  });
}

// ===== Shortcut Editor =====
function openShortcutEditor() {
  const overlay = document.getElementById('shortcut-editor-overlay');
  overlay.classList.add('active');
  renderShortcutList();
}

function closeShortcutEditor() {
  const overlay = document.getElementById('shortcut-editor-overlay');
  overlay.classList.remove('active');
  capturingShortcutId = null;
}

function renderShortcutList() {
  const container = document.getElementById('shortcut-editor-list');
  const categories = {};
  for (const entry of SHORTCUT_REGISTRY) {
    if (!categories[entry.category]) categories[entry.category] = [];
    categories[entry.category].push(entry);
  }
  container.innerHTML = Object.entries(categories).map(([cat, entries]) => `
    <div class="shortcut-category-header">${cat}</div>
    ${entries.map(entry => {
      const binding = getEffectiveBinding(entry.id);
      const isCapturing = capturingShortcutId === entry.id;
      return `
        <div class="shortcut-row" data-id="${entry.id}">
          <span class="shortcut-row-label">${entry.label}</span>
          <span class="shortcut-row-binding ${isCapturing ? 'capturing' : ''}">${isCapturing ? 'Press shortcut...' : (binding ? formatShortcut(binding) : '—')}</span>
        </div>
      `;
    }).join('')}
  `).join('');

  container.querySelectorAll('.shortcut-row').forEach(row => {
    row.addEventListener('click', () => {
      capturingShortcutId = row.dataset.id;
      renderShortcutList();
    });
  });
}

// Capture handler for shortcut editor
document.addEventListener('keydown', (e) => {
  if (!capturingShortcutId) return;
  if (!e.metaKey && !e.ctrlKey && e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === 'Escape') {
    capturingShortcutId = null;
    renderShortcutList();
    return;
  }

  const newBinding = {
    key: e.key === '|' ? '\\' : e.key,
    metaKey: true,
    shiftKey: e.shiftKey,
    altKey: e.altKey
  };

  const custom = getCustomShortcuts();
  custom[capturingShortcutId] = newBinding;
  saveCustomShortcuts(custom);
  capturingShortcutId = null;
  renderShortcutList();
}, true);

document.getElementById('shortcut-editor-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'shortcut-editor-overlay') closeShortcutEditor();
});

document.getElementById('shortcut-reset-all').addEventListener('click', () => {
  cachedPreferences.customShortcuts = {};
  window.electronAPI.storeWrite('preferences.json', cachedPreferences);
  capturingShortcutId = null;
  renderShortcutList();
});

document.getElementById('shortcut-done').addEventListener('click', closeShortcutEditor);
document.getElementById('shortcut-editor-close').addEventListener('click', closeShortcutEditor);

// ===== Command Palette =====
let commandPaletteSelectedIndex = 0;
let filteredCommands = [];

function openCommandPalette() {
  const overlay = document.getElementById('command-palette-overlay');
  const input = document.getElementById('command-palette-input');
  overlay.classList.add('active');
  input.value = '';
  commandPaletteSelectedIndex = 0;
  filteredCommands = [...SHORTCUT_REGISTRY];
  renderCommandPaletteResults();
  input.focus();
}

function closeCommandPalette() {
  document.getElementById('command-palette-overlay').classList.remove('active');
}

function fuzzyMatch(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

function filterCommands(query) {
  if (!query) return [...SHORTCUT_REGISTRY];
  return SHORTCUT_REGISTRY.filter(e => fuzzyMatch(query, e.label) || fuzzyMatch(query, e.category));
}

function renderCommandPaletteResults() {
  const results = document.getElementById('command-palette-results');
  if (filteredCommands.length === 0) {
    results.innerHTML = '<div class="command-palette-empty">No matching commands</div>';
    return;
  }
  results.innerHTML = filteredCommands.map((cmd, i) => {
    const binding = getEffectiveBinding(cmd.id);
    return `
      <div class="command-palette-item ${i === commandPaletteSelectedIndex ? 'selected' : ''}" data-index="${i}">
        <span class="command-palette-category">${cmd.category}</span>
        <span class="command-palette-label">${cmd.label}</span>
        ${binding ? `<span class="command-palette-shortcut">${formatShortcut(binding)}</span>` : ''}
      </div>
    `;
  }).join('');

  results.querySelectorAll('.command-palette-item').forEach(item => {
    item.addEventListener('click', () => executeCommand(parseInt(item.dataset.index)));
    item.addEventListener('mouseenter', () => {
      commandPaletteSelectedIndex = parseInt(item.dataset.index);
      updateCommandPaletteSelection();
    });
  });
}

function updateCommandPaletteSelection() {
  const results = document.getElementById('command-palette-results');
  results.querySelectorAll('.command-palette-item').forEach((el, i) => {
    el.classList.toggle('selected', i === commandPaletteSelectedIndex);
    if (i === commandPaletteSelectedIndex) el.scrollIntoView({ block: 'nearest' });
  });
}

function executeCommand(index) {
  if (index >= 0 && index < filteredCommands.length) {
    closeCommandPalette();
    filteredCommands[index].action();
  }
}

document.getElementById('command-palette-input').addEventListener('input', (e) => {
  filteredCommands = filterCommands(e.target.value);
  commandPaletteSelectedIndex = 0;
  renderCommandPaletteResults();
});

document.getElementById('command-palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    commandPaletteSelectedIndex = Math.min(commandPaletteSelectedIndex + 1, filteredCommands.length - 1);
    updateCommandPaletteSelection();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    commandPaletteSelectedIndex = Math.max(commandPaletteSelectedIndex - 1, 0);
    updateCommandPaletteSelection();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    executeCommand(commandPaletteSelectedIndex);
  } else if (e.key === 'Escape') {
    closeCommandPalette();
  }
});

document.getElementById('command-palette-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'command-palette-overlay') closeCommandPalette();
});

// ===== Tab Overflow Handling =====
function updateTabScrollButtons() {
  const tabs = document.getElementById('terminal-tabs');
  const leftBtn = document.getElementById('tab-scroll-left');
  const rightBtn = document.getElementById('tab-scroll-right');
  if (!tabs || !leftBtn || !rightBtn) return;

  const hasOverflow = tabs.scrollWidth > tabs.clientWidth + 1;
  leftBtn.classList.toggle('visible', hasOverflow && tabs.scrollLeft > 0);
  rightBtn.classList.toggle('visible', hasOverflow && tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 1);
}

function scrollTabsBy(delta) {
  const tabs = document.getElementById('terminal-tabs');
  tabs.scrollBy({ left: delta, behavior: 'smooth' });
  setTimeout(updateTabScrollButtons, 300);
}

function scrollActiveTabIntoView() {
  const tabs = document.getElementById('terminal-tabs');
  const activeTab = tabs.querySelector('.terminal-tab.active');
  if (activeTab) {
    activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    setTimeout(updateTabScrollButtons, 300);
  }
}

document.getElementById('tab-scroll-left').addEventListener('click', () => scrollTabsBy(-120));
document.getElementById('tab-scroll-right').addEventListener('click', () => scrollTabsBy(120));
document.getElementById('terminal-tabs').addEventListener('scroll', updateTabScrollButtons);

// ===== Detachable Panels =====
const detachedPanels = new Set();

function getActiveContextTab() {
  const activeTab = document.querySelector('.context-tabs .tab.active');
  return activeTab ? activeTab.dataset.tab : 'preview';
}

// Pop-out button handler
document.getElementById('popout-btn').addEventListener('click', async () => {
  const panelType = getActiveContextTab();
  if (detachedPanels.has(panelType)) return;

  await window.electronAPI.openPanelWindow(panelType);
  detachedPanels.add(panelType);

  // Mark tab as detached
  const tab = document.querySelector(`.context-tabs .tab[data-tab="${panelType}"]`);
  if (tab) tab.classList.add('detached');

  // Send initial state
  sendPanelState(panelType);
});

function sendPanelState(panelType) {
  const theme = getCurrentTheme();

  if (panelType === 'preview') {
    const previewTab = document.getElementById('preview-tab');
    window.electronAPI.sendPanelUpdate(panelType, {
      theme,
      html: previewTab.innerHTML
    });
  } else if (panelType === 'files') {
    const fileTree = document.getElementById('file-tree');
    window.electronAPI.sendPanelUpdate(panelType, {
      theme,
      html: fileTree.innerHTML
    });
  } else if (panelType === 'git') {
    const gitPanel = document.getElementById('git-panel');
    window.electronAPI.sendPanelUpdate(panelType, {
      theme,
      html: gitPanel.innerHTML
    });
  } else if (panelType === 'notes') {
    const notesEditor = document.getElementById('notes-editor');
    window.electronAPI.sendPanelUpdate(panelType, {
      theme,
      notesContent: notesEditor.value
    });
  }
}

function notifyDetachedPanels() {
  for (const panelType of detachedPanels) {
    sendPanelState(panelType);
  }
}

// Handle panel window closed
window.electronAPI.onPanelWindowClosed((panelType) => {
  detachedPanels.delete(panelType);
  const tab = document.querySelector(`.context-tabs .tab[data-tab="${panelType}"]`);
  if (tab) tab.classList.remove('detached');
});

// Handle actions from panel windows
window.electronAPI.onPanelAction(({ panelType, action, payload }) => {
  if (panelType === 'files') {
    if (action === 'open-file' && payload.path) {
      previewFile(payload.path);
    } else if (action === 'toggle-folder' && payload.path) {
      // Toggle in main file tree and resend state
      if (expandedFolders.has(payload.path)) {
        expandedFolders.delete(payload.path);
      } else {
        expandedFolders.add(payload.path);
        if (!fileTreeData.has(payload.path)) {
          loadFileTree(payload.path).then(children => {
            fileTreeData.set(payload.path, children);
            rebuildVisibleItems();
            const fileTree = document.getElementById('file-tree');
            updateFileTreeSentinel(fileTree);
            renderVisibleItems(fileTree);
            sendPanelState('files');
          });
          return;
        }
      }
      rebuildVisibleItems();
      const fileTree = document.getElementById('file-tree');
      updateFileTreeSentinel(fileTree);
      renderVisibleItems(fileTree);
      sendPanelState('files');
    }
  } else if (panelType === 'notes' && action === 'notes-update') {
    const notesEditor = document.getElementById('notes-editor');
    notesEditor.value = payload.content;
    saveNotesForProject(currentProject?.path);
  }
});

// Handle panel requesting initial state
window.electronAPI.onPanelRequestState((panelType) => {
  sendPanelState(panelType);
});

// Sync detached panels via MutationObservers on panel content
const previewObserver = new MutationObserver(() => {
  if (detachedPanels.has('preview')) sendPanelState('preview');
});
previewObserver.observe(document.getElementById('preview-tab'), { childList: true, subtree: true });

const filesObserver = new MutationObserver(() => {
  if (detachedPanels.has('files')) sendPanelState('files');
});
filesObserver.observe(document.getElementById('file-tree'), { childList: true, subtree: true });

const gitObserver = new MutationObserver(() => {
  if (detachedPanels.has('git')) sendPanelState('git');
});
gitObserver.observe(document.getElementById('git-panel'), { childList: true, subtree: true });

// Notes sync on input
document.getElementById('notes-editor').addEventListener('input', () => {
  if (detachedPanels.has('notes')) sendPanelState('notes');
});

console.log('Programming Interface loaded');
