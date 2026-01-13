const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { SearchAddon } = require('@xterm/addon-search');
const { marked } = require('marked');

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

// Preview state
let currentPreviewFile = null;
let currentPreviewContent = null;
let currentPreviewMode = 'raw'; // 'raw' or 'live'

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
  return localStorage.getItem(THEME_KEY) || 'light';
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);

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

initTheme();

// ===== Terminal Management =====
function generateTerminalId() {
  return `term-${Date.now()}-${++terminalCounter}`;
}

function createTerminalInstance() {
  const theme = getCurrentTheme() === 'dark' ? darkTerminalTheme : lightTerminalTheme;

  const terminal = new Terminal({
    theme,
    fontFamily: '"SF Mono", "Fira Code", "JetBrains Mono", monospace',
    fontSize: 13,
    lineHeight: 1.4,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 10000
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);

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
    if (splitState.active && isTerminalInSplit(tab.id)) {
      splitClass = 'in-split';
      if (tab.id === splitState.leftId) {
        splitIndicator = '<span class="split-indicator split-left" title="Left pane">◧</span>';
      } else {
        splitIndicator = '<span class="split-indicator split-right" title="Right pane">◨</span>';
      }
    }

    return `
      <div class="terminal-tab ${index === data.activeTabIndex ? 'active' : ''} ${splitClass}"
           data-index="${index}" data-id="${tab.id}" draggable="true">
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

  // Create terminal
  const { terminal, fitAddon, searchAddon } = createTerminalInstance();
  terminal.open(container);

  // Handle input
  terminal.onData((inputData) => {
    window.electronAPI.terminalInput(id, inputData);
  });

  // Get project settings for shell, env, and startup command
  const settings = getProjectSettings(projectPath);
  const terminalOptions = {};
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
  rightId: null
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
async function enterSplitMode(leftId, rightId) {
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
    rightId: rightId
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
  splitContainer.className = 'terminal-split-container horizontal';

  // Create panes
  const pane1 = document.createElement('div');
  pane1.className = 'terminal-split-pane';
  pane1.dataset.terminalId = leftId;

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'split-resize-handle horizontal';

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
  setupSplitResize(resizeHandle, pane1, pane2, 'horizontal');
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
    rightId: null
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

// Toggle split: if active, exit; if not, split with current tab
async function splitTerminal() {
  if (!currentProject || !projectData.has(currentProject.path)) return;

  const data = projectData.get(currentProject.path);
  if (data.tabs.length === 0) return;

  if (splitState.active) {
    // If we're already in split mode, exit
    exitSplitMode();
  } else {
    // Enter split mode with current tab on left, new tab on right
    const currentTab = data.tabs[data.activeTabIndex];
    await enterSplitMode(currentTab.id, null);
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

// Split terminal button
document.getElementById('split-terminal-btn').addEventListener('click', () => {
  splitTerminal();
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

  const { branch, files, commits } = status;
  const hasChanges = files.staged.length > 0 || files.unstaged.length > 0 || files.untracked.length > 0;

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
                <span>${b}</span>
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

  // Recent commits
  if (commits.length > 0) {
    html += `
      <div class="git-section">
        <div class="git-section-header"><span>Recent Commits</span></div>
        <div class="git-commits">
          ${commits.map(c => `
            <div class="git-commit">
              <span class="git-hash">${c.hash}</span>
              <span class="git-message">${c.message}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  html += '</div>';
  gitPanel.innerHTML = html;

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

  const diffHtml = renderDiff(result.output);
  previewTab.innerHTML = `
    <div class="file-preview">
      <div class="preview-header">
        <span class="preview-filename">${fileName} (${staged ? 'staged' : 'unstaged'})</span>
      </div>
      <div class="diff-viewer">${diffHtml}</div>
    </div>
  `;
}

function renderDiff(diffText) {
  const lines = diffText.split('\n');
  let html = '';
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      // Skip diff header
      continue;
    } else if (line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      // Skip these headers
      continue;
    } else if (line.startsWith('@@')) {
      html += `<div class="diff-hunk-header">${escapeHtml(line)}</div>`;
      inHunk = true;
    } else if (inHunk) {
      if (line.startsWith('+')) {
        html += `<div class="diff-line addition">${escapeHtml(line)}</div>`;
      } else if (line.startsWith('-')) {
        html += `<div class="diff-line deletion">${escapeHtml(line)}</div>`;
      } else {
        html += `<div class="diff-line context">${escapeHtml(line)}</div>`;
      }
    }
  }

  return html || '<div class="diff-empty">No diff content</div>';
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ===== File Tree =====
let expandedFolders = new Set();

async function loadFileTree(dirPath) {
  const result = await window.electronAPI.readDirectory(dirPath);
  if (!result.success) return [];
  return result.items;
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
    return;
  }

  fileTree.innerHTML = '<div class="loading">Loading...</div>';
  const items = await loadFileTree(projectPath);
  fileTree.innerHTML = '';

  for (const item of items) {
    await addFileItem(item, fileTree, 0);
  }
}

async function addFileItem(item, container, depth) {
  const div = document.createElement('div');
  div.className = `file-item ${item.isDirectory ? 'folder' : 'file'}`;
  div.style.paddingLeft = `${12 + depth * 16}px`;
  div.dataset.path = item.path;

  const icon = item.isDirectory
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z" stroke="currentColor" stroke-width="1.5"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="currentColor" stroke-width="1.5"/><path d="M14 2v6h6" stroke="currentColor" stroke-width="1.5"/></svg>`;

  div.innerHTML = `${icon}<span>${item.name}</span>`;
  container.appendChild(div);

  div.addEventListener('click', async (e) => {
    e.stopPropagation();

    if (item.isDirectory) {
      const isExpanded = expandedFolders.has(item.path);

      if (isExpanded) {
        expandedFolders.delete(item.path);
        let next = div.nextElementSibling;
        while (next && parseInt(next.style.paddingLeft) > parseInt(div.style.paddingLeft)) {
          const toRemove = next;
          next = next.nextElementSibling;
          toRemove.remove();
        }
      } else {
        expandedFolders.add(item.path);
        const children = await loadFileTree(item.path);
        let insertAfter = div;
        for (const child of children) {
          insertAfter = await addFileItemAfter(child, insertAfter, depth + 1);
        }
      }
    } else {
      await previewFile(item.path);
    }
  });

  return div;
}

async function addFileItemAfter(item, afterElement, depth) {
  const div = document.createElement('div');
  div.className = `file-item ${item.isDirectory ? 'folder' : 'file'}`;
  div.style.paddingLeft = `${12 + depth * 16}px`;
  div.dataset.path = item.path;

  const icon = item.isDirectory
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z" stroke="currentColor" stroke-width="1.5"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="currentColor" stroke-width="1.5"/><path d="M14 2v6h6" stroke="currentColor" stroke-width="1.5"/></svg>`;

  div.innerHTML = `${icon}<span>${item.name}</span>`;
  afterElement.after(div);

  div.addEventListener('click', async (e) => {
    e.stopPropagation();

    if (item.isDirectory) {
      const isExpanded = expandedFolders.has(item.path);

      if (isExpanded) {
        expandedFolders.delete(item.path);
        let next = div.nextElementSibling;
        while (next && parseInt(next.style.paddingLeft) > parseInt(div.style.paddingLeft)) {
          const toRemove = next;
          next = next.nextElementSibling;
          toRemove.remove();
        }
      } else {
        expandedFolders.add(item.path);
        const children = await loadFileTree(item.path);
        let insertAfter = div;
        for (const child of children) {
          insertAfter = await addFileItemAfter(child, insertAfter, depth + 1);
        }
      }
    } else {
      await previewFile(item.path);
    }
  });

  return div;
}

function canShowLivePreview(extension) {
  return ['.md', '.markdown', '.html', '.htm'].includes(extension.toLowerCase());
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

  // Handle image files
  if (isImage) {
    previewTab.innerHTML = `
      <div class="file-preview">
        <div class="preview-header">
          <span class="preview-filename">${name}</span>
        </div>
        <div class="preview-image-container">
          <img class="preview-image" src="${dataUrl}" alt="${name}">
        </div>
      </div>
    `;
    return;
  }

  const showLive = canShowLivePreview(extension);

  // Build header with mode toggle
  let html = `
    <div class="file-preview">
      <div class="preview-header">
        <span class="preview-filename">${name}</span>
        ${showLive ? `
          <div class="preview-mode-toggle">
            <button class="preview-mode-btn ${currentPreviewMode === 'raw' ? 'active' : ''}" data-mode="raw">Raw</button>
            <button class="preview-mode-btn ${currentPreviewMode === 'live' ? 'active' : ''}" data-mode="live">Live</button>
          </div>
        ` : ''}
      </div>
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
    // Raw mode
    const escaped = content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    html += `<pre class="file-preview-content"><code>${escaped}</code></pre>`;
  }

  html += '</div>';
  previewTab.innerHTML = html;

  // Add mode toggle listeners
  previewTab.querySelectorAll('.preview-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentPreviewMode = btn.dataset.mode;
      renderPreview();
    });
  });

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
    // Load global notes when no project selected
    const globalNotes = localStorage.getItem(GLOBAL_NOTES_KEY) || '';
    notesEditor.value = globalNotes;
    notesEditor.placeholder = 'Write notes, draft prompts, or save code snippets...';
  } else {
    const key = getProjectNotesKey(projectPath);
    const notes = localStorage.getItem(key) || '';
    notesEditor.value = notes;
    notesEditor.placeholder = `Notes for ${projectPath.split('/').pop()}...`;
  }
}

function saveNotesForProject(projectPath) {
  if (!projectPath) {
    localStorage.setItem(GLOBAL_NOTES_KEY, notesEditor.value);
  } else {
    localStorage.setItem(getProjectNotesKey(projectPath), notesEditor.value);
  }
}

notesEditor.addEventListener('input', () => {
  saveNotesForProject(currentProject?.path);
});

// Load global notes initially
loadNotesForProject(null);

// ===== Projects =====
const projectList = document.getElementById('project-list');
const addProjectBtn = document.getElementById('add-project-btn');
const PROJECTS_KEY = 'programming-interface-projects';

function getProjects() {
  return JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]');
}

function saveProjects(projects) {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
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

  currentProject = project;

  document.querySelectorAll('.project-item').forEach(item => {
    item.classList.toggle('active', item.dataset.path === project.path);
  });

  initTerminalForProject(project.path, project.path);
  renderFileTree(project.path);
  loadGitStatus(project.path);
  loadNotesForProject(project.path);
  expandedFolders.clear();
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

  projectList.innerHTML = projects.map((project, index) => `
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
  `).join('');

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

addProjectBtn.addEventListener('click', async () => {
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

renderProjects(getProjects());

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
  });
}

// ===== Quick File Open (Cmd+P) =====
const quickOpenOverlay = document.getElementById('quick-open-overlay');
const quickOpenInput = document.getElementById('quick-open-input');
const quickOpenResults = document.getElementById('quick-open-results');
let allFiles = [];
let filteredFiles = [];
let selectedFileIndex = 0;

async function collectAllFiles(dirPath, basePath = '', files = []) {
  const result = await window.electronAPI.readDirectory(dirPath);
  if (!result.success) return files;

  for (const item of result.items) {
    const relativePath = basePath ? `${basePath}/${item.name}` : item.name;
    if (item.isDirectory) {
      // Skip common non-essential directories
      if (!['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'venv'].includes(item.name)) {
        await collectAllFiles(item.path, relativePath, files);
      }
    } else {
      files.push({ name: item.name, path: item.path, relativePath });
    }
  }
  return files;
}

function fuzzyMatch(query, text) {
  query = query.toLowerCase();
  text = text.toLowerCase();

  let queryIndex = 0;
  for (let i = 0; i < text.length && queryIndex < query.length; i++) {
    if (text[i] === query[queryIndex]) queryIndex++;
  }
  return queryIndex === query.length;
}

function renderQuickOpenResults() {
  if (filteredFiles.length === 0) {
    quickOpenResults.innerHTML = '<div class="quick-open-empty">No matching files</div>';
    return;
  }

  quickOpenResults.innerHTML = filteredFiles.slice(0, 50).map((file, index) => `
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

function filterQuickOpenFiles(query) {
  if (!query) {
    filteredFiles = allFiles.slice(0, 50);
  } else {
    filteredFiles = allFiles.filter(f => fuzzyMatch(query, f.relativePath));
  }
  selectedFileIndex = 0;
  renderQuickOpenResults();
}

async function openQuickOpen() {
  if (!currentProject) return;

  quickOpenOverlay.classList.add('active');
  quickOpenInput.value = '';
  quickOpenInput.focus();

  // Collect files if not cached or project changed
  allFiles = await collectAllFiles(currentProject.path);
  filteredFiles = allFiles.slice(0, 50);
  selectedFileIndex = 0;
  renderQuickOpenResults();
}

function closeQuickOpen() {
  quickOpenOverlay.classList.remove('active');
  quickOpenInput.value = '';
}

async function openQuickOpenFile(index) {
  const file = filteredFiles[index];
  if (!file) return;

  closeQuickOpen();
  await previewFile(file.path);
}

quickOpenInput.addEventListener('input', () => {
  filterQuickOpenFiles(quickOpenInput.value);
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

function openGlobalSearch() {
  if (!currentProject) return;

  globalSearchOverlay.classList.add('active');
  globalSearchInput.value = '';
  globalSearchInput.focus();
  globalSearchResultsList = [];
  globalSearchSelectedIndex = 0;
  globalSearchResults.innerHTML = '<div class="global-search-empty">Type to search across all files</div>';
}

function closeGlobalSearch() {
  globalSearchOverlay.classList.remove('active');
  globalSearchInput.value = '';
}

async function doGlobalSearch(query) {
  if (!currentProject || query.length < 2) {
    globalSearchResults.innerHTML = '<div class="global-search-empty">Type at least 2 characters to search</div>';
    return;
  }

  globalSearchResults.innerHTML = '<div class="global-search-loading">Searching...</div>';

  const result = await window.electronAPI.searchProject(currentProject.path, query);

  if (!result.success || result.results.length === 0) {
    globalSearchResults.innerHTML = '<div class="global-search-empty">No results found</div>';
    globalSearchResultsList = [];
    return;
  }

  globalSearchResultsList = result.results;
  globalSearchSelectedIndex = 0;
  renderGlobalSearchResults(query);
}

function renderGlobalSearchResults(query) {
  const queryLower = query.toLowerCase();

  globalSearchResults.innerHTML = globalSearchResultsList.map((r, index) => {
    // Highlight the match in content
    const contentLower = r.content.toLowerCase();
    const matchIndex = contentLower.indexOf(queryLower);
    let highlightedContent = escapeHtml(r.content);

    if (matchIndex !== -1) {
      const before = escapeHtml(r.content.substring(0, matchIndex));
      const match = escapeHtml(r.content.substring(matchIndex, matchIndex + query.length));
      const after = escapeHtml(r.content.substring(matchIndex + query.length));
      highlightedContent = `${before}<mark>${match}</mark>${after}`;
    }

    return `
      <div class="global-search-result ${index === globalSearchSelectedIndex ? 'selected' : ''}" data-index="${index}">
        <div class="global-search-result-header">
          <span class="global-search-filename">${r.fileName}</span>
          <span class="global-search-path">${r.relativePath}</span>
          <span class="global-search-line">:${r.line}</span>
        </div>
        <div class="global-search-content">${highlightedContent}</div>
      </div>
    `;
  }).join('');

  // Add click handlers
  globalSearchResults.querySelectorAll('.global-search-result').forEach(item => {
    item.addEventListener('click', () => {
      const index = parseInt(item.dataset.index);
      openGlobalSearchResult(index);
    });
  });
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
    renderGlobalSearchResults(globalSearchInput.value);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    globalSearchSelectedIndex = Math.max(globalSearchSelectedIndex - 1, 0);
    renderGlobalSearchResults(globalSearchInput.value);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    openGlobalSearchResult(globalSearchSelectedIndex);
  } else if (e.key === 'Escape') {
    closeGlobalSearch();
  }
});

globalSearchOverlay.addEventListener('click', (e) => {
  if (e.target === globalSearchOverlay) closeGlobalSearch();
});

// ===== Keyboard Shortcuts =====
document.addEventListener('keydown', (e) => {
  // Tab switching
  if ((e.metaKey || e.ctrlKey) && ['1', '2', '3', '4'].includes(e.key)) {
    e.preventDefault();
    const tabs = ['preview', 'files', 'git', 'notes'];
    const tab = document.querySelector(`[data-tab="${tabs[parseInt(e.key) - 1]}"]`);
    if (tab) tab.click();
  }

  // New terminal: Cmd+T
  if ((e.metaKey || e.ctrlKey) && e.key === 't') {
    e.preventDefault();
    if (currentProject) {
      createNewTab(currentProject.path, currentProject.path);
    }
  }

  // Close terminal: Cmd+W
  if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
    if (currentProject && projectData.has(currentProject.path)) {
      const data = projectData.get(currentProject.path);
      if (data.tabs.length > 1) {
        e.preventDefault();
        closeTab(data.activeTabIndex);
      }
    }
  }

  // Terminal search: Cmd+F
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault();
    openTerminalSearch();
  }

  // Quick file open: Cmd+P
  if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
    e.preventDefault();
    openQuickOpen();
  }

  // Global search: Cmd+Shift+F
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'f') {
    e.preventDefault();
    openGlobalSearch();
  }

  // Split terminal: Cmd+\
  if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
    e.preventDefault();
    splitTerminal();
  }
});

