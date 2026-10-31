// Drafts — letters and emails from templates, written out by Kenoma.
//
// The trivial half of HR writing is the same ten messages with different
// names in them: a leave decision, a policy reminder, a schedule change, a
// meeting recap, a note for the file. This app holds those as templates,
// takes the facts as a short form, and hands the pair to Kenoma (the coding
// agent, used here as a writer) to produce the finished text. When Kenoma is
// down or busy the plain template is filled in instead, so a draft is never
// nothing. Nothing is sent from here: the draft is copied into your mail.
//
// Zero dependencies: Node 22 built-ins only. Run: node server.js
// (DRAFTS_PORT overrides 8815; KENOMA_URL overrides http://127.0.0.1:8890).
// The shell sniffs the port from the first stdout line, so that line is
// printed before anything else and is exactly the URL.
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const HERE = __dirname;
const PORT = Number(process.env.DRAFTS_PORT) || 8815;
const KENOMA = (process.env.KENOMA_URL || "http://127.0.0.1:8890").replace(/\/$/, "");
const DATA = path.join(HERE, "data");
const HISTORY = path.join(DATA, "drafts.jsonl");
const KEEP = 200;
const KENOMA_TIMEOUT_MS = 120_000;
fs.mkdirSync(DATA, { recursive: true });

