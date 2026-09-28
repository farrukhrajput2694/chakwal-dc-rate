# End-to-end test of the installer: desktop\installer\test-install.ps1
#
#   powershell -ExecutionPolicy Bypass -NoProfile -File desktop\installer\test-install.ps1
#
# Instals the built Setup silently, checks what landed, launches the app FROM
# THE INSTALL FOLDER, drives a real rate lookup through it, then uninstalls
# silently and checks that nothing was left behind.
#
# The rate lookup is the point. An installer can copy 400 files perfectly and
# still ship a program that cannot answer a question, so the run is only counted
# as a pass if the installed app returns the one rate whose correct value is
# already known: Khasra 947, Alawal, Agricultural, Link Road = Rs. 366,025 per
# Acre, and 3.5 Kanal of it = Rs. 160,135.9375.

$ErrorActionPreference = 'Stop'

# The project root, two levels up from this script (desktop\installer -> root).
# Anchored to $PSScriptRoot rather than a chain of Split-Path -Parent on the
# script path, which walked one level too far and pointed at ...\Desktop.
$Root      = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$SetupExe  = Join-Path $Root 'dist\installer\ChakwalDC-Setup-1.0.0.exe'
$AppDir    = Join-Path $env:ProgramFiles 'Chakwal DC Rate Calculator'
$StateDir  = Join-Path $env:LOCALAPPDATA 'ChakwalDC'
$StartMenu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Chakwal DC Rate Calculator'
$Desktop   = [Environment]::GetFolderPath('Desktop')

# 3.5 Kanal x 20 (Kanal per Acre, the 8 variant) x 272 (sqft per Marla) = 19,040 sqft
$ExpectedTotal = 366025.0 * 3.5 / 8

$pass = 0; $fail = 0; $skip = 0
function Check($name, $ok, $detail) {
  if ($ok) { $script:pass++; "  [PASS] $name  $detail" }
  else     { $script:fail++; "  [FAIL] $name  $detail" }
}
function Skip($name, $why) { $script:skip++; "  [SKIP] $name  $why" }

Write-Host ""
Write-Host "=== 0. preconditions ===" -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath $SetupExe)) { throw "No installer at $SetupExe" }
"  installer : {0:N0} bytes" -f (Get-Item -LiteralPath $SetupExe).Length

