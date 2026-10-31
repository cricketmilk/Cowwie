// Preload for The Wilds' own bar — the tab strip and address field.
//
// Separate from preload-chrome.js for the same reason that one is separate
// from preload.js: this view is shell UI, but it is a DIFFERENT piece of shell
// UI, and the rail's surface (registry writes, the Forge) has no business
// being reachable from the browser's address bar.
//
// Nothing here is capability-gated. This preload is only ever attached to a
// view the shell loads from its own renderer/roam folder; a web page never
// gets it. The tab views themselves get preload.js with the tab's own (heavily
// stripped) capabilities, exactly like any external app.

const { contextBridge, ipcRenderer } = require("electron");

const call = (action, payload) => ipcRenderer.invoke("roost:roam", action, payload);

contextBridge.exposeInMainWorld("roostRoam", {
  // Everything the bar can do is one multiplexed channel. A dozen named
  // handlers for one small surface is a dozen things to keep in sync.
  state: () => call("state"),
  open: (input, opts) => call("open", { input, ...(opts || {}) }),
  newTab: (persona) => call("newtab", { persona }),
  select: (tabId) => call("select", { tabId }),
  close: (tabId) => call("close", { tabId }),
  reopen: () => call("reopen"),
  move: (tabId, index) => call("move", { tabId, index }),
  // Grow this view over the page before drawing anything taller than the bar,
  // and shrink it back after. A dropdown that skips this is simply invisible —
  // a view cannot paint outside its own bounds. See main.js's roamExpand.
  expand: (open) => call("expand", { open }),
  nav: (dir) => call("nav", { dir }),          // back | forward | reload | stop | home
  persona: (name, opts) => call("persona", { name, ...(opts || {}) }),
  suggest: (query) => call("suggest", { query }),
  pin: (url, title) => call("pin", { url, title }),
  unpin: (url) => call("unpin", { url }),
  forget: (what) => call("forget", what || {}),
  copyUrl: () => call("copy-url"),
  system: () => call("system"),                 // hand the current page to the OS browser
  devtools: () => call("devtools"),
  find: (action, text) => call("find", { action, text }),
  zoom: (dir) => call("zoom", { dir }),
  clip: (what) => call("clip", { what }),       // page | image — into the Trove
  // Research leads: which container new clips are filed into, from the bar.
  // The bar never touches the file itself — no fs here, by design.
  lead: (id) => call("lead", { id: id || null }), // null switches the routing off
  leadNew: (name) => call("lead-new", { name }),

  on: (channel, fn) => {
    // A channel missing from this list is dropped silently, same trap as the
    // rail's preload. Every new push from main must be named here.
    const allowed = ["roam", "roam-find", "roam-focus", "roam-collapse"];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
