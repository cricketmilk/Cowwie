#!/usr/bin/env python3
"""
Create a desktop launcher for Ifreglen.

    python make_shortcut.py

Windows  -> Desktop\\Ifreglen.lnk pointing at electron.exe with the icon attached
Linux    -> ~/.local/share/applications/ifreglen.desktop (+ a Desktop copy)
macOS    -> a Ifreglen.app bundle wrapper on the Desktop

Per-app launchers (Windows only for now):

    python make_shortcut.py maizey gossamyr wheattodd

makes one .lnk per registered app id, each passing --app=<id> so it opens
straight into that app instead of the Sanctum. They are shortcuts to the same
shell, not separate programs — the single-instance lock means clicking one
while Ifreglen is already up switches the running window to that app. Each gets
its own icon built from the app's tile art when it has one.

This is the run-from-source launcher: it points at the electron binary in
node_modules, so the shortcut breaks if you move the project folder. For
something you can hand to another machine, build a real installer instead:

    npm run dist

The shortcut deliberately targets electron.exe directly rather than a .cmd
wrapper — a .cmd shortcut flashes a console window every launch, which looks
broken even though it isn't.
"""

from __future__ import annotations

import os
import platform
import stat
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ICON_DIR = ROOT / "build"


def desktop_dir() -> Path:
    if platform.system() == "Windows":
        # Respects OneDrive/redirected Desktop, which a hardcoded path won't.
        try:
            out = subprocess.run(
                ["powershell", "-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"],
                capture_output=True, text=True, timeout=20,
            )
            p = Path(out.stdout.strip())
            if p.is_dir():
                return p
        except Exception:
            pass
    return Path.home() / "Desktop"


def electron_binary() -> Path | None:
    """Locate the Electron executable, repairing a half-finished install.

    npm installs the electron *package* and then downloads the ~120MB binary
    in a postinstall step. That download fails silently behind proxies and
    corporate firewalls, and npm caches the failure — so `npm install` reports
    success, exits 0, and leaves no binary. Re-running npm install does not
    fix it, which makes this a genuinely confusing state to land in.

    So: if the package is present but the binary isn't, run the downloader
    directly rather than telling the user to repeat what they already did.
    """
    pkg = ROOT / "node_modules" / "electron"
    base = pkg / "dist"
    candidates = {
        "Windows": base / "electron.exe",
        "Darwin": base / "Electron.app" / "Contents" / "MacOS" / "Electron",
        "Linux": base / "electron",
    }
    binary = candidates.get(platform.system())
    if binary and binary.exists():
        return binary

    # electron writes the executable name here after a successful download.
    path_txt = pkg / "path.txt"
    if path_txt.exists():
        candidate = base / path_txt.read_text(encoding="utf8").strip()
        if candidate.exists():
            return candidate

    if not pkg.exists():
        return None  # package genuinely absent -> npm install is the answer

    # Package present, binary missing: the postinstall didn't complete.
    print("  Electron package found, but its binary is missing.")
    print("  That download is a separate postinstall step and it didn't finish.")
    print("  Fetching it now (~120MB, one time)...")
    installer = pkg / "install.js"
    if not installer.exists():
        return None
    try:
        r = subprocess.run(
            ["node", str(installer)],
            cwd=str(pkg), capture_output=True, text=True, timeout=1800,
        )
    except FileNotFoundError:
        print("\n  'node' is not on PATH. Install Node.js from https://nodejs.org")
        return None
    except subprocess.TimeoutExpired:
        print("\n  Download timed out. Check your connection and re-run.")
        return None

    if r.returncode != 0:
        err = (r.stderr or r.stdout).strip()[-700:]
        print("\n  The download failed:")
        for line in err.splitlines()[-10:]:
            print(f"    {line}")
        print("\n  Common causes and fixes:")
        print("    - Corporate proxy: set HTTPS_PROXY, then re-run")
        print("        set HTTPS_PROXY=http://your.proxy:port")
        print("    - Firewall blocking github.com releases: download the zip")
        print("      matching your Electron version from")
        print("        https://github.com/electron/electron/releases")
        print("      and set ELECTRON_OVERRIDE_DIST_PATH to where you unzipped it")
        print("    - Try again with a clean cache:")
        print("        npm cache clean --force && npm install")
        return None

    if binary and binary.exists():
        print("  Binary installed.")
        return binary
    return None


