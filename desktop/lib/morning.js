// The morning brief: once a working day, at a time you choose, the desk
// gathers what happened overnight and files ONE brief for the phone and the
// herald, so the first thing on the stand is a summary rather than a pile.
//
// What goes in comes from this machine only: Lookout's findings since the
// last brief, and the notes the phone sent that nobody has looked at. The
// phone already shows its own calendar and follow-ups; this is the desk's
// half of the morning. Nothing here calls a model.
//
// Why a clock in the shell and not a cron: the shell is the one process that
// is up whenever the laptop is, and a brief filed while it was closed would
// have gone nowhere. A day missed (laptop shut until noon) still gets its
// brief at the first tick after the time, once, and never twice.
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT = { time: "07:30", days: [1, 2, 3, 4, 5] };   // Mon..Fri, local time
const TICK_MS = 60 * 1000;
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

function dayKey(d) {
  // Local calendar day as YYYY-MM-DD, so "once a day" means the person's day.
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ""));
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

class Morning {
  /**
   * @param {object} o
   * @param {string} o.dir           the shell's data dir (morning.json lives here)
   * @param {(spec)=>any} o.file     files a brief (main.js briefFile)
   * @param {()=>any[]} o.notes      the notes list (newest first)
   * @param {string} [o.lookoutUrl]  Lookout's base URL
   * @param {()=>Date} [o.now]
   * @param {typeof fetch} [o.fetch]
   */
  constructor({ dir, file, notes, lookoutUrl = "http://127.0.0.1:8812", now = () => new Date(), fetch = globalThis.fetch }) {
    this.path = path.join(dir, "morning.json");
    this.file = file;
    this.notes = notes;
    this.lookoutUrl = lookoutUrl;
    this.now = now;
    this.fetch = fetch;
    this.timer = null;
    this.state = this.load();
  }

  load() {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.path, "utf8")); } catch {}
    const time = parseTime(saved.time) ? saved.time : DEFAULT.time;
    const days = Array.isArray(saved.days) && saved.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      ? saved.days : DEFAULT.days;
    return { time, days, lastRun: typeof saved.lastRun === "string" ? saved.lastRun : null };
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.writeFileSync(this.path, JSON.stringify(this.state, null, 2));
    } catch {}
  }

  /** Change the schedule. Returns the schedule as kept. */
  configure({ time, days } = {}) {
    if (parseTime(time)) this.state.time = time;
    if (Array.isArray(days)) this.state.days = days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    this.save();
    return { time: this.state.time, days: this.state.days };
  }

  /** Whether this tick should file: a scheduled day, past the time, not yet today. */
  due(now = this.now()) {
    if (!this.state.days.includes(now.getDay())) return false;
    const t = parseTime(this.state.time);
    if (now.getHours() < t.h || (now.getHours() === t.h && now.getMinutes() < t.mi)) return false;
    return this.state.lastRun !== dayKey(now);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), TICK_MS);
    this.timer.unref?.();
    this.tick().catch(() => {});
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (!this.due()) return null;
    return this.runNow();
  }

  /** Compose and file today's brief now, scheduled or not. */
  async runNow() {
    const now = this.now();
    const brief = await this.compose(now);
    this.state.lastRun = dayKey(now);
    this.save();
    return this.file(brief);
  }

  async findings(since) {
    try {
      const r = await this.fetch(`${this.lookoutUrl}/api/findings?since=${encodeURIComponent(new Date(since).toISOString())}`,
        { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return null;
      const list = await r.json();
      return Array.isArray(list) ? list : null;
    } catch {
      return null;   // Lookout is asleep; the brief says so rather than guessing
    }
  }

  async compose(now = this.now()) {
    const since = now.getTime() - LOOKBACK_MS;
    const lines = [];

    const found = await this.findings(since);
    if (found === null) {
      lines.push("Lookout is not running, so nothing was watched overnight.");
    } else {
      const fresh = found.filter((f) => !f.acked && new Date(f.when).getTime() >= since);
      if (!fresh.length) lines.push("Lookout: nothing changed on the pages it watches.");
      else {
        const top = [...fresh].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 3);
        lines.push(`Lookout: ${fresh.length} change${fresh.length === 1 ? "" : "s"} overnight. ` +
          top.map((f) => `${f.watch || f.watchId} (${f.score})`).join(", ") + ".");
      }
    }

    const notes = (this.notes() || []).filter((n) => (n.when || 0) >= since);
    if (notes.length) {
      lines.push(`${notes.length} note${notes.length === 1 ? "" : "s"} from the phone: ` +
        notes.slice(0, 3).map((n) => `"${String(n.text).slice(0, 60)}"`).join(" · ") + (notes.length > 3 ? " …" : ""));
    }

    const weekday = now.toLocaleDateString(undefined, { weekday: "long" });
    const urgent = found && found.some((f) => !f.acked && (f.score || 0) >= 70 && new Date(f.when).getTime() >= since);
    return {
      source: "ifreglen",
      title: `Morning brief · ${weekday}`,
      body: lines.join("\n"),
      level: urgent ? "urgent" : "normal",
      url: found && found.length ? "apps/lookout/index.html" : undefined,
      when: now.getTime(),
    };
  }
}

module.exports = { Morning, DEFAULT, dayKey, parseTime };
