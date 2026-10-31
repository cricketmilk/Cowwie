// Preload for hosted apps.
//
// Runs before page scripts on EVERY navigation — that's the property that
// makes this shell worth having over browser tabs. No re-pasting, no
// extension install, no page cooperation required.
//
// Capabilities come from additionalArguments set by the main process, so a
// page cannot grant itself anything by editing its own JavaScript.

const { contextBridge, ipcRenderer } = require("electron");

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--roost-${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : "";
};

const APP = arg("app");
const CAPS = arg("caps").split(",").filter(Boolean);
const has = (c) => CAPS.includes(c);

const api = { app: APP, capabilities: CAPS };

if (has("store")) {
  api.store = {
    get: (key) => ipcRenderer.invoke("roost:store", { app: APP, caps: CAPS.join(","), op: "get", key }),
    set: (key, value) => ipcRenderer.invoke("roost:store", { app: APP, caps: CAPS.join(","), op: "set", key, value }),
    delete: (key) => ipcRenderer.invoke("roost:store", { app: APP, caps: CAPS.join(","), op: "delete", key }),
    list: () => ipcRenderer.invoke("roost:store", { app: APP, caps: CAPS.join(","), op: "list" }),
  };
}

if (has("fs")) {
  // Confined to this app's own folder by the main process. Paths are relative
  // to that root; anything resolving outside it is rejected there, not here —
  // a check in the renderer would be advisory only.
  const call = (op, extra = {}) => ipcRenderer.invoke("roost:fs", { app: APP, op, ...extra });
  api.fs = {
    root: () => call("root"),
    list: (path = ".") => call("list", { path }),
    read: (path, encoding) => call("read", { path, encoding }),
    write: (path, data) => call("write", { path, data }),
    append: (path, data) => call("append", { path, data }),
    stat: (path) => call("stat", { path }),
    remove: (path) => call("remove", { path }),
  };
}

if (has("apps")) {
  // Launcher surface: see and open other registered apps. The main process
  // re-checks this capability against the registry on every call, so a page
  // cannot forge its way in by invoking the channel directly.
  api.apps = {
    list: () => ipcRenderer.invoke("roost:apps-list", { app: APP }),
    open: (id) => ipcRenderer.invoke("roost:apps-open", { app: APP, id }),
    stop: (id) => ipcRenderer.invoke("roost:apps-stop", { app: APP, id }),
    restart: (id) => ipcRenderer.invoke("roost:apps-restart", { app: APP, id }),
    // Hibernate an open view — frees its renderer process; persona survives.
    close: (id) => ipcRenderer.invoke("roost:apps-close", { app: APP, id }),
    // Resolve a QR template for a downloadable app. The main process fills
    // in {lan} (desktop LAN address), {port} and {token} (the phone bridge).
    qr: (template) => ipcRenderer.invoke("roost:app-qr", { app: APP, template }),
  };
}

if (has("bus")) {
  // Publish/subscribe between apps, plus the shell's own system events
  // (app.started, app.exited, …). Gated in the main process per call;
  // external apps never see this surface at all. Publishing `briefs.file`
  // with {title, body?, level?, url?, when?} files a brief for the phone
  // (lib/briefs.js); the shell fills in `source` from the publishing app.
  const handlers = new Set();
  ipcRenderer.on("roost:bus-event", (_e, msg) => {
    for (const { topic, fn } of handlers) {
      if (topic === "*" || topic === msg.topic) {
        try { fn(msg); } catch {}
      }
    }
  });
  api.bus = {
    publish: (topic, payload) =>
      ipcRenderer.invoke("roost:bus", { app: APP, topic, payload }),
    subscribe: (topic, fn) => {
      const h = { topic: topic || "*", fn };
      handlers.add(h);
      return () => handlers.delete(h);
    },
  };
}

contextBridge.exposeInMainWorld("roost", api);
