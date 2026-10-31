// lib/forge.js -- the main process's door into Kenoma (the coding agent once
// called Forge; Goblin Brain still calls it that, and Kenoma's own MCP server
// answers to "kenoma").
//
// Kenoma is a `kind: local` app whose backend is a plain Node server on
// :8890. The shell's window opens it as an app; this module is what lets Mut
// reach the *same* backend from the rail, without the window ever having
// been opened.
//
// Two lineages met here. camera-sensor gave the shell ownership of Kenoma's
// lifecycle -- PID tracking, a clean restart that kills the old process,
// waits for the port and polls the new one -- plus voice in and speech out.
// The forge branch gave sessions: an ask names its session and goes in as
// `interactive: false`, because nobody is attached to the rail to answer an
// approval, so Kenoma denies it after a short grace and tells the model why
// rather than parking the rail on a question it cannot show. Opening the
// cockpit on the `mut` session shows the same conversation and can answer.

"use strict";

const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

// Where Kenoma lives. main.js exports this from the registry entry at start,
// so the one place a project's folder is written down stays the registry -- a
// lib file reading apps.config.json for itself is the platform/app coupling
// docs/separation.md exists to prevent. The literal is the last resort, for a
// shell whose registry has lost the entry.
const FORGE_DIR = process.env.FORGE_DIR || "C:\\Forge";
// FORGE_PORT moves it for a test. heraldtest.js presses Allow on cards, and
// the herald polls this port for approvals: pointed at the real Kenoma, a test
// could approve a real pending command.
const PORT = Number(process.env.FORGE_PORT) || 8890;
const DEFAULT_SESSION = "mut";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Track the child PID so we can kill it cleanly on restart.
let childPid = null;

// Five seconds, not one: Kenoma blocks its own event loop for seconds at a
// time mid-turn (git checkpoints, sandboxing), and a busy Kenoma read as a
// dead one here meant a second copy spawned that could not get the port, and
// childPid then pointing at that copy instead of the one really serving.
function healthy() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/health", timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function portFree() {
  return new Promise((resolve) => {
    const srv = require("net").createServer();
    srv.once("error", () => resolve(false));
    srv.listen(PORT, "127.0.0.1", () => { srv.close(); resolve(true); });
  });
}

// Kill the old Kenoma process by PID. On Windows uses taskkill /T to reach
// the whole tree; on POSIX uses SIGKILL.
function killChild() {
  if (!childPid) return true;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(childPid), "/T", "/F"], {
        windowsHide: true, stdio: "ignore", timeout: 5000,
      });
    } else {
      try { process.kill(-childPid, "SIGKILL"); } catch { try { process.kill(childPid, "SIGKILL"); } catch {} }
    }
    childPid = null;
    return true;
  } catch {
    childPid = null;
    return true;
  }
}

function spawnKenoma() {
  const child = spawn("node", ["server.js"], {
    cwd: FORGE_DIR,
    shell: true,
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  child.unref();
  childPid = child.pid;
  return child;
}

let spawning = null;
async function ensureForge() {
  if (await healthy()) return true;
  if (!spawning) {
    spawning = (async () => {
      spawnKenoma();
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        if (await healthy()) return true;
      }
      return false;
    })().finally(() => { spawning = null; });
  }
  return spawning;
}

// Clean restart: kill old, wait for port to free, spawn new, wait for ready.
async function restartForge() {
  killChild();

  // Wait for port to be free (up to 5 seconds).
  for (let i = 0; i < 50; i++) {
    if (await portFree()) break;
    await sleep(100);
  }

  // Spawn new Kenoma and wait for it (up to 10 seconds).
  spawnKenoma();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await healthy()) return true;
  }
  return false;
}


