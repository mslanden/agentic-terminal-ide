(() => {
  // src/renderer/panel-window.js
  var params = new URLSearchParams(window.location.search);
  var panelType = params.get("panel") || "preview";
  var titleEl = document.getElementById("panel-title");
  var contentEl = document.getElementById("panel-content");
  var titles = {
    preview: "Preview",
    files: "Files",
    git: "Git",
    notes: "Notes"
  };
  titleEl.textContent = titles[panelType] || "Panel";
  document.title = titles[panelType] || "Panel";
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme || "light");
  }
  window.electronAPI.onPanelStateUpdate(({ panelType: type, data }) => {
    if (type !== panelType) return;
    if (data.theme) {
      applyTheme(data.theme);
    }
    if (data.html) {
      contentEl.innerHTML = data.html;
      attachPanelListeners();
    }
    if (panelType === "notes" && data.notesContent !== void 0) {
      let textarea = contentEl.querySelector(".panel-notes-editor");
      if (!textarea) {
        contentEl.innerHTML = `<div style="padding: 12px; flex: 1; display: flex; flex-direction: column;">
        <textarea class="panel-notes-editor notes-editor" style="flex: 1; width: 100%;" placeholder="Notes..."></textarea>
      </div>`;
        textarea = contentEl.querySelector(".panel-notes-editor");
        textarea.addEventListener("input", () => {
          window.electronAPI.sendPanelAction(panelType, "notes-update", { content: textarea.value });
        });
      }
      if (textarea.value !== data.notesContent) {
        textarea.value = data.notesContent;
      }
    }
  });
  function attachPanelListeners() {
    if (panelType === "files") {
      contentEl.querySelectorAll(".file-item").forEach((item) => {
        item.addEventListener("click", () => {
          const filePath = item.dataset.path;
          const isDir = item.classList.contains("folder");
          window.electronAPI.sendPanelAction(panelType, isDir ? "toggle-folder" : "open-file", { path: filePath });
        });
      });
    }
  }
  window.electronAPI.requestPanelState(panelType);
})();