// ------------------------------------------------------------- templates
// Each template: the facts it needs (the form), and a plain skeleton that
// stands in when there is no model. `{key}` in a skeleton is a field.
const TEMPLATES = [
  {
    id: "leave-response", name: "Leave or PTO decision", group: "People",
    fields: [
      { key: "employee", label: "Employee", hint: "first name is enough" },
      { key: "dates", label: "Dates requested", hint: "Nov 12–14" },
      { key: "decision", label: "Decision", hint: "approved / not approved / need more information", kind: "choice", options: ["approved", "not approved", "need more information"] },
      { key: "reason", label: "Reason or condition", hint: "coverage confirmed · need the form by Friday" },
      { key: "coverage", label: "Coverage note", hint: "who covers, or leave blank", optional: true },
    ],
    skeleton: "Hi {employee},\n\nThanks for your leave request for {dates}. It is {decision}. {reason}\n\n{coverage}\n\nLet me know if anything changes.\n\nThanks,\n",
  },
  {
    id: "policy-reminder", name: "Policy or deadline reminder", group: "Team",
    fields: [
      { key: "audience", label: "To", hint: "all staff · night shift · managers" },
      { key: "policy", label: "Policy or requirement", hint: "annual compliance training" },
      { key: "deadline", label: "Deadline", hint: "Friday Nov 20" },
      { key: "action", label: "What to do", hint: "complete the module in the LMS" },
      { key: "where", label: "Where to find it or get help", hint: "link or person", optional: true },
    ],
    skeleton: "Hello {audience},\n\nA reminder that {policy} is due by {deadline}. Please {action}.\n\n{where}\n\nThank you for taking care of this.\n",
  },
  {
    id: "schedule-change", name: "Schedule or shift change notice", group: "Team",
    fields: [
      { key: "audience", label: "To", hint: "Med-Surg day shift" },
      { key: "change", label: "What changes", hint: "shift start moves to 6:45" },
      { key: "effective", label: "Effective", hint: "Monday Dec 1" },
      { key: "why", label: "Why", hint: "one line", optional: true },
      { key: "contact", label: "Questions go to", hint: "name", optional: true },
    ],
    skeleton: "Hello {audience},\n\nStarting {effective}, {change}. {why}\n\nQuestions: {contact}.\n\nThank you,\n",
  },
  {
    id: "meeting-recap", name: "Meeting recap with actions", group: "Writing",
    fields: [
      { key: "meeting", label: "Meeting", hint: "staffing huddle, Nov 3" },
      { key: "attendees", label: "Who was there", hint: "names or roles", optional: true },
      { key: "decisions", label: "Decisions", hint: "one per line", kind: "multi" },
      { key: "actions", label: "Action items", hint: "who · what · by when, one per line", kind: "multi" },
      { key: "next", label: "Next meeting", hint: "date or blank", optional: true },
    ],
    skeleton: "Recap: {meeting}\nAttendees: {attendees}\n\nDecisions:\n{decisions}\n\nAction items:\n{actions}\n\nNext meeting: {next}\n",
  },
  {
    id: "performance-note", name: "Performance conversation note (for the file)", group: "People",
    fields: [
      { key: "employee", label: "Employee", hint: "name" },
      { key: "date", label: "Date of conversation", hint: "Nov 3" },
      { key: "concern", label: "Concern", hint: "late three times in two weeks" },
      { key: "discussed", label: "What was discussed", hint: "facts only", kind: "multi" },
      { key: "expectations", label: "Expectations going forward", hint: "", kind: "multi" },
      { key: "followup", label: "Follow-up date", hint: "Dec 1", optional: true },
    ],
    skeleton: "Performance conversation note\nEmployee: {employee}\nDate: {date}\n\nConcern: {concern}\n\nDiscussed:\n{discussed}\n\nExpectations:\n{expectations}\n\nFollow-up: {followup}\n",
    tone: "neutral",
  },
  {
    id: "welcome", name: "Welcome / first-day note", group: "People",
    fields: [
      { key: "name", label: "New hire", hint: "first name" },
      { key: "role", label: "Role and unit", hint: "RN, 4 West" },
      { key: "start", label: "Start date and time", hint: "Monday Nov 17, 8:00" },
      { key: "details", label: "First-day details", hint: "where to park, who to ask for, what to bring", kind: "multi" },
    ],
    skeleton: "Hi {name},\n\nWelcome! We're glad you're joining us as {role}. Your first day is {start}.\n\n{details}\n\nSee you then,\n",
  },
  {
    id: "incident-ack", name: "Acknowledge a complaint or report", group: "People",
    fields: [
      { key: "reporter", label: "To", hint: "name" },
      { key: "received", label: "Received on", hint: "date" },
      { key: "about", label: "What was reported", hint: "one neutral line" },
      { key: "next", label: "Next steps", hint: "who will review, by when", kind: "multi" },
    ],
    skeleton: "Hi {reporter},\n\nThank you for bringing this to us on {received}. I've received your report regarding {about}.\n\nNext steps:\n{next}\n\nThis will be handled confidentially, and I'll keep you informed.\n\nRegards,\n",
    tone: "neutral",
  },
  {
    id: "benefits-reminder", name: "Benefits / open enrollment reminder", group: "Team",
    fields: [
      { key: "audience", label: "To", hint: "all benefits-eligible staff" },
      { key: "event", label: "What", hint: "open enrollment" },
      { key: "window", label: "Window", hint: "Nov 1–15" },
      { key: "action", label: "What to do", hint: "review elections in the portal" },
      { key: "help", label: "Help", hint: "sessions, contact", optional: true },
    ],
    skeleton: "Hello {audience},\n\n{event} runs {window}. Please {action} before it closes.\n\n{help}\n\nThank you,\n",
  },
  {
    id: "announcement", name: "Announcement", group: "Team",
    fields: [
      { key: "audience", label: "To", hint: "everyone" },
      { key: "news", label: "The news", hint: "one or two lines", kind: "multi" },
      { key: "effective", label: "Effective", hint: "date", optional: true },
      { key: "why", label: "Why it matters", hint: "", optional: true },
      { key: "contact", label: "Questions go to", hint: "", optional: true },
    ],
    skeleton: "Hello {audience},\n\n{news}\n\nEffective: {effective}\n{why}\n\nQuestions: {contact}\n",
  },
  {
    id: "general-reply", name: "Reply to a message", group: "Writing",
    fields: [
      { key: "to", label: "To", hint: "name" },
      { key: "gist", label: "What they said", hint: "paste or summarise", kind: "multi" },
      { key: "say", label: "What you want to say", hint: "the answer, in your words", kind: "multi" },
      { key: "include", label: "Also include", hint: "", optional: true },
    ],
    skeleton: "Hi {to},\n\n{say}\n\n{include}\n\nThanks,\n",
  },
];
const byId = new Map(TEMPLATES.map((t) => [t.id, t]));
const TONES = ["warm", "neutral", "firm"];
const LENGTHS = ["short", "standard"];

// ------------------------------------------------------------- composing
function fill(skeleton, fields) {
  return skeleton
    .replace(/\{(\w+)\}/g, (_, k) => String(fields[k] || "").trim())
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim() + "\n";
}

function prompt(t, fields, tone, length) {
  const facts = t.fields
    .map((f) => `${f.label}: ${String(fields[f.key] || "").trim() || "(not given)"}`)
    .join("\n");
  return [
    "You are drafting a workplace message for an HR professional at a healthcare organization.",
    "Reply with the finished text ONLY: no preamble, no explanation, no markdown headings or code fences, no sign-off name (end with a comma on the closing line).",
    "Do not use any tools, read or write any files, or run anything. This is writing, not coding.",
    `Template: ${t.name}.`,
    `Tone: ${tone}. Length: ${length}. Plain, specific, human. No corporate filler, no exclamation marks, no emoji.`,
    "Use only the facts below; if a fact is not given, leave it out rather than inventing it.",
    "",
    "FACTS",
    facts,
    "",
    "A plain version to improve on (keep its structure):",
    fill(t.skeleton, fields),
  ].join("\n");
}