// Stream an ask to Forge. Yields the backend's SSE events verbatim:
//   { type: "text" | "thinking" | "tool_start" | "tool_delta" | "tool_end"
//         | "terminal" | "iteration" | "usage" | "approval" | "ask" | "plan"
//         | "policy" | "checkpoint" | "diff" | "receipt" | "compaction" | "job"
//         | "explore" | "retry" | "status" | "error" | "done", ... }
// Every event carries seq, sessionId, turn and ts. The receipt comes before
// done: { filesChanged, commandsRun, testsResult, checkpointId, tokens, cost }.
async function* askForge({ prompt, workspace, signal, sessionId = DEFAULT_SESSION }) {
  const res = await fetch(`http://127.0.0.1:${PORT}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, prompt, interactive: false, client: "mut", ...(workspace ? { workspace } : {}) }),
    signal,
  });
  if (!res.ok) throw new Error(`Kenoma ${res.status}: ${(await res.text().catch(() => ""))}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim();
      if (!d) continue;
      let ev;
      try { ev = JSON.parse(d); } catch { continue; }
      yield ev;
    }
  }
}

// Send an audio buffer for transcription.
async function voiceForge({ audioBuffer, workspace, runTurn = false }) {
  await ensureForge();
  const boundary = "mut" + Date.now().toString(36);
  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="audio"; filename="recording.wav"`,
    `Content-Type: audio/wav`,
    "", "",
  ].join("\r\n");
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([
    Buffer.from(header.slice(0, -2), "utf8"), audioBuffer,
    Buffer.from(footer, "utf8"),
  ]);
  const qs = runTurn ? "?run=true&sessionId=mut" : "?sessionId=mut";
  if (workspace) qs += `&workspace=${encodeURIComponent(workspace)}`;
  const res = await fetch(`http://127.0.0.1:${PORT}/voice${qs}`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body, signal: AbortSignal.timeout(35000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Kenoma voice ${res.status}`);
  }
  return res.json();
}

// Speak text in Müt's cartoony voice.
async function speakForge(text) {
  if (process.platform === "win32") {
    const escaped = text.replace(/"/g, '\\"').replace(/\n/g, " ");
    const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 2
$synth.Volume = 100
$synth.SelectVoiceByHints(1)
$synth.SetOutputToDefaultAudioDevice()
$synth.Speak("${escaped}")
$synth.Dispose()
`;
    spawn("powershell", ["-NoProfile", "-Command", script], {
      windowsHide: true, detached: true, stdio: "ignore",
    }).unref();
  } else if (process.platform === "darwin") {
    spawn("say", ["-v", "Fiona", text], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("espeak", ["-s", "180", "-p", "70", text], { detached: true, stdio: "ignore" }).unref();
  }
  return true;
}

// Stop one session's run. Without an argument the backend aborts every run
// (the shape this always sent), so an old backend still understands it.
async function abort(sessionId = DEFAULT_SESSION) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

// Everything waiting on a person, across every session: approvals and
// questions alike, each with the session it belongs to. The herald polls this
// so an approval raised in the cockpit, or by a phone-started task, shows up
// over whatever app you are in — the same walk mutsync's
// /mut/forge/approvals does for the phone. Resolves [] when Kenoma is down.
async function pending() {
  const get = async (p) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? r.json() : null;
  };
  try {
    const list = ((await get("/sessions")) || {}).sessions || [];
    const out = [];
    for (const s of list) {
      if (s.state !== "waiting_approval" && s.state !== "waiting_user") continue;
      const d = await get(`/sessions/${encodeURIComponent(s.id)}`).catch(() => null);
      for (const p of (d && d.pending) || []) out.push({ ...p, sessionId: s.id });
    }
    return out;
  } catch {
    return [];
  }
}

// Answer one: { decision: "approve" | "deny", remember? } or { answer }.
async function answer(id, body) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...body }),
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true } : { ok: false, error: j.error || `Kenoma said ${r.status}` };
  } catch (e) {
    return { ok: false, error: "Kenoma is not answering" };
  }
}

module.exports = { ensureForge, askForge, voiceForge, speakForge, restartForge, abort, pending, answer, FORGE_DIR, PORT, DEFAULT_SESSION };