// ===== Project Settings =====
const settingsOverlay = document.getElementById('settings-overlay');
const settingsTitle = document.getElementById('settings-title');
const settingsName = document.getElementById('settings-name');
const settingsShell = document.getElementById('settings-shell');
const settingsEnv = document.getElementById('settings-env');
const settingsStartup = document.getElementById('settings-startup');
let editingProjectPath = null;

const PROJECT_SETTINGS_KEY = 'programming-interface-project-settings';

function getProjectSettings(projectPath) {
  const allSettings = JSON.parse(localStorage.getItem(PROJECT_SETTINGS_KEY) || '{}');
  return allSettings[projectPath] || {};
}

function saveProjectSettings(projectPath, settings) {
  const allSettings = JSON.parse(localStorage.getItem(PROJECT_SETTINGS_KEY) || '{}');
  allSettings[projectPath] = settings;
  localStorage.setItem(PROJECT_SETTINGS_KEY, JSON.stringify(allSettings));
}

function deleteProjectSettings(projectPath) {
  const allSettings = JSON.parse(localStorage.getItem(PROJECT_SETTINGS_KEY) || '{}');
  delete allSettings[projectPath];
  localStorage.setItem(PROJECT_SETTINGS_KEY, JSON.stringify(allSettings));
}

function openProjectSettings(projectPath) {
  editingProjectPath = projectPath;
  const projects = getProjects();
  const project = projects.find(p => p.path === projectPath);
  const settings = getProjectSettings(projectPath);

  settingsTitle.textContent = `Settings: ${project?.name || 'Project'}`;
  settingsName.value = project?.name || '';
  settingsShell.value = settings.shell || '';
  settingsEnv.value = settings.env || '';
  settingsStartup.value = settings.startup || '';

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
    startup: settingsStartup.value
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

    // Clean up settings and notes
    deleteProjectSettings(editingProjectPath);
    localStorage.removeItem(getProjectNotesKey(editingProjectPath));

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

// ===== Session Restore =====
const SESSION_KEY = 'programming-interface-session';

function saveSession() {
  if (!currentProject) return;

  const session = {
    activeProject: currentProject.path,
    openTerminals: {}
  };

  // Save terminal tab info for each project
  for (const [projectPath, data] of projectData) {
    session.openTerminals[projectPath] = {
      tabCount: data.tabs.length,
      activeTabIndex: data.activeTabIndex,
      tabNames: data.tabs.map(t => t.name)
    };
  }

  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

async function restoreSession() {
  const sessionData = localStorage.getItem(SESSION_KEY);
  if (!sessionData) return;

  try {
    const session = JSON.parse(sessionData);
    const projects = getProjects();

    // Find and select the active project
    if (session.activeProject) {
      const project = projects.find(p => p.path === session.activeProject);
      if (project) {
        // Restore the project
        selectProject(project);
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

// Restore session on load
setTimeout(restoreSession, 100);

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

console.log('Programming Interface loaded');
