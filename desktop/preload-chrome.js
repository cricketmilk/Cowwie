// Preload for the shell's own toolbar. Separate from the app preload so the
// toolbar's privileges never leak into a hosted page.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("roostChrome", {
  apps: () => ipcRenderer.invoke("roost:apps"),
  activate: (id) => ipcRenderer.invoke("roost:activate", id),
  reload: (id) => ipcRenderer.invoke("roost:reload", id),
  toggleWatch: (id) => ipcRenderer.invoke("roost:toggle-watch", id),
  devtools: (id) => ipcRenderer.invoke("roost:devtools", id),
  stop: (id) => ipcRenderer.invoke("roost:stop", id),
  restart: (id) => ipcRenderer.invoke("roost:restart", id),
  logs: (id) => ipcRenderer.invoke("roost:logs", id),
  nav: (id, dir) => ipcRenderer.invoke("roost:nav", { id, dir }),
  zoom: (id, dir) => ipcRenderer.invoke("roost:zoom", { id, dir }),
  find: (id, action, text) => ipcRenderer.invoke("roost:find", { id, action, text }),
  closeView: (id) => ipcRenderer.invoke("roost:close-view", id),
  metrics: () => ipcRenderer.invoke("roost:metrics"),
  rail: (mode) => ipcRenderer.invoke("roost:rail", mode),
  autoRest: (mins) => ipcRenderer.invoke("roost:auto-rest", mins),
  clipAdd: (item) => ipcRenderer.invoke("roost:clip-add", item),
  clipPeek: (url) => ipcRenderer.invoke("roost:clip-peek", url),
  clipCharacters: () => ipcRenderer.invoke("roost:clip-characters"),
  clipVerify: () => ipcRenderer.invoke("roost:clip-verify"),
  forge: (action, payload) => ipcRenderer.invoke("roost:forge", action, payload),
  // Beside, the chat docked down the right: share / open / close / toggle.
  beside: (action, payload) => ipcRenderer.invoke("roost:beside", action, payload),
  // Restart the shell (status, relaunch).
  update: (action, payload) => ipcRenderer.invoke("roost:update", action, payload),
  // The rail talks to The Wilds for one thing only: the palette doubling as
  // an address bar. Same channel the browser's own bar uses.
  roam: (action, payload) => ipcRenderer.invoke("roost:roam", action, payload),
  // The coding handoff: pack a cartridge into the chat you have open, and
  // carry a model's reply back through the Forge.
  cartridge: (action, payload) => ipcRenderer.invoke("roost:cartridge", action, payload),
  openExternal: (id) => ipcRenderer.invoke("roost:open-external", id),
  copyUrl: (id) => ipcRenderer.invoke("roost:copy-url", id),
  overlay: (open) => ipcRenderer.invoke("roost:overlay", open),
  pickFolder: () => ipcRenderer.invoke("roost:pick-folder"),
  scan: (dir, persona) => ipcRenderer.invoke("roost:scan", { dir, persona }),
  addApps: (entries) => ipcRenderer.invoke("roost:add-apps", entries),
  pickManifest: () => ipcRenderer.invoke("roost:pick-manifest"),
  importManifest: (file, replace) => ipcRenderer.invoke("roost:import-manifest", { file, replace }),
  absorb: (dir, options) => ipcRenderer.invoke("roost:absorb", { dir, options }),
  on: (channel, fn) => {
    const allowed = [
      "active", "app-status", "app-error", "app-log",
      "watch-state", "palette", "apps-changed", "nav-state", "zoom",
      "find-open", "find-result", "logs-open",
      // A channel missing from this array is dropped SILENTLY — no error
      // anywhere. Every new push channel must land here.
      "clip-open", "clip-stats", "update",
      "forge-preview", "forge-applied",
    ];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