# Start from a clean machine so a pass cannot be inherited from a previous run.
foreach ($d in @($AppDir, $StateDir)) {
  if (Test-Path -LiteralPath $d) {
    $u = Get-ChildItem -LiteralPath $d -Filter 'unins*.exe' -ErrorAction SilentlyContinue
    if ($u) { "  (removing a previous install first)"; Start-Process $u[0].FullName -Wait -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES' }
    Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ""
Write-Host "=== 1. silent install ===" -ForegroundColor Cyan
$p = Start-Process -FilePath $SetupExe -Wait -PassThru -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART'
Check "installer exit code" ($p.ExitCode -eq 0) ("got " + $p.ExitCode)
if ($p.ExitCode -ne 0) { throw "Install failed with $($p.ExitCode)" }

Write-Host ""
Write-Host "=== 2. what landed on disk ===" -ForegroundColor Cyan
Check "app folder exists" (Test-Path -LiteralPath $AppDir) $AppDir
$exe = Join-Path $AppDir 'ChakwalDC.exe'
Check "exe present" (Test-Path -LiteralPath $exe) ("{0:N0} bytes" -f (Get-Item -LiteralPath $exe -ErrorAction SilentlyContinue).Length)
$unins = Get-ChildItem -LiteralPath $AppDir -Filter 'unins*.exe' -ErrorAction SilentlyContinue
Check "uninstaller present" ($unins.Count -gt 0) ($(if ($unins) { $unins[0].Name } else { 'none' }))

$files = Get-ChildItem -LiteralPath $AppDir -Recurse -File -ErrorAction SilentlyContinue
$srcFiles = Get-ChildItem -LiteralPath (Join-Path $Root 'dist\ChakwalDC') -Recurse -File
"  installed {0} files, {1:N0} bytes" -f $files.Count, ($files | Measure-Object Length -Sum).Sum
Check "file count matches the build" ($files.Count -ge ($srcFiles.Count - 4)) `
      ("build has " + $srcFiles.Count + "; 4 runtime artefacts are excluded by design")

# Recorded, not asserted. This Inno Setup install (the per-user winget package)
# ships no Setup.e64 template, so ISCC compiles a 32-bit setup binary no matter
# what ArchitecturesInstallIn64BitMode says -- the choice is silently ignored.
# That is worth knowing but is not a defect in the install: the 64-bit loader
# still runs, and the checks below confirm the consequences are all correct --
# the app lands in the real Program Files, and the uninstall registry entry is
# written to the 64-bit view, not Wow6432Node. Only the uninstaller executable
# is 32-bit, and a 32-bit process reads C:\Program Files without redirection,
# so it uninstalls correctly. Turning this into an assertion would make the
# test fail over something that cannot be fixed from the script.
if ($unins) {
  $mb = [System.IO.File]::ReadAllBytes($unins[0].FullName)
  $peOff = [BitConverter]::ToInt32($mb, 0x3C)
  $machine = [BitConverter]::ToUInt16($mb, $peOff + 4)
  $arch = switch ($machine) { 0x8664 { 'x64' } 0x14c { 'x86' } 0xAA64 { 'ARM64' } default { "0x{0:X}" -f $machine } }
  "  [note] uninstaller architecture: $arch (see comment in the script)"
}

# The decisive check is where the install actually landed, and which registry
# view the uninstall entry went into. Both must be the 64-bit ones.
$unreg = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
$reg64 = Get-ChildItem $unreg -ErrorAction SilentlyContinue | Where-Object {
  (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DisplayName -like '*Chakwal*' }
$reg32 = Get-ChildItem 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | Where-Object {
  (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DisplayName -like '*Chakwal*' }
Check "uninstall entry in the 64-bit registry view" ($reg64.Count -ge 1) $(if ($reg64) { (Get-ItemProperty $reg64[0].PSPath).InstallLocation } else { 'not found' })
Check "nothing leaked into the 32-bit view" ($reg32.Count -eq 0) $(if ($reg32) { "$($reg32.Count) stray key(s)" } else { 'clean' })
Check "installed under the real Program Files" $AppDir.StartsWith($env:ProgramFiles) $AppDir

# The four runtime files from testing the portable copy must NOT be installed.
foreach ($stale in @('desktop-url.txt','desktop-routes.txt','desktop.log','desktop-error.log')) {
  Check "no stale $stale" (-not (Test-Path -LiteralPath (Join-Path $AppDir $stale))) ""
}
Check "web assets installed" (Test-Path -LiteralPath (Join-Path $AppDir '_internal\web\index.html')) ""
Check "LICENSE installed"   (Test-Path -LiteralPath (Join-Path $AppDir 'LICENSE.txt')) ""

Write-Host ""
Write-Host "=== 3. shortcuts ===" -ForegroundColor Cyan
Check "Start Menu entry" (Test-Path -LiteralPath (Join-Path $StartMenu 'Chakwal DC Rate Calculator.lnk')) ""
Check "Start Menu uninstall entry" (Test-Path -LiteralPath (Join-Path $StartMenu 'Uninstall Chakwal DC Rate Calculator.lnk')) ""

# {autodesktop} and {group} both expand to the *common* (all-users) locations
# because this setup is elevated -- C:\Users\Public\Desktop and the ProgramData
# Start Menu. That is consistent with an install that lives in Program Files and
# is available to every user of the machine, and on a single-user PC the Public
# Desktop is the folder the user actually sees. Both are checked so that a
# change of either is noticed, whichever way it goes.
$lnkName = 'Chakwal DC Rate Calculator.lnk'
$publicLnk = Join-Path $env:PUBLIC "Desktop\$lnkName"
$userLnk   = Join-Path $Desktop $lnkName
$foundLnk = $null
foreach ($cand in @($publicLnk, $userLnk)) {
  if (Test-Path -LiteralPath $cand) { $foundLnk = $cand; break }
}
Check "desktop shortcut" ($foundLnk -ne $null) $(if ($foundLnk) { $foundLnk.Replace($env:USERPROFILE, '%USERPROFILE%') } else { "not in Public Desktop or Desktop" })
# The desktop shortcut is a task, so confirm the wizard's default really is on
# and that it points at the installed copy rather than at the build folder.
if ($foundLnk) {
  $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($foundLnk)
  Check "desktop shortcut points at the installed exe" ($sc.TargetPath -eq $exe) $sc.TargetPath
}

Write-Host ""
Write-Host "=== 4. run the INSTALLED app ===" -ForegroundColor Cyan
$sw = [Diagnostics.Stopwatch]::StartNew()
$app = Start-Process -FilePath $exe -PassThru
$url = $null
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  foreach ($d in @($AppDir, $StateDir)) {
    $f = Join-Path $d 'desktop-url.txt'
    if (Test-Path -LiteralPath $f) {
      $c = (Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue).Trim()
      if ($c) { $url = $c; break }
    }
  }
  if ($url) { break }
  Start-Sleep -Milliseconds 250
}
$sw.Stop()
if (-not $url) { throw "The installed app never wrote desktop-url.txt (looked in the app folder and $StateDir)" }
Check "app started and reported its address" $true ("$url in " + $sw.ElapsedMilliseconds + " ms")

# Record which state folder the app actually chose, once, and reuse it. Whether
# %LOCALAPPDATA% is used at all depends on the session: an elevated session can
# write to Program Files, so main.py takes the app folder. Every later check has
# to key off this, otherwise it asserts about a folder that was never created.
$StateInUse = if (Test-Path -LiteralPath (Join-Path $StateDir 'desktop-url.txt')) { $StateDir } else { $AppDir }
"  state folder in use : $StateInUse" + $(if ($StateInUse -eq $AppDir) { '  (writable: this is an admin session)' } else { '' })
$routes = Join-Path $StateInUse 'desktop-routes.txt'
if (Test-Path -LiteralPath $routes) {
  "  --- desktop-routes.txt ---"
  Get-Content -LiteralPath $routes | ForEach-Object { "    $_" }
}
$errlog = Join-Path $StateInUse 'desktop-error.log'
Check "no crash log" (-not (Test-Path -LiteralPath $errlog)) $(if (Test-Path -LiteralPath $errlog) { (Get-Content $errlog -Raw) } else { '' })

Write-Host ""
Write-Host "=== 5. a real rate lookup, through the installed app ===" -ForegroundColor Cyan
$body = @{
  land_type = 'rural'; path = 'khasra'
  district_id = 21; tehsil_id = 75
  mouza_id = 11376; mouza_name = 'Alawal'
  qanoongo_id = 507
  land_classification_id = 1; land_classification_name = 'Agricultural'
  location = 'Link Road'
  khasra_no = '947'
  area = 3.5; area_unit = 'Kanal'
} | ConvertTo-Json

# The portal is a third-party government service and is genuinely flaky: the
# same request has succeeded and then failed with "Could not reach the official
# portal" minutes apart. So retry, and if it stays down, record that as SKIP
# rather than FAIL -- the installer is not what broke -- and carry on to the
# uninstall phase. Letting the exception escape aborted the test half way,
# which both mislabelled a good installer as broken and left the app installed.
$resp = $null; $portalErr = $null
for ($try = 1; $try -le 4; $try++) {
  $sw2 = [Diagnostics.Stopwatch]::StartNew()
  try {
    $resp = Invoke-RestMethod -Uri ($url + 'api/rate') -Method Post -Body $body `
            -ContentType 'application/json' -TimeoutSec 90 -ErrorAction Stop
    $sw2.Stop()
    "  attempt $try succeeded in " + $sw2.ElapsedMilliseconds + " ms"
    break
  } catch {
    $sw2.Stop()
    $portalErr = $_.ErrorDetails.Message
    "  attempt $try failed after " + $sw2.ElapsedMilliseconds + " ms: $portalErr"
    Start-Sleep -Seconds (3 * $try)
  }
}

# The response nests the figure, it is not a bare number. $resp.rate is an OBJECT
# carrying {found, rate, rate_string, unit, per_sqft}, and the computed total
# lives under $resp.value. Casting $resp.rate itself to [double] throws a
# PSInvalidCast, which is how this test first "proved" a working app had no rate.
$skip = 0
if ($null -eq $resp) {
  "  [SKIP] portal unreachable on all 4 attempts, so the 4 rate checks below could not run."
  "         The app did the right thing by saying so instead of inventing a rate."
  "         Nothing here indicts the installer; re-run when the portal is back."
  foreach ($n in @('portal reports a published rate','rate is the known Rs. 366,025/Acre','unit is per Acre','total is the known Rs. 160,135.9375')) { Skip $n 'portal unreachable' }
} else {
  "  response: " + ($resp | ConvertTo-Json -Depth 5 -Compress)
  if ($resp.value) { "  --- computed value ---"; $resp.value | ConvertTo-Json -Depth 5 | ForEach-Object { "    $_" } }

  $rate = $null
  if ($resp.rate -and $resp.rate.found) { $rate = [double]$resp.rate.rate }
  Check "portal reports a published rate" ($rate -ne $null) `
        $(if ($rate) { "Rs. {0} per {1}" -f $rate, $resp.rate.unit } else { "none; portal said: $($resp.rate.note)" })
  Check "rate is the known Rs. 366,025/Acre" ($rate -eq 366025) $(if ($rate) { "got $rate" } else { 'n/a' })
  Check "unit is per Acre" ($resp.rate.unit -match 'acre') ("got '" + $resp.rate.unit + "'")

  $total = $null
  if ($resp.value -and $resp.value.total -ne $null) { $total = [double]$resp.value.total }
  Check "total is the known Rs. 160,135.9375" ($total -eq $ExpectedTotal) `
        ("expected $ExpectedTotal, got " + $(if ($total -ne $null) { $total } else { 'n/a' }))
}

Write-Host ""
Write-Host "=== 6. the page itself ===" -ForegroundColor Cyan
$page = Invoke-WebRequest -Uri ($url) -UseBasicParsing -TimeoutSec 30
Check "index served" ($page.StatusCode -eq 200) ("HTTP " + $page.StatusCode)
Check "no rate input in the page" ($page.Content -notmatch 'id="rate-input"') "the rate is read-only, so it must have no field to type in"
$js = Invoke-WebRequest -Uri ($url + 'static/app.js') -UseBasicParsing -TimeoutSec 30
Check "app.js served" ($js.StatusCode -eq 200) ("{0:N0} bytes" -f $js.RawContentLength)

Write-Host ""
Write-Host "=== 7. close the app ===" -ForegroundColor Cyan
Get-Process -Name 'ChakwalDC' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Check "process gone" (-not (Get-Process -Name 'ChakwalDC' -ErrorAction SilentlyContinue)) ""

Write-Host ""
Write-Host "=== 8. silent uninstall ===" -ForegroundColor Cyan
$u = Get-ChildItem -LiteralPath $AppDir -Filter 'unins*.exe' -ErrorAction SilentlyContinue
if (-not $u) { throw "No uninstaller found" }
$p2 = Start-Process -FilePath $u[0].FullName -Wait -PassThru -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES'
Check "uninstaller exit code" ($p2.ExitCode -eq 0) ("got " + $p2.ExitCode)

# Inno leaves the folder only if something held a file open; give it a moment.
$gone = $false
for ($i = 0; $i -lt 20; $i++) {
  if (-not (Test-Path -LiteralPath $AppDir)) { $gone = $true; break }
  Start-Sleep -Milliseconds 500
}
Check "app folder removed" $gone $(if (Test-Path -LiteralPath $AppDir) { "still there: " + (Get-ChildItem -LiteralPath $AppDir -Recurse -File -ErrorAction SilentlyContinue).Count + " files" } else { '' })
# The state folder is expected to SURVIVE, on purpose -- but only when it is a
# separate folder. In this admin test run Program Files IS writable, so the app
# resolved its state folder to {app} itself, and it is then removed with
# everything else. The case that matters, a standard user's
# %LOCALAPPDATA%\ChakwalDC, cannot be exercised from an elevated session: the
# test never gets to impersonate an unelevated user, so this is documented
# rather than proven here. It is covered by the unit tests in desktop/main.py.
if ($StateInUse -eq $AppDir) {
  # The app folder was writable, so the state folder IS {app} and it goes away
  # with everything else. The four files are checked individually further down.
  "  [note] state folder resolved to {app}, so it is uninstalled along with it"
  Check "state folder handled correctly" (-not (Test-Path -LiteralPath $StateInUse)) 'removed with the app folder'
} else {
  # The case that matters: an ordinary user on a machine-wide install cannot
  # write to Program Files, so the state folder is %LOCALAPPDATA%\ChakwalDC and
  # an elevated uninstaller must NOT touch it. When it expands to the
  # administrator's own profile instead of the user's, it is a different
  # account's folder and deleting it would be wrong. This branch cannot be
  # reached from an elevated test session, so it is a guard for the case, not
  # proof of it; the real coverage is the unit tests for state_dir() in
  # desktop/main.py.
  $leftState = Test-Path -LiteralPath $StateInUse
  Check "state folder deliberately kept" $leftState `
        $(if ($leftState) { (Get-ChildItem -LiteralPath $StateInUse -File | Measure-Object).Count.ToString() + " small file(s) left in the user's own profile" } else { 'it was deleted' })
}
Check "Start Menu group removed" (-not (Test-Path -LiteralPath $StartMenu)) ""
# Both Desktop candidates, because the shortcut may have been created in either.
$stillLnk = @($publicLnk, $userLnk) | Where-Object { Test-Path -LiteralPath $_ }
Check "desktop shortcut removed" ($stillLnk.Count -eq 0) `
      $(if ($stillLnk.Count) { "left behind: " + ($stillLnk -join ', ') } else { '' })
$left = Get-ChildItem -Path (Join-Path $env:ProgramFiles 'Chakwal*') -ErrorAction SilentlyContinue
Check "nothing left in Program Files" (-not $left) ""

# The four [UninstallDelete] files. In this admin test run the state folder IS
# {app}, so the app wrote them there at start-up and the uninstaller has to
# remove them. For a standard user they would live in %LOCALAPPDATA% instead and
# this check is vacuously satisfied, which is the correct outcome.
$stateFilesLeft = @()
foreach ($f in @('desktop-url.txt','desktop-routes.txt','desktop.log','desktop-error.log')) {
  if (Test-Path -LiteralPath (Join-Path $AppDir $f)) { $stateFilesLeft += $f }
}
Check "runtime files written into {app} were cleaned up" ($stateFilesLeft.Count -eq 0) `
      $(if ($stateFilesLeft.Count) { "left: " + ($stateFilesLeft -join ', ') } else { '' })

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ("  passed: {0}   failed: {1}   skipped: {2}" -f $pass, $fail, $skip) -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "================================================" -ForegroundColor Cyan
# A run with skips is NOT a clean pass, even though nothing failed. Exit 2 keeps
# it distinguishable from both "everything verified" (0) and "something is
# broken" (1), so a script wrapping this test cannot mistake a portal outage
# for a verified install.
if ($fail -gt 0) { exit 1 }
if ($skip -gt 0) { exit 2 }
exit 0