def ensure_icons() -> bool:
    ico = ICON_DIR / ("icon.ico" if platform.system() == "Windows" else "icon.png")
    if ico.exists():
        return True
    print("  Icons missing — generating them first...")
    r = subprocess.run([sys.executable, str(ROOT / "make_icons.py")], capture_output=True, text=True)
    if r.returncode != 0:
        print("  Could not generate icons:")
        print(r.stderr.strip()[-500:] or r.stdout.strip()[-500:])
        return False
    print(r.stdout.strip())
    return ico.exists()


# --------------------------------------------------------------------------


def load_apps() -> dict:
    """id -> entry, for the registered (non-template) apps."""
    import json
    cfg = json.loads((ROOT / "apps.config.json").read_text(encoding="utf8"))
    return {a["id"]: a for a in cfg.get("apps", []) if a.get("id")}


def app_icon(entry: dict) -> Path:
    """Build a .ico from the app's tile art, falling back to the Ifreglen icon.

    Windows shortcuts want an .ico; the tile art is .png, so convert once and
    cache it. Pillow is already a dependency of the art scripts here.
    """
    fallback = ICON_DIR / "icon.ico"
    art = entry.get("art")
    if not art:
        return fallback
    src = ROOT / "renderer" / "lounge" / art
    if not src.exists():
        return fallback
    out_dir = ICON_DIR / "app-icons"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{entry['id']}.ico"
    try:
        from PIL import Image
    except ImportError:
        return fallback
    try:
        im = Image.open(src).convert("RGBA")
        # Square canvas so the icon isn't squashed — tile art is tall and thin.
        side = max(im.width, im.height)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2), im)
        canvas.save(out, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
        return out
    except Exception as e:
        print(f"    (icon for {entry['id']} fell back to the default: {e})")
        return fallback


def _ps_quote(s) -> str:
    """Single-quoted PowerShell literal; an apostrophe is escaped by doubling."""
    return str(s).replace("'", "''")


def make_lnk(link: Path, electron: Path, arguments: str, icon: Path, description: str) -> int:
    ps = f"""
$s = (New-Object -ComObject WScript.Shell).CreateShortcut('{_ps_quote(link)}')
$s.TargetPath       = '{_ps_quote(electron)}'
$s.Arguments        = '{_ps_quote(arguments)}'
$s.WorkingDirectory = '{_ps_quote(ROOT)}'
$s.IconLocation     = '{_ps_quote(icon)},0'
$s.Description      = '{_ps_quote(description)}'
$s.Save()
"""
    r = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(f"  Failed to create {link.name}:")
        print((r.stderr or r.stdout).strip()[-600:])
        return 1
    print(f"  Created {link}")
    return 0


def safe_name(name: str) -> str:
    for ch in '\\/:*?"<>|':
        name = name.replace(ch, "-")
    return name.strip() or "app"


def windows(electron: Path, app_ids: list[str] | None = None) -> int:
    if not app_ids:
        rc = make_lnk(
            desktop_dir() / "Ifreglen.lnk", electron,
            f'"{ROOT}"', ICON_DIR / "icon.ico", "Ifreglen - project shell",
        )
    else:
        apps = load_apps()
        unknown = [i for i in app_ids if i not in apps]
        if unknown:
            print(f"  Unknown app id(s): {', '.join(unknown)}")
            print(f"  Registered: {', '.join(sorted(apps))}")
            return 1
        rc = 0
        for app_id in app_ids:
            entry = apps[app_id]
            name = entry.get("name", app_id)
            rc |= make_lnk(
                desktop_dir() / f"{safe_name(name)}.lnk", electron,
                f'"{ROOT}" --app={app_id}', app_icon(entry),
                f"{name} - via Ifreglen",
            )

    print("  If the icon still looks generic, Explorer has cached the old one:")
    print("    ie4uinit.exe -show      (refreshes the icon cache)")
    return rc


def linux(electron: Path) -> int:
    icon = ICON_DIR / "icon.png"
    entry = f"""[Desktop Entry]
Type=Application
Name=Ifreglen
Comment=Project shell
Exec="{electron}" "{ROOT}"
Path={ROOT}
Icon={icon}
Terminal=false
Categories=Development;
StartupWMClass=Ifreglen
"""
    apps = Path.home() / ".local" / "share" / "applications"
    apps.mkdir(parents=True, exist_ok=True)
    target = apps / "ifreglen.desktop"
    target.write_text(entry)
    target.chmod(target.stat().st_mode | stat.S_IEXEC)
    print(f"  Created {target}")

    d = desktop_dir()
    if d.is_dir():
        copy = d / "ifreglen.desktop"
        copy.write_text(entry)
        copy.chmod(copy.stat().st_mode | stat.S_IEXEC)
        print(f"  Created {copy}")

    # Optional cache refresh. Not present on every distro, and its absence is
    # cosmetic — the entry works either way, so never let it fail the script.
    try:
        subprocess.run(["update-desktop-database", str(apps)], capture_output=True, timeout=15)
    except (FileNotFoundError, subprocess.SubprocessError):
        pass
    return 0


def macos(electron: Path) -> int:
    # A minimal .app wrapper. Enough for a Dock icon when running from source;
    # `npm run dist` produces the real signed bundle.
    appdir = desktop_dir() / "Ifreglen.app"
    macos_dir = appdir / "Contents" / "MacOS"
    res_dir = appdir / "Contents" / "Resources"
    macos_dir.mkdir(parents=True, exist_ok=True)
    res_dir.mkdir(parents=True, exist_ok=True)

    icns = ICON_DIR / "icon.icns"
    if icns.exists():
        (res_dir / "icon.icns").write_bytes(icns.read_bytes())
    else:
        print("  No icon.icns (png2icns not installed) — bundle will use the default icon.")

    (appdir / "Contents" / "Info.plist").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        '<plist version="1.0"><dict>'
        "<key>CFBundleName</key><string>Ifreglen</string>"
        "<key>CFBundleExecutable</key><string>ifreglen</string>"
        "<key>CFBundleIdentifier</key><string>com.ifreglen.shell</string>"
        "<key>CFBundleIconFile</key><string>icon</string>"
        "<key>CFBundlePackageType</key><string>APPL</string>"
        "</dict></plist>\n"
    )
    launcher = macos_dir / "ifreglen"
    launcher.write_text(f'#!/bin/sh\nexec "{electron}" "{ROOT}"\n')
    launcher.chmod(0o755)
    print(f"  Created {appdir}")
    return 0


