"""Windows desktop app for the Chakwal DC Rate Calculator.

Double-click this (or the built .exe) and a window opens. There is no URL to
copy, no account, no tunnel, and nothing to keep alive: the server this starts
binds to 127.0.0.1 on an ephemeral port and lives exactly as long as the window
does.

What is local and what is live
------------------------------
Reference lists -- the 226 mouzas, their classifications, locations, and the
908,221 Khasra numbers -- are read from the bundled `web/data` files. They are
place names, they change rarely, and reading them from disk means the app opens
instantly and never spends a portal request listing them.

DC rates are NOT local. Every single lookup calls the Punjab e-Stamp portal and
the figure is used once and discarded; nothing is written to disk, because a
saved rate quietly goes stale and a stale rate is worse than no answer. This is
the same rule the hosted build follows, and it is why the app still needs a
network connection even though the lists are on disk.

Reusing the hosted app rather than reimplementing it
----------------------------------------------------
The rate logic, its validation, and the area arithmetic already exist in
`app.py` and are exercised against the real portal. This launcher imports that
same FastAPI app and serves it to the window. It deliberately does not
reimplement any of it, so a fix to the shared app fixes both builds at once.
"""

from __future__ import annotations

import os
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
# The project root, which holds app.py and govapi.py. In a frozen build these
# are not adjacent on disk, so fall back to the bundle directory.
ROOT = HERE.parent if (HERE.parent / "app.py").is_file() else Path(getattr(sys, "_MEIPASS", HERE))

# Must be set before app.py is imported: it decides whether the boot-time and
# midnight reference-list walks are armed. Both are pointless here -- the lists
# ship on disk -- and the boot walk alone is roughly 2,300 portal requests.
# Disabling them is what makes the window open instantly and keeps the app from
# hammering the portal on every launch.
os.environ.setdefault("RATE_APP_SERVERLESS", "1")


def web_root() -> Path:
    """Directory holding index.html, app.js, styles.css and data/."""
    if (HERE / "web" / "index.html").is_file():
        return HERE / "web"
    return Path(getattr(sys, "_MEIPASS", HERE)) / "web"


def free_port() -> int:
    """An ephemeral port, chosen by the OS and then released for uvicorn."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_for(url: str, timeout: float = 30.0) -> bool:
    import urllib.error
    import urllib.request

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.25)
    return False


def app_dir() -> Path:
    """The folder holding the app itself.

    In a frozen build that is the folder holding the .exe, not the bundle's
    internal directory: _internal is a build artefact, while the app folder is
    where a user would look for the files this app writes, and is the part of
    the install they can actually see.
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return HERE


def state_dir() -> Path:
    """The folder this app may actually write to.

    The app folder is the natural home for a log and for the port address, and
    in the portable build it is writable. For an installed app it is not: under
    Program Files only an installer running as administrator may write there, so
    an ordinary launch cannot create desktop.log, desktop-url.txt or
    desktop-routes.txt. Losing the last of those is not cosmetic -- a windowed
    build has no console, so the address in desktop-url.txt is the only way to
    find the port at all, and the one in desktop-routes.txt is the only way to
    see why a request 404'd.

    So try the app folder, and fall back to a per-user folder when it is
    read-only. A writable app folder is used unchanged, so the portable build
    keeps writing beside its .exe exactly as before. The fallback is only
    reached by an install, which is the case that needs it.
    """
    candidates = [app_dir()]
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidates.append(Path(local) / "ChakwalDC")
    candidates.append(Path(tempfile.gettempdir()) / "ChakwalDC")

    for folder in candidates:
        try:
            folder.mkdir(parents=True, exist_ok=True)
            # mkdir succeeding proves nothing: it can succeed on a folder that
            # still refuses new files. Write the probe to be sure.
            probe = folder / ".write-probe"
            probe.write_text("", encoding="utf-8")
            probe.unlink()
        except OSError:
            continue
        return folder
    return Path(tempfile.gettempdir())


