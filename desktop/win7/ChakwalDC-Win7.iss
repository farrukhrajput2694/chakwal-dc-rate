; Inno Setup script for the Windows 7 build of the Chakwal DC Rate Calculator.
;
;   "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" desktop\win7\ChakwalDC-Win7.iss
;
; Produces dist\installer\ChakwalDC-Win7-Setup-1.0.0.exe
;
; What is different from the normal installer, and why
; ---------------------------------------------------
; 1. It installs the Microsoft Visual C++ runtime first. This is not optional.
;    The build is CPython 3.8, and python38.dll, _ssl.pyd, _socket.pyd and
;    select.pyd all import VCRUNTIME140.dll and the api-ms-win-crt-*.dll family.
;    (Verified by reading the PE import tables of the actual build, not assumed.)
;    Windows 10 has both in System32. Windows 7 has neither on a clean machine,
;    so without this step the app fails to start with a missing-DLL error before
;    it can show anything at all. Microsoft's own signed redistributable is run
;    quietly; if it is already present it is a no-op.
;
; 2. MinVersion=6.1sp1. The build links against the Windows 7 API set. On
;    anything older it should not be offered, and Inno will say so plainly.
;
; 3. A different AppId from the modern installer. They are different programs --
;    one opens a window, this one opens a browser -- and a shared AppId would let
;    one uninstall the other, which is exactly the sort of surprise nobody wants.
;
; What is NOT different: the app, the portal calls, the arithmetic, the LICENSE,
; and the state's honesty. govapi.py is the same file the hosted site uses, and
; desktop/win7/test-server.py checks the Win7 server's decisions against the
; FastAPI build's on 29 shared cases.

#define AppName        "Chakwal DC Rate Calculator (Windows 7)"
#define AppShortName   "ChakwalDC-Win7"
#define AppVersion     "1.0.0"
#define AppExeName     "ChakwalDC.exe"
#define AppPublisher   "Chakwal DC Rate Calculator"

; Relative to this script. See the note in desktop\installer\ChakwalDC.iss about
; why {src} is not used inside a #define: it is a script constant, not a
; preprocessor token, so it does not expand and is passed through literally.
#define SourceRoot     "..\..\dist\ChakwalDC-win7"
#define LicenseFile_   "..\installer\LICENSE.txt"
#define IconFile       "..\installer\chakwal.ico"
#define VCRedistFile   "prereq\vc_redist.x64.exe"
#define OutputDir      "..\..\dist\installer"
#define OutputBase     "ChakwalDC-Win7-Setup-1.0.0"

[Setup]
; A NEW GUID, different from the modern installer's on purpose. See note 3 above.
AppId={{C4B8E2A1-7D53-4F16-9A0B-2E5C81D47A93}}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=no
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBase}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\{#AppExeName}
LicenseFile={#LicenseFile_}
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Uninstallable=yes
; Windows 7 SP1 and later only. This is the build's floor: the CRT it needs and
; the Python it embeds both stop working before that.
MinVersion=6.1sp1
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} -- value of a Khasra from the live DC rate
VersionInfoCopyright=Independent utility. Not affiliated with any government body.

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; \
    GroupDescription: "Shortcuts:"; Flags: checkedonce

[Files]
; recursesubdirs is required, not optional: a bare "*" matches only the files in
; that one folder, so without it the app installs with no Python runtime and no
; web assets and then cannot start.
;
; Excluded are the run-time artefacts of testing the portable build. A stale
; desktop-url.txt would point a first-run user at a port that no longer exists.
Source: "{#SourceRoot}\*"; DestDir: "{app}"; \
    Flags: recursesubdirs; \
    Excludes: "desktop-url.txt, desktop-routes.txt, desktop.log, desktop-error.log"
Source: "{#LicenseFile_}"; DestDir: "{app}"; Flags: ignoreversion

; The VC++ runtime, unpacked to a temp folder and run from [Run] rather than
; installed into {app}. Keeping it out of the program folder is the point: it is
; a shared, Microsoft-signed, system-wide component, and the modern installer
; deliberately does not bundle it either.
Source: "{#VCRedistFile}"; DestDir: "{tmp}"; Flags: deleteafterinstall

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; \
    WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; The runtime first, and its result is checked. A missing VCRUNTIME140.dll shows
; up as an application that silently does nothing, and "it just doesn't open"
; is a support call nobody can resolve, so this failure is made loud here where
; it can still be explained. 3010 is Microsoft's success-with-reboot-required
; code and must not be treated as an error.
Filename: "{tmp}\vc_redist.x64.exe"; \
    Parameters: "/install /quiet /norestart"; \
    StatusMsg: "Installing the Microsoft Visual C++ runtime, which Windows 7 does not include..."; \
    Flags: runhidden waituntilterminated

Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName}"; \
    WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; The same four files, and for the same reason as the modern installer: an
