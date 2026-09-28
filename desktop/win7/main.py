"""Launcher for the Windows 7 build.

Deliberately small, and deliberately separate from server.py: server.py knows how
to answer a rate, this knows how to start, tell the user where it is, and stop.

The one thing this build cannot do is put the page in its own window. There is
no WebView2 runtime for Windows 7, and pywebview's failure mode there is nasty:
it installs cleanly and then throws when asked to create a window, which is far
harder to diagnose than a missing import. So the page opens in the default
browser and a console window stays open to keep the program alive and to give
the user something to close.

State files
-----------
Writes the same four files the modern desktop build writes, to a writable folder
found the same way: the app folder if it can be written, else
%LOCALAPPDATA%\\ChakwalDC, else the temp folder. On a machine-wide install
Program Files is not writable by an ordinary user, and a program that cannot
record its own address is a program nobody can diagnose.
"""

from __future__ import annotations

import os
import sys
import time
import traceback
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
if not getattr(sys, "frozen", False):
    # Running from the source tree. The project root is two levels up, and both
    # govapi.py and desktop/win7/server.py have to be importable.
    sys.path.insert(0, os.path.dirname(HERE))
    sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))

import server as win7_server  # noqa: E402

APP_NAME = "ChakwalDC"
WEB_FOLDER = "web"


def app_dir() -> str:
    """The folder the program was installed into."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def state_dir() -> str:
    """A folder this process can actually write to.

    In that order:
      1. the app folder, if writable -- which is the case for a portable copy
         on the Desktop, and the right answer because everything then lives
         together;
      2. %LOCALAPPDATA%\\ChakwalDC -- the right answer for an ordinary user of a
         machine-wide install, since Program Files is read-protected for them;
      3. the temp folder, as a last resort so the program still runs and can
         still say where it is.

    The test is an actual write, not an os.access() check. os.access reports the
    permission bits, and on Windows it does not account for the fact that
    Program Files denies write access to ordinary users regardless of what the
    bits say -- and it reports success for an administrator on a folder the same
    administrator could not write to without elevation. Writing a file and
    deleting it is the only check that tells the truth.
    """
    for candidate in (
        app_dir(),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), APP_NAME),
        os.path.join(os.environ.get("TEMP", ""), APP_NAME),
    ):
        if not candidate:
            continue
        try:
            os.makedirs(candidate, exist_ok=True)
            probe = os.path.join(candidate, ".write-test")
            with open(probe, "w") as handle:
                handle.write("ok")
            os.remove(probe)
            return candidate
        except OSError:
            continue
    # Every candidate failed, which means the disk is full or locked. A
    # read-only temp folder is still better than refusing to start.
    return os.environ.get("TEMP", HERE)


def web_root() -> str:
    """Where index.html and app.js live.

    Under PyInstaller onedir the payload is in _internal, next to the exe. In the
    source tree it is desktop/web. Both are checked, and the existence check
    matters: a build that silently serves nothing looks exactly like a build
    whose server is broken.
    """
    for candidate in (
        os.path.join(HERE, WEB_FOLDER),
        os.path.join(app_dir(), "_internal", WEB_FOLDER),
        os.path.join(app_dir(), WEB_FOLDER),
    ):
        if os.path.isfile(os.path.join(candidate, "index.html")):
            return candidate
    raise RuntimeError("web assets not found; looked in {0}, {1}, {2}".format(
        os.path.join(HERE, WEB_FOLDER),
        os.path.join(app_dir(), "_internal", WEB_FOLDER),
        os.path.join(app_dir(), WEB_FOLDER),
    ))


def _log(state: str, message: str) -> None:
    """Append to the log in the state folder. Never let logging break the app."""
    try:
        with open(os.path.join(state, "desktop.log"), "a", encoding="utf-8") as handle:
            handle.write("{0}  {1}\n".format(time.strftime("%Y-%m-%d %H:%M:%S"), message))
    except OSError:
        pass


def _write_url(state: str, url: str) -> None:
    """Record the address, so a user can be told where the program is.

    The port is chosen by the OS, so it is different every run and cannot be
    written down in advance. This file is how the address gets discovered.
    """
    try:
        with open(os.path.join(state, "desktop-url.txt"), "w", encoding="utf-8") as handle:
            handle.write(url)
    except OSError:
        pass


def main() -> int:
    state = state_dir()
    started = time.time()
    _log(state, "start: python {0}, frozen={1}".format(
        sys.version.split()[0], bool(getattr(sys, "frozen", False))))
    _log(state, "  app_dir = {0}".format(app_dir()))
    _log(state, "  state_dir = {0}".format(state))

    try:
        root = web_root()
        _log(state, "  web_root = {0}".format(root))
    except RuntimeError as exc:
        _log(state, "  FATAL: {0}".format(exc))
        _crash(state, exc)
        sys.stderr.write("{0}\n".format(exc))
        return 2

    httpd = None
    portal = None
    try:
        httpd, _thread, portal, url = win7_server.serve(root)
        _write_url(state, url)
        _log(state, "listening on {0} after {1:.0f} ms".format(
            url, (time.time() - started) * 1000))
    except Exception as exc:  # noqa: BLE001
        _log(state, "  FATAL starting the server: {0}".format(exc))
        _crash(state, exc)
        sys.stderr.write("Could not start the local server: {0}\n".format(exc))
        return 3

    print("")
    print("  Chakwal DC Rate Calculator -- Windows 7 build")
    print("  ---------------------------------------------")
    print("  Open this address if the browser did not appear:")
    print("")
    print("      {0}".format(url))
    print("")
    print("  DC rates are read live from the official Punjab e-Stamp portal.")
    print("  Nothing is stored. Close this window to stop the program.")
    print("")

    try:
        webbrowser.open(url)
    except Exception as exc:  # noqa: BLE001 - the printed URL is the fallback
        _log(state, "  could not open a browser automatically: {0}".format(exc))

    # Nothing can detect the browser tab closing, so the program waits here. The
    # user closes this console window, or presses Ctrl+C, to stop it. Keeping the
    # process alive is the point: if it exited, the local server would go with it
    # and any rate still being fetched would be cut off.
    try:
        while True:
            time.sleep(0.5)
            if httpd is None:
                break
    except KeyboardInterrupt:
        print("")
        print("  Stopping.")
    finally:
        _log(state, "stopping")
        if httpd is not None:
            httpd.shutdown()
        if portal is not None:
            portal.stop()
    return 0


def _crash(state: str, exc: BaseException) -> None:
    """Record a failure where it can be found afterwards."""
    try:
        with open(os.path.join(state, "desktop-error.log"), "w", encoding="utf-8") as handle:
            handle.write("".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))
    except OSError:
        pass


if __name__ == "__main__":
    raise SystemExit(main())