def main() -> int:
    app_ids = [a for a in sys.argv[1:] if not a.startswith("-")]

    print()
    print("=" * 62)
    print("  Ifreglen — desktop launcher")
    print("=" * 62)

    if app_ids and platform.system() != "Windows":
        print(f"  Per-app launchers are Windows-only for now ({platform.system()} makes")
        print("  the single Ifreglen launcher instead). Run with no arguments.")
        return 1

    if not ensure_icons():
        return 1

    electron = electron_binary()
    if not electron:
        if not (ROOT / "node_modules" / "electron").exists():
            print("\n  Electron isn't installed. Run this first:")
            print(f"    cd {ROOT}")
            print("    npm install")
        else:
            print("\n  Could not obtain the Electron binary — see the notes above.")
            print("  Icons were still generated in build/, so nothing is lost.")
        return 1
    print(f"  electron  {electron}")

    system = platform.system()
    if system == "Windows":
        return windows(electron, app_ids)
    if system == "Linux":
        return linux(electron)
    if system == "Darwin":
        return macos(electron)

    print(f"  Unsupported platform: {system}")
    return 1


if __name__ == "__main__":
    code = main()
    if platform.system() == "Windows":
        try:
            input("\nPress Enter to close... ")
        except (EOFError, KeyboardInterrupt):
            pass
    sys.exit(code)