// Kenoma's /chat streams server-sent events; the text of the answer is the
// `text` events joined. One run per session: a 409 means it is busy with a
// turn, and the plain template answers instead.
async function askKenoma(text, signal) {
  const res = await fetch(`${KENOMA}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "drafts", prompt: text, interactive: false, client: "drafts" }),
    signal,
  });
  if (res.status === 409) throw new Error("Kenoma is busy with another turn");
  if (!res.ok) throw new Error(`Kenoma ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === "text") out += ev.text ?? ev.delta ?? ev.content ?? "";
      if (ev.type === "error") throw new Error(ev.message || ev.error || "Kenoma error");
      if (ev.type === "done") { try { reader.cancel(); } catch {} return out; }
    }
  }
  return out;
}

function tidy(text) {
  return String(text || "")
    .replace(/^```[a-z]*\n?|\n?```$/g, "")
    .replace(/^\s*(here(?:'s| is) (?:a|the|your) draft[^\n]*\n)/i, "")
    .trim() + "\n";
}

async function kenomaUp() {
  try {
    const r = await fetch(`${KENOMA}/sessions`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

// --------------------------------------------------------------- history
function history() {
  let text = "";
  try { text = fs.readFileSync(HISTORY, "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch {} }
  return out.slice(-KEEP).reverse();
}
function remember(d) {
  fs.appendFileSync(HISTORY, JSON.stringify(d) + "\n");
  const all = history();
  if (all.length >= KEEP) fs.writeFileSync(HISTORY, all.slice(0, KEEP).reverse().map((x) => JSON.stringify(x)).join("\n") + "\n");
}
function forget(id) {
  const kept = history().filter((d) => d.id !== id).reverse();
  fs.writeFileSync(HISTORY, kept.map((x) => JSON.stringify(x)).join("\n") + (kept.length ? "\n" : ""));
}

// ---------------------------------------------------------------- server
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
async function body(req, limit = 1 << 18) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error("body too large"); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
const str = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, n);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/status") return json(res, 200, { ok: true, port: PORT, kenoma: await kenomaUp(), kenomaUrl: KENOMA, tones: TONES, lengths: LENGTHS });
    if (url.pathname === "/api/templates") return json(res, 200, TEMPLATES.map(({ skeleton, ...t }) => t));
    if (url.pathname === "/api/drafts" && req.method === "GET") return json(res, 200, history());
    if (/^\/api\/drafts\/[a-f0-9]{12}$/.test(url.pathname) && req.method === "DELETE") { forget(url.pathname.split("/").pop()); return json(res, 200, { ok: true }); }
    if (url.pathname === "/api/draft" && req.method === "POST") {
      const b = await body(req);
      const t = byId.get(String(b.templateId || ""));
      if (!t) return json(res, 400, { error: "no such template" });
      const fields = {};
      for (const f of t.fields) fields[f.key] = str((b.fields || {})[f.key], 2000);
      const tone = TONES.includes(b.tone) ? b.tone : (t.tone || "warm");
      const length = LENGTHS.includes(b.length) ? b.length : "standard";
      const plain = fill(t.skeleton, fields);
      let text = plain, via = "template", error = null;
      if (b.model !== false) {
        try {
          const got = tidy(await askKenoma(prompt(t, fields, tone, length), AbortSignal.timeout(KENOMA_TIMEOUT_MS)));
          if (got.trim().length > 20) { text = got; via = "kenoma"; }
          else error = "Kenoma answered with nothing usable; this is the plain template";
        } catch (e) {
          error = `${e.message || e}; this is the plain template`;
        }
      }
      const d = { id: crypto.randomBytes(6).toString("hex"), when: new Date().toISOString(), templateId: t.id, template: t.name,
        title: `${t.name} · ${fields[t.fields[0].key] || ""}`.trim(), fields, tone, length, via, text };
      remember(d);
      return json(res, 200, { ...d, error });
    }
    // Static: the page itself. data/ is never served.
    // /_ifreglen/* is the shared UI kit in apps/_shared (the look of every app).
    let f = url.pathname === "/" ? "/index.html" : url.pathname;
    if (f.startsWith("/data/") || f.includes("..")) { res.writeHead(404); return res.end("no"); }
    const shared = f.startsWith("/_ifreglen/");
    const base = shared ? path.join(HERE, "..", "_shared") : HERE;
    const file = path.join(base, shared ? f.slice("/_ifreglen/".length) : f);
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("no"); }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`http://127.0.0.1:${PORT}`);
  console.log(`[drafts] ${TEMPLATES.length} templates · Kenoma at ${KENOMA}`);
});

module.exports = { TEMPLATES, fill, prompt, tidy };
