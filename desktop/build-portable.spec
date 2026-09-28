# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the PORTABLE build -- one file, no installer.

    .venv\\Scripts\\python -m PyInstaller --noconfirm --clean desktop\\build-portable.spec

Produces dist\\ChakwalDC-Portable.exe. Copy that one file to a USB stick, email
it, drop it on the Desktop -- double-click it and it runs. Nothing to install,
nothing to uninstall, no Program Files, no registry, no shortcuts, no
administrator rights.

How it differs from desktop\\build.spec, which is a one-DIRECTORY build:

  * onefile, not onedir. All 400-odd files are packed into the .exe and unpacked
    to a temp folder at each launch. That is the whole trade: a single file
    that can be moved anywhere, paid for in a slower start and in a temp
    folder that briefly holds ~45 MB. The onedir build starts in about a
    second and never touches temp; if that matters more than being one file,
    use dist\\ChakwalDC\\ and copy the folder.
  * console=False, so there is no black window behind the app. The pywebview
    window is the app's only window.
  * No installer, so nothing writes to Program Files and nothing needs
    elevating. That is also why the app can live anywhere: state_dir() prefers
    the folder the .exe is in, and falls back to %LOCALAPPDATA%\\ChakwalDC when
    the .exe is somewhere read-only, such as a network share or Program Files.
  * Still no VC++ runtime, still unsigned. The MSVC DLLs come from the same
    Python 3.12 that built it; a Windows 10/11 machine already has them. See
    desktop\\win7\\README.md for the Windows 7 case, which is different.

main.py needed no changes for this: it already resolves the bundle through
sys._MEIPASS for both the project root and the web assets, and app_dir() uses
sys.executable's folder, which is wherever the user put the file.
"""

import os

block_cipher = None

HERE = os.path.dirname(os.path.abspath(SPEC))  # noqa: F821 - injected by PyInstaller
ROOT = os.path.dirname(HERE)                   # desktop -> project root

WEB_SRC = os.path.join(ROOT, "desktop", "web")
ICON = os.path.join(ROOT, "desktop", "installer", "chakwal.ico")

datas = [
    (os.path.join(ROOT, "app.py"), "."),
    (os.path.join(ROOT, "govapi.py"), "."),
    (WEB_SRC, "web"),
]
if os.path.isfile(ICON):
    datas.append((ICON, "."))

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
        # Not used here, and each is a DLL that would have to be collected,
        # shipped and kept working for no benefit.
        "tkinter",
        "unittest",
        "pydoc_data",
        "test",
        "lib2to3",
    ],
    # NOT excluded, and this is a hard-won note rather than an oversight.
    #
    # pythonnet (3.2 MB), clr_loader, and webview.platforms.winforms look like
    # dead weight: this app shows a WebView2 window, so the .NET interop layer
    # seems pointless. Excluding them produced a build that started, served the
    # page, and then died the moment the window opened:
    #
    #   ERROR pywebview: pythonnet cannot be loaded
    #   ModuleNotFoundError: No module named 'webview.platforms.winforms'
    #   WebViewException: You must have pythonnet installed in order to use
    #   pywebview.
    #
    # The reason is that pywebview's DEFAULT Windows backend is winforms, not
    # edgechromium. main.py does not pass a `gui=` argument, so pywebview picks
    # winforms, and winforms goes through pythonnet. pythonnet is therefore
    # load-bearing for this build.
    #
    # The 3.2 MB can be reclaimed by passing gui="edgechromium" to
    # webview.start() and dropping these excludes -- which pairs naturally with
    # the _webview2_available() check, since that backend is the one that
    # _webview2_available() is asking about. That is a behaviour change to the
    # primary build, not a packaging change, and it was NOT made here: the
    # onedir build passes a 35-check end-to-end test on the winforms backend,
    # and trading a verified build for 3.2 MB is a bad trade. It is the obvious
    # next step if the onefile start-up time ever needs improving, and it should
    # be done together with a re-run of that test.
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# onefile: binaries and datas go straight into the EXE. There is no COLLECT, and
# its absence is what makes this a single file rather than a folder.
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="ChakwalDC-Portable",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX is not used. It is not installed, and packing a Python interpreter with
    # it is the sort of thing antivirus flags, which would make this file worse
    # to hand to somebody rather than better.
    upx=False,
    # No console. The pywebview window is the app's window, and a black
    # rectangle behind it is not what "just double-click it" should look like.
    #
    # The cost: if WebView2 is missing, main.py falls back to opening the
    # default browser, and there is no console to print the address to. It
    # writes desktop-url.txt beside the .exe for exactly that reason, and the
    # browser opens the page directly, so the fallback still works -- it is just
    # quieter than the installed build.
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=ICON if os.path.isfile(ICON) else None,
)
