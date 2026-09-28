# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Windows 7 build.

Built with PyInstaller 5.13.2 on Python 3.8.10. Both versions are load-bearing
and neither can be quietly upgraded:

  * PyInstaller 6 dropped support for targeting Windows 7. 5.13.2 is the last
    release whose output runs on Win7.
  * Python 3.8 is the last release Microsoft supports on Windows 7. A build
    made with 3.9+ produces an executable that fails to start on Win7 with an
    unhelpful error, because the interpreter itself will not initialise.

Run it with the Win7 virtualenv, NOT the project's main one:

    C:\\Users\\Creative Computer\\Desktop\\_win7env\\Scripts\\python -m PyInstaller \\
        desktop\\win7\\build-win7.spec

Result: dist\\ChakwalDC-win7\\
"""

import os

block_cipher = None

# Resolved from this file's own location, not from the process CWD. A relative
# path here silently picks up whatever happens to be in the working directory,
# and the failure shows up much later as missing web assets.
HERE = os.path.dirname(os.path.abspath(SPEC))  # noqa: F821 - injected by PyInstaller
ROOT = os.path.dirname(os.path.dirname(HERE))   # desktop/win7 -> project root

# govapi.py is shared with the hosted site and the modern build. It is included
# as a data file rather than imported, so the bundle provably contains the same
# file that the other two builds use -- a second copy, silently edited, is the
# kind of divergence that produces "the Win7 build gives a different rate".
GOVAPI = os.path.join(ROOT, "govapi.py")
SERVER = os.path.join(HERE, "server.py")

WEB_SRC = os.path.join(ROOT, "desktop", "web")
WEB_FILES = [
    os.path.join(WEB_SRC, n)
    for n in ("index.html", "app.js", "desktop.js", "browser-check.js",
              "styles.css", "reference.js", "urban.js")
    if os.path.isfile(os.path.join(WEB_SRC, n))
]

# The 226 per-mouza Khasra lists. They are loaded by the page, not by Python, so
# they are data. Missing them does not stop the program from starting; it stops
# the Khasra list from appearing, which is worse, so the build checks.
KHASRA_DIR = os.path.join(WEB_SRC, "data", "khasras")
KHASRA_FILES = []
if os.path.isdir(KHASRA_DIR):
    KHASRA_FILES = [
        os.path.join(KHASRA_DIR, n)
        for n in os.listdir(KHASRA_DIR)
        if n.endswith(".js")
    ]

ICON = os.path.join(ROOT, "desktop", "installer", "chakwal.ico")

datas = [
    (GOVAPI, "."),
    (SERVER, "."),
    # 'web' at the top of _internal, which is where main.py's web_root() looks.
    (WEB_SRC, "web"),
]

if os.path.isfile(ICON):
    datas.append((ICON, "."))

# Optional, and a build-time warning rather than a failure if absent -- the icon
# is cosmetic. A missing Khasra list is a different matter: the page would load
# and then fail to show any Khasra, so that one refuses the build.
if len(KHASRA_FILES) < 200:
    raise SystemExit(
        "Only {0} Khasra data files found in {1}. Expected 226. Refusing to "
        "build an app whose Khasra lists are missing.".format(
            len(KHASRA_FILES), KHASRA_DIR)
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
        # Not used by this build, and each one is a DLL that has to be collected,
        # shipped and kept working on a platform nobody tests any more.
        "tkinter",
        "unittest",
        "pydoc_data",
        "test",
        "lib2to3",
        # FastAPI, pydantic, uvicorn and pywebview are excluded by name. None is
        # importable here, so this list is belt-and-braces, but it states the
        # intent: if a stray import ever pulls one of these in, the build fails
        # loudly rather than quietly producing a 60 MB bundle that will not run
        # on the platform it was made for.
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

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ChakwalDC",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # 'console', not 'windowed'. There is no webview window to be the app's
    # window, so the console IS the window: it is where the address is printed
    # and it is what the user closes to stop the program. A windowed build here
    # would give a process with no window, no output and no way to end it.
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=ICON if os.path.isfile(ICON) else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="ChakwalDC-win7",
)
