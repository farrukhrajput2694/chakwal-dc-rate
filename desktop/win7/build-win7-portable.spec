# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the PORTABLE Windows 7 build -- one file, no installer.

    C:\\Users\\Creative Computer\\Desktop\\_win7env\\Scripts\\python -m PyInstaller \\
        --noconfirm --clean desktop\\win7\\build-win7-portable.spec

Produces dist\\ChakwalDC-Win7-Portable.exe: copy it to a USB stick, double-click
it, and it runs. Nothing to install, nothing to uninstall, no Program Files, no
registry, no shortcuts, no administrator rights, and no Visual C++ installer --
the MSVC runtime DLLs are inside the file.

That last point is the reason this file is worth having for Windows 7. The
regular Win7 installer (desktop\\win7\\ChakwalDC-Win7.iss) has to run Microsoft's
vc_redist.x64.exe, because stock Windows 7 has no VCRUNTIME140.dll and the
build genuinely needs it. A onefile build carries the same DLLs with it, so
there is nothing to install and nothing to go wrong. It is 25 MB bigger and
that is the whole trade.

Same caveat as the folder build, and it is not small: this has never been run on
Windows 7. See desktop\\win7\\README.md.

console=True, and unlike the modern portable this is not a cosmetic choice.
The Win7 build has no window of its own -- it opens the default browser --
so the console is where the address is printed and it is what the user closes
to stop the program. A windowed build here would be a process with no window, no
output and no way to end it.
"""

import os

block_cipher = None

HERE = os.path.dirname(os.path.abspath(SPEC))  # noqa: F821 - injected by PyInstaller
ROOT = os.path.dirname(os.path.dirname(HERE))   # desktop/win7 -> project root

GOVAPI = os.path.join(ROOT, "govapi.py")
SERVER = os.path.join(HERE, "server.py")
WEB_SRC = os.path.join(ROOT, "desktop", "web")
ICON = os.path.join(ROOT, "desktop", "installer", "chakwal.ico")

datas = [
    (GOVAPI, "."),
    (SERVER, "."),
    (WEB_SRC, "web"),
]
if os.path.isfile(ICON):
    datas.append((ICON, "."))

# The 226 per-mouza Khasra lists are loaded by the page, not by Python, so they
# are data. A build missing them starts fine and then shows no Khasras at all,
# which is worse than not starting, so this refuses rather than ships that.
KHASRA_DIR = os.path.join(WEB_SRC, "data", "khasras")
khasra_count = 0
if os.path.isdir(KHASRA_DIR):
    khasra_count = len([n for n in os.listdir(KHASRA_DIR) if n.endswith(".js")])
if khasra_count < 200:
    raise SystemExit(
        "Only {0} Khasra data files in {1}, expected 226. Refusing to build an "
        "app whose Khasra lists are missing.".format(khasra_count, KHASRA_DIR)
    )

a = Analysis(
    [os.path.join(HERE, "main.py")],
    pathex=[ROOT, HERE],
    binaries=[],
    datas=datas,
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "unittest",
        "pydoc_data",
        "test",
        "lib2to3",
        # Stated rather than left implicit: none of these is importable in the
        # Python 3.8 environment this is built with, because they all require a
        # newer Python -- which is the entire reason this build exists. Naming
        # them means a stray import fails loudly at build time instead of
        # quietly producing a 60 MB bundle that cannot run on Windows 7.
        "fastapi",
        "pydantic",
        "uvicorn",
        "webview",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# onefile: binaries and datas go straight into the EXE, and there is no COLLECT.
# Its absence is what makes this a single file rather than a folder.
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="ChakwalDC-Win7-Portable",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=ICON if os.path.isfile(ICON) else None,
)
