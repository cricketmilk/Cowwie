// Sigils — one hand-drawn mark per registered app, shared by the rail and
// the Sanctum. Every mark follows the same three-voice formula as the shell's
// own eye-in-triad: STRUCTURE in instrument grey, one LIFE stroke in the
// app's accent, one SPARK in candle amber. That formula is what makes eleven
// different drawings read as one set.
//
// Registry `art` (a PNG in lounge/art/) always wins over a sigil on the
// Sanctum's tiles; sigils are the guaranteed-crisp fallback and the rail's
// native glyphs. Unknown ids fall back to a two-letter monogram, so a
// freshly scanned app is never a blank square.
//
// Loaded with a plain <script> tag by both pages; exposes window.roostSigils.

(function () {
  const S = "#79808F"; // structure — instrument grey
  const K = "#D9A15B"; // spark — candle amber

  // Accent per app: desaturated jewel tones tuned to the void-indigo ground.
  const ACCENTS = {
    launcher:          "#7FD6A8",
    "goblin-brain":    "#8FD68F",
    "klamour-kixen":   "#E0955B",
    taptap:            "#6FBFD9",
    demiurgent:        "#9B84C9",
    forge:            "#C98FAD",
    glamoire:          "#C983B9",
    seealiens:         "#8FD1C4",
    findaliens:        "#8FD1C4",
    goblinhouse:       "#D9A15B",
    "feedcap-tiktok":  "#6FD1CF",
    "feedcap-youtube": "#D97B6B",
    gossamyr:          "#A99BD9",
    trove:             "#C9A96E",
    "board-pinterest": "#D97B6B",
    "board-giphy":     "#8FD1C4",
    "board-tenor":     "#6FBFD9",
    _group_boards:     "#C9A96E",
    _group_mentjelly:  "#6FD1CF",
    _default:          "#9B84C9",
  };

  // Each drawing is a 48x48 viewBox. Strokes stay ≥2 so nothing dissolves
  // at rail size; the spark is always a filled shape, never a hairline.
  const MARKS = {
    // The Sanctum — the open eye held in a downward triad. The shell's own mark.
    launcher: (A) => `
      <path d="M24 6 L43 40 L5 40 Z" stroke="${S}" stroke-width="2.4" fill="none" stroke-linejoin="round"/>
      <ellipse cx="24" cy="29" rx="8.6" ry="5.4" stroke="${A}" stroke-width="2.2" fill="none"/>
      <circle cx="24" cy="29" r="2.7" fill="${K}"/>`,

    // Goblin Brain — a dome of thought: convolution waves under the skull arc.
    "goblin-brain": (A) => `
      <path d="M9 30 A15 15 0 1 1 39 30" stroke="${S}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      <path d="M13 25 q3.5 -5 7 0 q3.5 5 7 0 q3.5 -5 7 0" stroke="${A}" stroke-width="2.2" fill="none" stroke-linecap="round"/>
      <path d="M16 31 q4 4.5 8 0 q4 -4.5 8 0" stroke="${A}" stroke-width="2.2" fill="none" stroke-linecap="round" opacity="0.65"/>
      <circle cx="24" cy="39" r="2.6" fill="${K}"/>
      <path d="M19 38.5 h-4 M33 38.5 h-4" stroke="${S}" stroke-width="2" stroke-linecap="round"/>`,

    // Klamour Kixen — the pan and the flame, after its own cover art.
    "klamour-kixen": (A) => `
      <path d="M24 8 C29 15 33 18 33 25 A9 9 0 1 1 15 25 C15 18 19 15 24 8 Z" stroke="${A}" stroke-width="2.3" fill="none" stroke-linejoin="round"/>
      <path d="M10 36 Q24 43 38 36" stroke="${S}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      <path d="M38 36.5 L44 34.5" stroke="${S}" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M24 22 l3 4 -3 4 -3 -4 Z" fill="${K}"/>`,

    // Tap Tap — a room with its doorway, the play mark waiting inside.
    taptap: (A) => `
      <path d="M9 12 H39 V40 H29 M19 40 H9 Z" stroke="${S}" stroke-width="2.4" fill="none" stroke-linejoin="round"/>
      <path d="M20 20 L31 26 L20 32 Z" stroke="${A}" stroke-width="2.2" fill="none" stroke-linejoin="round"/>
      <circle cx="24" cy="40" r="2.4" fill="${K}"/>`,

    // Demiurgent — the soul-crystal: a faceted stone with its priced spark.
    demiurgent: (A) => `
      <path d="M24 5 L37 19 L31 43 H17 L11 19 Z" stroke="${S}" stroke-width="2.4" fill="none" stroke-linejoin="round"/>
      <path d="M24 5 L20 19 L24 43 M24 5 L28 19 L24 43 M11 19 H37" stroke="${A}" stroke-width="1.9" fill="none" stroke-linejoin="round" opacity="0.85"/>
      <circle cx="24" cy="26" r="2.8" fill="${K}"/>`,

    // Glamoire — the hand mirror, catching a spark that isn't the room's.
    glamoire: (A) => `
      <ellipse cx="24" cy="19" rx="11" ry="13" stroke="${S}" stroke-width="2.4" fill="none"/>
      <path d="M24 32 V43 M19 43 H29" stroke="${S}" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M17.5 20 A8 10 0 0 1 21 10.5" stroke="${A}" stroke-width="2.2" fill="none" stroke-linecap="round"/>
      <path d="M30 13 l1.2 2.6 2.6 1.2 -2.6 1.2 -1.2 2.6 -1.2 -2.6 -2.6 -1.2 2.6 -1.2 Z" fill="${K}"/>`,

    // See Aliens — the saucer, mid-visit.
    seealiens: (A) => `
      <path d="M17 20 A8.5 8.5 0 0 1 31 20" stroke="${A}" stroke-width="2.2" fill="none" stroke-linecap="round"/>
      <ellipse cx="24" cy="24" rx="16" ry="6" stroke="${S}" stroke-width="2.4" fill="none"/>
      <circle cx="18" cy="35" r="1.9" fill="${K}"/>
      <circle cx="24" cy="39" r="1.9" fill="${K}" opacity="0.66"/>
      <circle cx="30" cy="35" r="1.9" fill="${K}"/>`,

    // Goblin House — the house that watches back.
    goblinhouse: (A) => `
      <path d="M8 22 L24 7 L40 22 M12 19 V41 H36 V19" stroke="${S}" stroke-width="2.4" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="24" cy="28" r="6" stroke="${A}" stroke-width="2.2" fill="none"/>
      <circle cx="24" cy="28" r="2.2" fill="${K}"/>`,

    // Kenoma — the plush familiar: round face between two long ears, the eyes
    // still glowing from the work, the amber gem holding the cloak at the clasp.
    forge: (A) => `
      <path d="M16 9 L20.5 16.5 Q24 15 27.5 16.5 L32 9 Q36.5 15.5 36.5 23.5 Q36.5 35 24 35 Q11.5 35 11.5 23.5 Q11.5 15.5 16 9 Z" stroke="${A}" stroke-width="2.3" fill="none" stroke-linejoin="round"/>
      <circle cx="18.5" cy="24" r="2.2" fill="${A}"/>
      <circle cx="29.5" cy="24" r="2.2" fill="${A}"/>
      <path d="M9 42.5 Q24 35 39 42.5" stroke="${S}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      <path d="M24 36.2 l2.5 2.7 -2.5 2.7 -2.5 -2.7 Z" fill="${K}"/>`,

    // Ment Jelly · TikTok — the note the feed keeps humming.
    "feedcap-tiktok": (A) => `
      <path d="M28 8 V31" stroke="${A}" stroke-width="2.6" stroke-linecap="round"/>
      <path d="M28 8 c5 1.5 7 4.5 12 5" stroke="${A}" stroke-width="2.6" fill="none" stroke-linecap="round"/>
      <ellipse cx="22" cy="33" rx="6.5" ry="5" stroke="${S}" stroke-width="2.4" fill="none"/>
      <circle cx="40" cy="17" r="2.2" fill="${K}"/>`,

    // Ment Jelly · YouTube — the screen and its play mark.
    "feedcap-youtube": (A) => `
      <rect x="7" y="13" width="34" height="23" rx="6.5" stroke="${S}" stroke-width="2.4" fill="none"/>
      <path d="M20.5 19.5 L30 24.5 L20.5 29.5 Z" stroke="${A}" stroke-width="2.2" fill="none" stroke-linejoin="round"/>
      <circle cx="24" cy="41" r="2.2" fill="${K}"/>`,

    // Ment Jelly (the group itself) — the jellyfish drifting through feeds.
    _group_mentjelly: (A) => `
      <path d="M11 23 A13 13 0 0 1 37 23 q0 3 -13 3 t-13 -3 Z" stroke="${S}" stroke-width="2.4" fill="none" stroke-linejoin="round"/>
      <path d="M16 28 q-1.5 6 1 12 M24 28 q1.5 6 -1 13 M32 28 q1.5 5 -1 11" stroke="${A}" stroke-width="2.1" fill="none" stroke-linecap="round"/>
      <circle cx="24" cy="18" r="2.4" fill="${K}"/>`,

    // The Trove — a reliquary chest, lid ajar, one spark kept inside.
    trove: (A) => `
      <path d="M8 20 h32 v20 a2 2 0 0 1 -2 2 H10 a2 2 0 0 1 -2 -2 Z" stroke="${S}" stroke-width="2.4" fill="none" stroke-linejoin="round"/>
      <path d="M9.5 19 L14 9 h20 l4.5 10" stroke="${A}" stroke-width="2.2" fill="none" stroke-linejoin="round"/>
      <path d="M8 26 h32" stroke="${S}" stroke-width="1.8"/>
      <circle cx="24" cy="31" r="2.8" fill="${K}"/>`,

    // Boards — pinned cards, one still glowing.
    _group_boards: (A) => `
      <rect x="7" y="10" width="15" height="19" rx="2.4" stroke="${S}" stroke-width="2.2" fill="none"/>
      <rect x="26" y="10" width="15" height="12" rx="2.4" stroke="${A}" stroke-width="2.2" fill="none"/>
      <rect x="26" y="26" width="15" height="12" rx="2.4" stroke="${S}" stroke-width="2.2" fill="none"/>
      <rect x="7" y="33" width="15" height="5" rx="2" stroke="${S}" stroke-width="2.2" fill="none"/>
      <circle cx="33.5" cy="16" r="2.4" fill="${K}"/>`,

    // Gossamyr — the orb web, one visitor already caught.
    gossamyr: (A) => `
      <path d="M24 5 L40.5 14.5 V33.5 L24 43 L7.5 33.5 V14.5 Z" stroke="${A}" stroke-width="2.2" fill="none" stroke-linejoin="round"/>
      <path d="M24 13 L33 18 V28 L24 33 L15 28 V18 Z" stroke="${S}" stroke-width="1.9" fill="none" stroke-linejoin="round"/>
      <path d="M24 5 V13 M40.5 14.5 L33 18 M40.5 33.5 L33 28 M24 43 V33 M7.5 33.5 L15 28 M7.5 14.5 L15 18" stroke="${S}" stroke-width="1.6"/>
      <circle cx="30" cy="24" r="2.6" fill="${K}"/>`,
  };

  function keyFor(id, group) {
    if (id === "findaliens") return "seealiens"; // merged app, same saucer mark
    if (MARKS[id]) return id;
    if (group && MARKS["_group_" + String(group).toLowerCase().replace(/[^a-z]/g, "")]) {
      return "_group_" + String(group).toLowerCase().replace(/[^a-z]/g, "");
    }
    return null;
  }

  function accent(id, group) {
    return ACCENTS[keyFor(id, group)] || ACCENTS[id] || ACCENTS._default;
  }

  function monogram(name) {
    const words = String(name || "?").split(/[\s·]+/).filter(Boolean);
    const m = words.length >= 2 ? words[0][0] + words[1][0] : String(name || "?").slice(0, 2);
    return m.toUpperCase();
  }

  // Returns an <svg> string. Unknown apps get a drawn monogram in the same
  // stroke voice, so the set never breaks when a new app is scanned in.
  function sigil(id, opts) {
    const o = opts || {};
    const size = o.size || 24;
    const key = keyFor(id, o.group);
    const A = accent(id, o.group);
    const inner = key
      ? MARKS[key](A)
      : `<circle cx="24" cy="24" r="17" stroke="${S}" stroke-width="2.4" fill="none"/>
         <text x="24" y="29.5" text-anchor="middle" font-family="ui-monospace,Consolas,monospace"
               font-size="13.5" font-weight="600" letter-spacing="0.5" fill="${A}">${monogram(o.name)}</text>`;
    return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" fill="none" aria-hidden="true">${inner}</svg>`;
  }

  window.roostSigils = { sigil, accent, monogram };
})();
