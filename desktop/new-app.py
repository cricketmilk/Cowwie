#!/usr/bin/env python3
"""
Scaffold a new standalone app and register it with the Ifreglen shell.

    python new-app.py owlgrythm
    python new-app.py owlgrythm --kind static --parent C:\\projects

Creates the app in its OWN folder, OUTSIDE the shell, so it builds and
versions independently. The shell only stores a path to it — editing one
never touches the other. Also drops a starter file, a README, and a .gitignore
so the app can be its own git repo from day one.

Nothing about the shell's own code is modified except one new entry appended
to apps.config.json.
"""
from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path

SHELL = Path(__file__).resolve().parent          # ...\ifreglen\shell
PLATFORM = SHELL.parent                           # ...\ifreglen
CONFIG = SHELL / "apps.config.json"


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "app"


def title(name: str) -> str:
    return re.sub(r"[-_]+", " ", name).strip().title()


STATIC_INDEX = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>{title}</title>
  <style>
    body {{ margin:0; font-family: system-ui, sans-serif; background:#0f1419;
           color:#e6edf3; display:grid; place-items:center; height:100vh; }}
    main {{ text-align:center; }}
    h1 {{ font-weight:600; letter-spacing:-0.02em; }}
    p  {{ color:#8b98a5; }}
  </style>
</head>
<body>
  <main>
    <h1>{title}</h1>
    <p>Edit <code>index.html</code> and save — the shell reloads automatically.</p>
  </main>
  <script>
    // window.roost exists only when running inside Ifreglen. Guard for it so
    // the app still works when opened directly in a browser.
    if (window.roost) {{
      console.log("running in Ifreglen with:", window.roost.capabilities);
    }}
  </script>
</body>
</html>
"""

README = """# {title}

Standalone app. Runs on its own, and also inside the Ifreglen shell.

## Run by itself
{run_hint}

## Run inside Ifreglen
Already registered. Launch the shell and pick "{title}" from the toolbar.
Its files live here, in their own folder and (optionally) their own git repo —
the shell only holds a path to this directory, so the two are independent.

## Ifreglen capabilities
When launched inside the shell, `window.roost` is available with whatever
capabilities the registry grants. Outside the shell it's undefined, so guard
for it.
"""

GITIGNORE = "node_modules/\n__pycache__/\n*.pyc\ndist/\nbuild/\n.env\n.DS_Store\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("name")
    ap.add_argument("--kind", choices=["static", "local"], default="static")
    ap.add_argument("--parent", default=str(PLATFORM.parent),
                    help="where the app folder is created (default: beside the platform)")
    ap.add_argument("--persona", default="workshop")
    ap.add_argument("--command", help="dev-server command for --kind local")
    args = ap.parse_args()

    app_id = slug(args.name)
    app_title = title(args.name)
    parent = Path(args.parent).resolve()
    app_dir = parent / app_id

    if app_dir.exists() and any(app_dir.iterdir()):
        print(f"\n  {app_dir} already exists and isn't empty — refusing to overwrite.")
        print("  Pick a different name or --parent, or register it by hand.")
        return 1

    app_dir.mkdir(parents=True, exist_ok=True)

    # Relative path from the shell to the app, so the registry stays portable
    # if the whole tree moves together.
    try:
        rel = Path(__import__("os").path.relpath(app_dir, SHELL)).as_posix()
    except ValueError:
        rel = str(app_dir)  # different drive on Windows -> absolute is fine

    entry = {"id": app_id, "name": app_title, "persona": args.persona,
             "capabilities": ["store", "fs"], "root": rel}

    if args.kind == "static":
        (app_dir / "index.html").write_text(STATIC_INDEX.format(title=app_title), encoding="utf-8")
        entry["kind"] = "static"
        entry["path"] = f"{rel}/index.html"
        run_hint = "Open `index.html` in any browser."
    else:
        entry["kind"] = "local"
        entry["cwd"] = rel
        entry["command"] = args.command or "npm run dev"
        run_hint = f"Run `{entry['command']}` in this folder."
        (app_dir / "START_HERE.txt").write_text(
            f"Put your app here. The shell will run:\n    {entry['command']}\n"
            "and read the dev server's URL from its stdout.\n", encoding="utf-8")

    (app_dir / "README.md").write_text(
        README.format(title=app_title, run_hint=run_hint), encoding="utf-8")
    (app_dir / ".gitignore").write_text(GITIGNORE, encoding="utf-8")

    # Append to the registry — the ONLY change to the shell.
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    if any(a.get("id") == app_id for a in cfg["apps"]):
        print(f"\n  An app with id '{app_id}' is already registered. Folder created,")
        print(f"  but registry left alone: {app_dir}")
        return 0
    cfg["apps"].append(entry)
    CONFIG.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")

    print()
    print("=" * 60)
    print(f"  Created {app_title}")
    print("=" * 60)
    print(f"  App folder : {app_dir}")
    print(f"  Kind       : {args.kind}")
    print(f"  Registered : {CONFIG.name} (1 entry appended)")
    print()
    print("  This app is independent of the shell. To make it its own repo:")
    print(f"    cd {app_dir}")
    print("    git init")
    print()
    print("  Launch Ifreglen and pick it from the toolbar. Editing it never")
    print("  touches the platform, and vice versa.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"\n  Error: {type(e).__name__}: {e}")
        sys.exit(1)
