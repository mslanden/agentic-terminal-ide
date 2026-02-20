// Panel Window Logic
// Reads ?panel= query param and renders panel-specific content

const params = new URLSearchParams(window.location.search);
const panelType = params.get('panel') || 'preview';

const titleEl = document.getElementById('panel-title');
const contentEl = document.getElementById('panel-content');

// Set title
const titles = {
  preview: 'Preview',
  files: 'Files',
  git: 'Git',
  notes: 'Notes'
};
titleEl.textContent = titles[panelType] || 'Panel';
document.title = titles[panelType] || 'Panel';

// Apply theme from localStorage via state update
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme || 'light');
}

// Listen for state updates from main renderer
window.electronAPI.onPanelStateUpdate(({ panelType: type, data }) => {
  if (type !== panelType) return;

  if (data.theme) {
    applyTheme(data.theme);
  }

  if (data.html) {
    contentEl.innerHTML = data.html;
    attachPanelListeners();
  }

  if (panelType === 'notes' && data.notesContent !== undefined) {
    let textarea = contentEl.querySelector('.panel-notes-editor');
    if (!textarea) {
      contentEl.innerHTML = `<div style="padding: 12px; flex: 1; display: flex; flex-direction: column;">
        <textarea class="panel-notes-editor notes-editor" style="flex: 1; width: 100%;" placeholder="Notes..."></textarea>
      </div>`;
      textarea = contentEl.querySelector('.panel-notes-editor');
      textarea.addEventListener('input', () => {
        window.electronAPI.sendPanelAction(panelType, 'notes-update', { content: textarea.value });
      });
    }
    // Only update if content differs (to avoid cursor jump)
    if (textarea.value !== data.notesContent) {
      textarea.value = data.notesContent;
    }
  }
});

function attachPanelListeners() {
  if (panelType === 'files') {
    contentEl.querySelectorAll('.file-item').forEach(item => {
      item.addEventListener('click', () => {
        const filePath = item.dataset.path;
        const isDir = item.classList.contains('folder');
        window.electronAPI.sendPanelAction(panelType, isDir ? 'toggle-folder' : 'open-file', { path: filePath });
      });
    });
  }
}

// Request initial state on load
window.electronAPI.requestPanelState(panelType);