def _log_config() -> dict:
    """A uvicorn log config that never touches stdout.

    uvicorn's stock "default" formatter colourises its output and starts by
    asking sys.stdout whether it is a terminal. A windowed PyInstaller build
    sets sys.stdout to None, so that call raises and the server dies before it
    serves a single request -- with no window to show the failure in.

    Logging to a file beside the app sidesteps the question entirely and leaves
    a trace if something does go wrong later. If that file cannot be opened
    (read-only install, say) fall back to a null handler rather than crashing
    over a log line.
    """
    quiet = {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {"plain": {"format": "%(levelname)s %(name)s: %(message)s"}},
        "handlers": {"null": {"class": "logging.NullHandler"}},
        "root": {"handlers": ["null"], "level": "WARNING"},
    }
    try:
        logfile = state_dir() / "desktop.log"
        logfile.parent.mkdir(parents=True, exist_ok=True)
        with open(logfile, "a", encoding="utf-8"):
            pass
    except OSError:
        return quiet

    quiet = dict(quiet)
    quiet["handlers"] = {
        "file": {
            "class": "logging.FileHandler",
            "filename": str(state_dir() / "desktop.log"),
            "formatter": "plain",
            "encoding": "utf-8",
            "level": "WARNING",
        }
    }
    quiet["root"] = {"handlers": ["file"], "level": "WARNING"}
    return quiet


def _webview2_available() -> bool:
    """Whether a WebView2 window can actually be created on this machine.

    True only when the platform is Windows AND the WebView2 runtime is
    installed. The runtime registers itself under

        HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-...}

    with a "pv" (product version) value. Reading that value, rather than
    importing pywebview and hoping, is the point: on Windows 7 pywebview imports
    fine and then throws when the window is created, so an import-based test
    passes on exactly the machine that cannot work. The WOW6432Node view is read
    explicitly because a 32-bit process sees the key there, and 64-bit Windows
    mirrors it; winreg lets the view be named rather than guessed.

    Anything unexpected -- a missing key, a locked registry, a non-Windows
    platform -- is treated as "not available", because the browser fallback is
    always a working outcome and a window that will not open is not.
    """
    if sys.platform != "win32":
        return False
    try:
        import winreg
    except ImportError:  # pragma: no cover - win32 only
        return False

    key_path = (
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients"
        r"\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    )
    # The path deliberately does NOT spell out WOW6432Node. The KEY_WOW64_* flag
    # already performs the redirection, so writing WOW6432Node into the path as
    # well looks for a literal folder that exists in neither view and the lookup
    # fails on a machine that has the runtime installed. Both views are tried
    # because the runtime is a 32-bit component and a 64-bit process has to ask
    # for the 32-bit view to see it; on a 32-bit Windows the 64-bit flag is
    # meaningless and the 32-bit access is the one that answers.
    for flag in (winreg.KEY_WOW64_32KEY, winreg.KEY_WOW64_64KEY):
        try:
            # KEY_READ must be OR'd in explicitly. Passing the WOW64 flag on its
            # own means "access 0" -- no read rights -- and Windows answers
            # ERROR_ACCESS_DENIED, not "not found". A bare `except OSError:
            # continue` then swallows that and reports the runtime as absent, so
            # the app quietly drops into a browser on a machine that has it.
            with winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE, key_path, 0, winreg.KEY_READ | flag
            ) as key:
                version, _ = winreg.QueryValueEx(key, "pv")
                if version:
                    return True
        except OSError:
            continue
    return False


