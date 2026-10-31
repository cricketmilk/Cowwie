#!/usr/bin/env python3
"""
Re-point this install at wherever the project now lives.

    python repair.py            check everything, fix what's fixable
    python repair.py --check    report only, change nothing

Run it after moving or copying the project folder. Three things are tied to
the absolute location and none of them notice on their own:

  1. The desktop shortcut targets electron.exe inside node_modules, so it
     points into the old location and either fails or launches a stale copy.
  2. Registry entries using a relative path that climbs out of the tree
     ("../../../Thing/app") re-resolve against the NEW location. They do not
     error — they silently name a different, plausible directory.
  3. node_modules may not have come along, or came along without the
     ~215MB electron binary, which is downloaded by a postinstall step
     rather than living in the package.

Read-only apart from the shortcut it regenerates and the report it prints.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "apps.config.json"

OK, WARN, BAD = "ok", "warn", "bad"
MARK = {OK: "  ok  ", WARN: " warn ", BAD: " FAIL "}

results: list[tuple[str, str, str]] = []


def record(state: str, label: str, detail: str = "") -> None:
    results.append((state, label, detail))
    print(f"[{MARK[state]}] {label}" + (f"\n              {detail}" if detail else ""))


# ---------------------------------------------------------------- the checks


def check_location() -> None:
    record(OK, f"project root: {ROOT}")
    # A path with no drive letter on Windows means a UNC/network location,
    # where node_modules/.bin shims and Electron both behave differently.
    if platform.system() == "Windows" and str(ROOT).startswith("\\\\"):
        record(WARN, "project is on a UNC network path",
               "Electron and npm shims are unreliable here. A local drive is safer.")


def check_node_modules() -> Path | None:
    nm = ROOT / "node_modules"
    if not nm.exists():
        record(BAD, "node_modules is missing",
               "Run:  npm install        (from this folder)")
        return None

    pkg = nm / "electron"
    if not pkg.exists():
        record(BAD, "the electron package is missing from node_modules",
               "Run:  npm install")
        return None

    exe = {
        "Windows": pkg / "dist" / "electron.exe",
        "Darwin": pkg / "dist" / "Electron.app" / "Contents" / "MacOS" / "Electron",
    }.get(platform.system(), pkg / "dist" / "electron")

    if not exe.exists():
        # The single most confusing state: npm install exits 0, but the binary
        # download is a separate postinstall step that can fail silently and
        # then be cached as "done". Re-running npm install does not fix it.
        record(BAD, "electron package present but its binary is missing",
               "The postinstall download did not finish. Run:\n"
               "                node node_modules/electron/install.js")
        return None

    mb = exe.stat().st_size // 1048576
    record(OK, f"electron binary present ({mb}MB)")
    return exe


def check_registry() -> int:
    if not CONFIG.exists():
        record(BAD, "apps.config.json is missing")
        return 1
    try:
        # utf-8-sig, not utf8: Notepad and PowerShell's Set-Content -Encoding
        # utf8 both prepend a BOM, and json chokes on it. Reading with -sig
        # accepts a file with or without one.
        cfg = json.loads(CONFIG.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as e:
        record(BAD, "apps.config.json is not valid JSON", str(e))
        return 1

    apps = [a for a in cfg.get("apps", []) if a.get("id") and "$comment" not in a]
    record(OK, f"registry parses — {len(apps)} app(s)")

    default = cfg.get("defaultApp")
    if default and not any(a["id"] == default for a in apps):
        record(BAD, f'defaultApp is "{default}", which is not in the registry',
               "Boot falls through to the FIRST entry instead. If that is a\n"
               "              capture target, the shell opens a live site on launch.")

    problems = 0
    for a in apps:
        # kind:external is a URL; nothing on disk to check.
        target = a.get("cwd") or a.get("path") or a.get("root")
        if not target:
            continue

        escapes = not os.path.isabs(target) and target.replace("\\", "/").startswith("..")
        resolved = (ROOT / target).resolve()

        if not resolved.exists():
            problems += 1
            if escapes:
                record(BAD, f'{a["id"]}: "{target}" does not exist',
                       f"resolved to {resolved}\n"
                       "              This is a relative path pointing OUT of the project, so it\n"
                       "              moved when the project did. Replace it with the absolute\n"
                       "              path to where that project actually lives.")
            else:
                record(BAD, f'{a["id"]}: "{target}" does not exist',
                       f"resolved to {resolved}")
        elif escapes:
            problems += 1
            record(WARN, f'{a["id"]}: relative path climbs out of the project',
                   f'"{target}" happens to resolve right now, but it is anchored to\n'
                   f"              this folder's location. Move the project and it will point\n"
                   f"              somewhere else without erroring. Use:  {resolved}")
    if not problems:
        record(OK, "every registry path resolves, and none are anchored to this folder")
    return problems


def check_shortcut(electron: Path | None) -> None:
    """Report whether the desktop shortcut still points at this install."""
    if platform.system() != "Windows":
        return
    try:
        from make_shortcut import APP_NAME, desktop_dir
    except Exception as e:
        record(WARN, "could not read make_shortcut.py", str(e))
        return

    link = desktop_dir() / f"{APP_NAME}.lnk"
    if not link.exists():
        record(WARN, f"no desktop shortcut at {link}")
        return

    ps = (
        f"$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{link}');"
        "Write-Output $s.TargetPath"
    )
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
            capture_output=True, text=True, timeout=30,
        )
        target = Path(r.stdout.strip()) if r.stdout.strip() else None
    except Exception as e:
        record(WARN, "could not read the shortcut", str(e))
        return

    if electron and target and target.resolve() == electron.resolve():
        record(OK, "desktop shortcut points at this install")
    elif target and not target.exists():
        record(BAD, "desktop shortcut points at a path that no longer exists",
               f"{target}\n              Regenerating below.")
    else:
        record(WARN, "desktop shortcut points somewhere else",
               f"{target}\n              Regenerating below so it targets this install.")


def regenerate_shortcut() -> None:
    print()
    print("  regenerating the desktop shortcut...")
    # encoding is explicit because text=True decodes with the locale codec,
    # which is cp1252 on a default Windows install. The child writes UTF-8, so
    # without this an em-dash arrives as "â€”".
    r = subprocess.run(
        [sys.executable, str(ROOT / "make_shortcut.py")],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    for line in (r.stdout or "").splitlines():
        s = line.strip()
        # The child prompts before closing so its own console window stays
        # readable. Piped into here that prompt is just noise, and printing it
        # implies this script is waiting for input when it isn't.
        if not s or s.startswith("=") or s.startswith("Press Enter"):
            continue
        print(f"  {s}")
    if r.returncode != 0:
        record(BAD, "make_shortcut.py failed", (r.stderr or "").strip()[-400:])


# --------------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="report only, change nothing")
    args = ap.parse_args()

    print()
    print("=" * 68)
    print("  repair — re-point this install at its current location")
    print("=" * 68)
    print()

    check_location()
    electron = check_node_modules()
    check_registry()
    check_shortcut(electron)

    if not args.check and electron:
        regenerate_shortcut()

    bad = sum(1 for s, _, _ in results if s == BAD)
    warn = sum(1 for s, _, _ in results if s == WARN)

    print()
    print("=" * 68)
    if bad:
        print(f"  {bad} problem(s) need attention — see FAIL above.")
    elif warn:
        print(f"  Usable, with {warn} thing(s) worth fixing — see warn above.")
    else:
        print("  Everything checks out.")
    print("=" * 68)
    print()
    return 1 if bad else 0


if __name__ == "__main__":
    code = main()
    if platform.system() == "Windows":
        try:
            input("Press Enter to close... ")
        except (EOFError, KeyboardInterrupt):
            pass
    sys.exit(code)
