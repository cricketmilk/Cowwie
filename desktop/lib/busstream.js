// The bus, heard from outside the window.
//
// The shell's bus (main.js busPublish) reached the views with the `bus`
// capability, and Müt, and nothing else. A process that wanted to hear it had
// no way in: the Brain heard the bus only through brain-bridge, a script in
// ITS TILE's renderer, so its nervous system went deaf whenever the tile was
// closed, hibernated or never opened -- and, hidden behind another app, it
// was down to one pump a minute.
//
// GET /bus/stream, on Müt sync's loopback listener (lib/mutsync.js), is the
// way in. Server-Sent Events: one `bus` event per message, each with an id.
//
//   ?topics=haruspex.*,brain.request   only these (a trailing * is a prefix);
//                                      all of them when absent
//   ?me=brain                          not the subscriber's own publishes --
//                                      an echo is a loop waiting to happen
//   Last-Event-ID / ?since=N           what was missed since N, out of a ring
//                                      of the last few hundred, then live
//
// The first event is `hello` {seq, boot}: where the stream is now, and which
// run of the shell this is. A client that sees a different `boot` than it
// last did is talking to a restarted shell, whose ids started again at 1;
// it should take `seq` as its cursor rather than compare.
//
// Publishing the other way is POST /bus. Both answer to this machine only,
// with Müt sync's key.
const crypto = require("node:crypto");

function createBusStream({ max = 500, heartbeatMs = 25000, maxClients = 16, maxBuffered = 1 << 20 } = {}) {
  const ring = [];
  const clients = new Set();
  const boot = crypto.randomBytes(4).toString("hex");
  let seq = 0;

  const frame = (ev) => `id: ${ev.seq}\nevent: bus\ndata: ${JSON.stringify(ev)}\n\n`;
  const wants = (filters, me, ev) =>
    !(me && ev.from === me) &&
    (!filters.length || filters.some((f) => f === "*" || f === ev.topic || (f.endsWith("*") && ev.topic.startsWith(f.slice(0, -1)))));

  function push(msg) {
    const ev = { seq: ++seq, topic: String(msg.topic), payload: msg.payload ?? null, from: msg.from || "shell", t: msg.t || Date.now() };
    ring.push(ev);
    if (ring.length > max) ring.splice(0, ring.length - max);
    for (const c of clients) if (c.wants(ev)) c.write(frame(ev));
    return ev;
  }

  function handle(req, res, url) {
    if (clients.size >= maxClients) {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "too many listeners on the bus" }));
    }
    const filters = (url.searchParams.get("topics") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const me = url.searchParams.get("me") || null;
    const raw = req.headers["last-event-id"] != null ? req.headers["last-event-id"] : url.searchParams.get("since");
    let since = raw != null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
    // A cursor from a previous run of the shell is ahead of this one: what it
    // missed is everything this run has said.
    if (since != null && since > seq) since = 0;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const c = {
      wants: (ev) => wants(filters, me, ev),
      // A listener that stops reading is dropped rather than buffered for:
      // the shell's memory is not a queue for somebody else's stalled socket.
      write: (s) => {
        if (res.writableEnded || res.destroyed) return;
        if (res.writableLength > maxBuffered) { done(); try { res.destroy(); } catch {} return; }
        try { res.write(s); } catch {}
      },
    };
    c.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ seq, boot })}\n\n`);
    if (since != null) for (const ev of ring) if (ev.seq > since && c.wants(ev)) c.write(frame(ev));
    clients.add(c);
    const hb = setInterval(() => c.write(`: ${Date.now()}\n\n`), heartbeatMs);
    if (hb.unref) hb.unref();
    let closed = false;
    function done() { if (closed) return; closed = true; clearInterval(hb); clients.delete(c); }
    req.on("close", done);
    res.on("close", done);
    res.on("error", done);
  }

  return { push, handle, boot, seq: () => seq, listeners: () => clients.size };
}

module.exports = { createBusStream };