; administrator's Program Files *is* writable, so the state folder lands in {app}
; and those files are created after install.
;
; %LOCALAPPDATA%\ChakwalDC is deliberately NOT deleted. This setup is elevated,
; so {localappdata} would expand to the *administrator's* profile, not that of
; the person who will use the app -- it would either miss the folder in use or
; delete another account's. A few kilobytes of the user's own log is the right
; thing to leave behind.
Type: files; Name: "{app}\desktop-url.txt"
Type: files; Name: "{app}\desktop-routes.txt"
Type: files; Name: "{app}\desktop.log"
Type: files; Name: "{app}\desktop-error.log"

; A comment cannot be the first line of a [Code] section, nor sit at the top
; level between two procedures -- the reader wants a declaration and fails with
; "'BEGIN' expected". This note therefore sits above the section tag.
;
; What it checks, and what it does not.
;
; It checks two things, because python38.dll imports two separate families:
;
;   VCRUNTIME140.dll   the Visual C++ runtime proper
;   ucrtbase.dll       the Universal C Runtime, which is what actually backs the
;                      12 api-ms-win-crt-*.dll names python38.dll imports
;
; The second check was added because the first one alone let a real failure
; through. python38.dll imports api-ms-win-crt-conio, -convert, -environment,
; -filesystem, -heap, -locale, -math, -process, -runtime, -stdio, -string and
; -time. Without those the interpreter cannot be loaded at all, and the failure
; is a hard load error raised BEFORE any of this program's Python runs, which
; means there is nowhere in Python to detect it, report it, or recover from it.
; The user would get a bare "python38.dll could not be loaded" dialog with no
; hint about the missing update. Catching it here, where a message can still be
; printed, is the difference between a fixable error and a mystery.
;
; What it still cannot check: that the api-ms-win-crt-*.dll forwarder stubs
; themselves are registered with the loader's apiset schema. There is no file
; to look for -- on Windows 10 they are not files at all, which is why they
; cannot be bundled into a portable build the way VCRUNTIME140.dll can. Run
; Windows Update once on the target machine and the question is settled.
; README.md says so, and the build stays labelled unverified until it has been
; installed on a real Windows 7 machine.
[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  SysDir: String;
begin
  if CurStep = ssPostInstall then
  begin
    SysDir := GetSystemDir;
    if not FileExists(ExpandConstant('{sys}\ucrtbase.dll')) then
    begin
      MsgBox('The Universal C Runtime was not installed.' + #13#10 + #13#10 +
             'This is the second half of what Windows 7 is missing, and the' + #13#10 +
             'half that matters most here: the Python interpreter in this' + #13#10 +
             'program cannot load without it.' + #13#10 + #13#10 +
             'Run Windows Update until it reports no further updates, then' + #13#10 +
             'run this installer again. Update KB2999226 is the one that' + #13#10 +
             'carries this runtime.',
             mbError, MB_OK);
    end;
    if not FileExists(ExpandConstant('{sys}\VCRUNTIME140.dll')) then
    begin
      MsgBox('The Microsoft Visual C++ runtime was not installed.' + #13#10 + #13#10 +
             'Windows 7 does not include it, and this program needs it to start.' + #13#10 + #13#10 +
             'Install it manually, then run this installer again:' + #13#10 + #13#10 +
             '  https://aka.ms/vs/17/release/vc_redist.x64.exe' + #13#10 + #13#10 +
             'Windows 7 may also need update KB2999226, which carries the' + #13#10 +
             'Universal C Runtime. Installing Windows Update first is the' + #13#10 +
             'simplest way to be sure.',
             mbError, MB_OK);
    end
    else if not WizardSilent then
    begin
      // Only {app} is named here. {localappdata} would be the *administrator's*
      // profile while this setup is elevated, so printing it would be wrong as
      // often as right.
      MsgBox('Installed to:' + #13#10 + ExpandConstant('{app}') + #13#10 + #13#10 +
             'This build has no window of its own, because Windows 7 has no' + #13#10 +
             'WebView2 runtime. It opens the calculator in your default' + #13#10 +
             'browser, and a console window stays open to keep it running.' + #13#10 + #13#10 +
             'It needs Chrome 109, Firefox 115 or Edge 109. Internet Explorer' + #13#10 +
             'cannot run the page, and the program will say so if you try.' + #13#10 + #13#10 +
             'Live DC rates are read from the Punjab e-Stamp portal, so it' + #13#10 +
             'needs an internet connection.',
             mbInformation, MB_OK);
    end;
  end;
end;