def main() -> int:
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))

    import uvicorn

    from app import app as fastapi_app

    port = free_port()
    base = f"http://127.0.0.1:{port}"

    config = uvicorn.Config(
        fastapi_app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        access_log=False,
        log_config=_log_config(),
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="desktop-server", daemon=True)
    thread.start()

    if not wait_for(f"{base}/health"):
        print("The local server did not start. Nothing was changed.", file=sys.stderr)
        server.should_exit = True
        return 1

    web = web_root()
    # app.py mounts StaticFiles at /static and serves the page itself. Both are
    # rooted at the hosted build's folder, so point them at the desktop copy
    # before the first request is served.
    _retarget_static(fastapi_app, web)

    # Record the address beside the app. A windowed build has no console to
    # print to, so without this there is no way to find the port -- and no way
    # to fall back to a browser if the window ever fails to appear.
    try:
        (state_dir() / "desktop-url.txt").write_text(base + "/", encoding="utf-8")
    except OSError:
        pass

    print(f"Serving {web}")
    print(f"  {base}")
    print("Open the window; it closes when you close it.")

    # Can this machine show a window at all?
    #
    # An ImportError check is not enough, and the reason is specific: on Windows 7
    # pywebview imports *successfully* -- the package is pure Python and installs
    # cleanly -- and then fails when asked to create a window, because Windows 7
    # has no WebView2 runtime and there is no build of it for Win7. So the module
    # being importable says nothing about whether a window can appear.
    #
    # This asks the actual question instead. It is a capability check, not a
    # version check, because "is the WebView2 runtime present" is the thing that
    # decides the outcome, and the registry key below is what pywebview itself
    # consults to find it. If the key is absent, or the platform is not Windows,
    # the window cannot be had and the browser takes over.
    if not _webview2_available():
        import webbrowser

        print("No WebView2 runtime on this machine -- opening your browser instead.")
        webbrowser.open(base + "/")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            server.should_exit = True
            return 0

    try:
        import webview
    except ImportError:
        # The runtime is there but the Python package is not. Same outcome,
        # different reason, and both are worth saying which one it was.
        import webbrowser

        print("pywebview is not installed -- opening your browser instead.")
        webbrowser.open(base + "/")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            server.should_exit = True
            return 0

    window = webview.create_window(
        "Chakwal DC Rate Calculator",
        base + "/",
        width=1180,
        height=900,
        min_size=(820, 640),
        background_color="#0f172a",
    )

    def on_closed() -> None:
        server.should_exit = True

    window.events.closed += on_closed

    try:
        webview.start()
    finally:
        server.should_exit = True
        thread.join(timeout=10)
    return 0


def _retarget_static(fastapi_app, web: Path) -> None:
    """Point the app's page and asset routes at the desktop `web` folder.

    The hosted build serves its own `static/`; the desktop build ships the
    offline UI instead. Rewiring the routes here keeps ONE copy of app.py
    serving two different front ends, so a fix to the rate logic lands in both.

    The hosted routes have to be *removed*, not merely preceded. Starlette
    resolves a request against the first route that matches, so mounting a
    second /static and adding a second / would leave both of ours unreachable
    and the hosted index.html and app.js quietly winning every request. That
    failure is invisible: the page loads, it is just the wrong page.
    """
    from fastapi.staticfiles import StaticFiles
    from starlette.responses import FileResponse

    router = getattr(fastapi_app, "router", None)
    if router is None:
        return

    kept = [
        r
        for r in list(router.routes)
        if getattr(r, "path", None) not in ("/", "/static")
    ]
    if len(kept) != len(list(router.routes)):
        router.routes[:] = kept

    # The whole web folder goes under /static, so data/reference.js and the 226
    # per-mouza Khasra files are served by the same mount as the scripts. The
    # page declares <base href="/static/"> so its relative URLs land here too.
    fastapi_app.mount(
        "/static", StaticFiles(directory=str(web), html=True), name="desktop-static"
    )

    index = web / "index.html"
    if index.is_file():

        @fastapi_app.get("/", include_in_schema=False)
        async def _desktop_index():
            return FileResponse(str(index))

    _dump_routes(fastapi_app, web)


def _dump_routes(fastapi_app, web: Path) -> None:
    """Write the live route table next to the app.

    Worth having permanently. A windowed build has no console, so when routing
    goes wrong the only visible symptom is a 404 in a window with nothing on
    it -- and the cause is nearly always a route that lost a registration race
    or resolved to the wrong folder. This makes that a five-second check
    instead of a rebuild-and-hope.
    """
    try:
        lines = [
            f"web_root = {web}",
            f"web_root exists = {web.is_dir()}",
            f"app_dir  = {app_dir()}",
            f"state_dir = {state_dir()}",
            "",
        ]
        for r in fastapi_app.router.routes:
            lines.append(f"{type(r).__name__:10} {getattr(r, 'path', '?')}")
        (state_dir() / "desktop-routes.txt").write_text("\n".join(lines), encoding="utf-8")
    except OSError:
        pass


if __name__ == "__main__":
    # The built .exe runs without a console, so an uncaught exception would be
    # invisible: the user double-clicks, nothing happens, and there is no clue
    # why. Anything that escapes is written to the state folder and, where a
    # console exists, printed too.
    _log = state_dir() / "desktop-error.log"
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException:
        import traceback

        text = traceback.format_exc()
        try:
            _log.write_text(text, encoding="utf-8")
        except OSError:
            pass
        sys.stderr.write(text)
        raise SystemExit(1)
