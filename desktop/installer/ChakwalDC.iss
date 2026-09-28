; Inno Setup script for the Chakwal DC Rate Calculator desktop app.
;
;   "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" desktop\installer\ChakwalDC.iss
;
; Produces dist\installer\ChakwalDC-Setup-1.0.0.exe -- a single file that
; installs the app, creates shortcuts, and uninstalls cleanly.
;
; What is packaged, and why it is not a single-file app:
;   The build is a PyInstaller *onedir*, ~44 MB with 400-odd files, and the
;   reason is start-up speed -- a onefile build unpacks the whole thing to a
;   temp folder on every launch, including the 6 MB of Khasra reference data
;   that makes the parcel lists work offline. Compression brings the installer
;   down to roughly a third of that, and the installed size is not the number
;   that matters for a program people launch many times a day.
;
; Why the app is installed to Program Files but does not write there:
;   Program Files is writable only by an installer running as administrator,
;   so an ordinary user cannot create a log or the file recording the port.
;   main.py therefore resolves a separate writable state folder under
;   %LOCALAPPDATA%. See UninstallDelete below, which cleans that folder up.

#define AppName        "Chakwal DC Rate Calculator"
#define AppShortName   "ChakwalDC"
#define AppVersion     "1.0.0"
#define AppExeName     "ChakwalDC.exe"
#define AppPublisher   "Chakwal DC Rate Calculator"

; Relative to this script, and that is correct for [Files]: Inno resolves source
; paths against the script's own folder at compile time. {src} would give an
; absolute path, but it is a script constant rather than a preprocessor token,
; so it does NOT expand inside a #define value -- it is passed through
; literally and the build is then "not found".
#define SourceRoot     "..\..\dist\ChakwalDC"
#define IconFile       "chakwal.ico"
#define LicenseFile_   "LICENSE.txt"
#define OutputDir      "..\..\dist\installer"
#define OutputBase     "ChakwalDC-Setup-1.0.0"

[Setup]
; AppId must never change once anything has been installed by this script: it
; is how a new Setup recognises an old install and offers to repair or remove it
; rather than installing a second copy alongside. Keep it stable for good.
;
; The DOUBLE braces are required, not a typo. Inno reads a single {GUID} as a
; constant expression and fails with 'Unknown constant "..."'. AppId is the one
; place a bare GUID is not written bare.
AppId={{A7D3E1F4-92B6-4C58-9D02-6E4A17B38C5F}}
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
; Restart Manager closes a running copy for us, which is more reliable than a
; lock file: it knows the actual process, so it also handles the case where the
; user launched the app from a shortcut in another folder.
CloseApplications=yes
RestartApplications=no
; A standard install. Elevated, because it writes to Program Files.
PrivilegesRequired=admin
; 64-bit only: the build is x64. x64compatible also admits ARM64, which can run
; x64 under emulation, so the installer does not need a separate ARM build.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Uninstallable=yes
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} -- value of a Khasra from the live DC rate
VersionInfoCopyright=Independent utility. Not affiliated with any government body.

[Languages]
; Default.isl, not Default.iso. Inno Setup 6.5 renamed the language file from
; .iso to .isl and this install ships only .isl; asking for .iso fails with
; "Couldn't open include file". Only English is wanted here, and the other 29
; translations in Languages\ are deliberately not offered.
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; \
    GroupDescription: "Shortcuts:"; Flags: checkedonce

[Files]
; The whole onedir build. recursesubdirs is NOT optional: a "*" wildcard in
; Source matches the files in that one folder and nothing below, so without
; this flag the installer ships ChakwalDC.exe and skips all 400 files of
; _internal\ -- an app that installs cleanly and then cannot start. The build
; was 407 files; a first attempt installed 4.
;
; The four excluded names are run-time artefacts left over from testing the
; portable copy. They must not be baked into an install, and shipping a stale
; desktop-url.txt would point a first-run user at a port that no longer exists.
Source: "{#SourceRoot}\*"; DestDir: "{app}"; \
    Flags: recursesubdirs; \
    Excludes: "desktop-url.txt, desktop-routes.txt, desktop.log, desktop-error.log"
