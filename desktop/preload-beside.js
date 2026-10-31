// Preload for Beside's bar -- the one row of shell UI over the docked chat.
//
// Its own file for the reason preload-roam.js is: this view is shell UI, but
// a different piece of it, and nothing else the shell can do belongs within
// reach of it. It is only ever attached to renderer/beside/index.html, and
// main checks the sender as well. The chat itself is a web page and gets
// preload.js with a web page's stripped capabilities, like any Wilds tab.

const { contextBridge, ipcRenderer } = require("electron");

const call = (action, payload) => ipcRenderer.invoke("roost:beside", action, payload);

contextBridge.exposeInMainWorld("roostBeside", {
  state: () => call("state"),
  share: () => call("share"),
  close: () => call("close"),
  chat: (id) => call("chat", { id }),
  width: (delta) => call("width", { delta }),
  reload: () => call("reload"),
  onState: (fn) => {
    const h = (_e, s) => fn(s);
    ipcRenderer.on("beside-state", h);
    return () => ipcRenderer.removeListener("beside-state", h);
  },
});
