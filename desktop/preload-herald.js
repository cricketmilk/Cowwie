// Preload for the herald's view (Auri's cards). Separate from the chrome
// preload so her page carries exactly what it needs: hear the queue, answer a
// card, say how tall it is, give the keyboard back.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("roostHerald", {
  ready: () => ipcRenderer.invoke("roost:herald", "ready"),
  act: (id, action, payload) => ipcRenderer.invoke("roost:herald", "act", { id, action, payload }),
  // The page measures its column and asks for that much view; main.js pins
  // it to the app area's top-right corner. Zero hides it.
  bounds: (h, w) => ipcRenderer.invoke("roost:herald", "bounds", { h, w }),
  release: () => ipcRenderer.invoke("roost:herald", "release"),
  // The drawer's verbs: ask Kenoma.
  verb: (verb, payload) => ipcRenderer.invoke("roost:herald", "verb", { verb, payload }),
  on: (channel, fn) => {
    // A channel missing from this array is dropped SILENTLY, same rule as
    // preload-chrome.js.
    const allowed = ["herald", "herald-focus"];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