Source: "{#LicenseFile_}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; \
    WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName}"; \
    WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Four specific files, inside {app}, and nothing else.
;
; main.py resolves a writable "state folder" at run time: the app folder if it
; can write there, else %LOCALAPPDATA%\ChakwalDC. For an ordinary user on a
; machine-wide install, Program Files is read-protected, so the state folder is
; in their own profile and Inno has no business touching it. For an ADMINISTRATOR,
; however, Program Files *is* writable, so the state folder lands in {app} itself
; and those four files are created after installation, which means Inno never
; knew about them and left them behind on uninstall. Naming them explicitly
; closes that gap, and it is checked by the end-to-end test.
;
; Note what is NOT here, and must not be: {localappdata}\ChakwalDC. This setup
; runs elevated, and when it does, {localappdata} expands to the
; *administrator's* profile rather than that of whoever will actually use the
; app. A delete against it would either miss the folder in use, or remove a
; same-named folder belonging to a different account. ISCC warns about exactly
; that pairing.
Type: files; Name: "{app}\desktop-url.txt"
Type: files; Name: "{app}\desktop-routes.txt"
Type: files; Name: "{app}\desktop.log"
Type: files; Name: "{app}\desktop-error.log"

; There is no "is the build present?" guard in the [Code] below, and there used
; to be. Inno already refuses to compile a [Files] entry that matches nothing --
; "No files found matching "...\dist\ChakwalDC\*" -- which is the right place
; and the right moment to notice, and it names the exact pattern that came up
; empty.
;
; The guard that was here before was worse than useless, in two ways that only
; installing could have found. Its DirExists() took a RELATIVE path, which Inno
; resolves against the installer's working directory rather than this script's
; folder, so it evaluated false and aborted every single install with exit code
; 1. And its ExpandConstant() call nested two defines, which ISCC 6.7.3 rejects
; as a Type Mismatch. Both compiled cleanly; only running the installer showed
; either. Reading the installer's /LOG output is what actually diagnosed them.
;
; There is also no 32-bit guard. It cannot fire: the installer is x64, so on a
; 32-bit Windows it never starts, and ArchitecturesAllowed makes Inno refuse it
; before this file is compiled into anything that runs.
;
; These notes live above the section tag because of two more ISCC 6.7.3 quirks,
; each of which cost a compile:
;   - a ";" comment cannot be the first line of a [Code] section, nor sit at the
;     top level between two procedures: the reader wants a declaration and fails
;     with "'BEGIN' expected". A leading blank line does not help.
;   - CurStepChanged must be a procedure. The "function ...: Boolean" form the
;     documentation shows is rejected with "Invalid prototype"; the procedure
;     form is what Inno's own shipped CodeExample1.iss uses.
; Above the section tag these are ordinary script comments, and a comment inside
; a procedure body is fine.
[Code]
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and not WizardSilent then
  begin
    // Only the install folder is named here, and that one is unambiguous. The
    // run-time state folder is deliberately NOT named: this setup is elevated
    // (PrivilegesRequired=admin), and when it elevates, {localappdata} is the
    // *administrator's* profile rather than the profile of whoever will actually
    // use the app. So the installer cannot know the right path, and printing
    // the wrong one is worse than not printing one. ISCC warns about exactly
    // this combination.
    MsgBox('Installed to:' + #13#10 + ExpandConstant('{app}') + #13#10 + #13#10 +
           'The program opens in its own window. Live DC rates are read from the' + #13#10 +
           'Punjab e-Stamp portal, so it needs an internet connection.' + #13#10 + #13#10 +
           'Logs are written to the Local AppData folder of the account you run' + #13#10 +
           'it under, in a subfolder named ChakwalDC.',
           mbInformation, MB_OK);
  end;
end;
