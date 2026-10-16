# zaptill-update.ps1 - A509: applies a downloaded ZapTill update with administrator rights, safely.
#
# Run ONLY by the "ZapTill Updater" scheduled task (registered by build/installer.nsh): as SYSTEM, highest privileges,
# no trigger, started on demand by the app (schtasks /Run), with NO arguments. The task's security descriptor lets a
# signed-in Windows user RUN it, never change it. This file lives in "%ProgramFiles%\ZapTill Updater" - only
# administrators can write there - and the installer writes it straight from its own payload.
#
# Everything the app gives it is UNTRUSTED: request\update-request.json (written by the app, as the user) says
# { id, version, installerPath, relaunch }. This script:
#   1. checks the request (a plain version, a local file path) and refuses a version not newer than the one installed
#      (read from the installed ZapTill.exe, never from the request) - no downgrades, no re-installs;
#   2. reads that version's latest.yml over HTTPS from ZapTill's official release location (hard-coded below), with
#      certificate checks on, TLS 1.2+;
#   3. copies the installer into work\ (SYSTEM and Administrators only, made afresh on every run) and hashes ONLY that
#      copy: SHA-512 and size must equal latest.yml's - a file swapped after the copy changes nothing;
#   4. tells the app it is ready (updater-status.json), waits for ZapTill to close, runs the COPY silently
#      ("--updated /S", what electron-updater passes for a silent update - never --force-run, which would start ZapTill
#      as SYSTEM), and starts ZapTill again in the user's session through the "ZapTill Relaunch" task.
# Anything off: one plain sentence in updater.log, a non-zero exit, nothing run. The app then installs when ZapTill is
# closed, as before (src/main/autoUpdate.ts).
#
# TEST MODE (-TestRoot, with -TestFeedFile and -TestInstalledVersion): used by test/updater-task-a509.test.mjs only. It
# reads latest.yml from a local file, uses folders under -TestRoot, never runs an installer (it writes what it would run
# to would-run.json) and never starts the relaunch task. It cannot be reached through the task: the task's action is
# fixed (only administrators may change it) and passes no arguments; and the script refuses test mode when it runs as
# SYSTEM. Nothing here reads an environment variable a user could set.
param(
  [string]$TestRoot = '',
  [string]$TestFeedFile = '',
  [string]$TestInstalledVersion = '',
  [string]$TestSwapWith = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2

# The official release location (electron-builder.config.js publish: github oweyahillary/swiftpos; tags are v<version>).
$FeedBase = 'https://github.com/oweyahillary/swiftpos/releases/download'
$AllowedHosts = @('github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com')
$RelaunchTask = 'ZapTill Relaunch'
$MaxLogBytes = 256KB

$Test = $TestRoot -ne ''
$Base = if ($Test) { $TestRoot } else { $PSScriptRoot }
$LogFile = Join-Path $Base 'updater.log'
$StatusFile = Join-Path $Base 'updater-status.json'
$RequestFile = Join-Path (Join-Path $Base 'request') 'update-request.json'
$Work = Join-Path $Base 'work'
$RequestId = ''
$ReadySent = $false
$relaunch = $false

function Write-Log([string]$line) {
  try {
    if ((Test-Path -LiteralPath $LogFile) -and ((Get-Item -LiteralPath $LogFile).Length -gt $MaxLogBytes)) {
      $keep = Get-Content -LiteralPath $LogFile -Tail 400
      Set-Content -LiteralPath $LogFile -Value $keep -Encoding UTF8
    }
    $stamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    Add-Content -LiteralPath $LogFile -Value ($stamp + '  ' + $line) -Encoding UTF8
  } catch { }
}

function Write-Status([string]$state, [string]$reason, [string]$version) {
  try {
    $o = [ordered]@{ id = $RequestId; state = $state; version = $version; reason = $reason; at = [DateTime]::UtcNow.ToString('o') }
    Set-Content -LiteralPath $StatusFile -Value ($o | ConvertTo-Json -Compress) -Encoding UTF8
  } catch { }
}

function Stop-Refused([string]$reason, [string]$version, [int]$code) {
  Write-Log ('refused: ' + $reason + ' - nothing was installed; ZapTill installs the update when it is next closed.')
  Write-Status 'refused' $reason $version
  exit $code
}

function Get-Field($obj, [string]$name) {
  if ($null -eq $obj -or $obj -isnot [System.Management.Automation.PSCustomObject]) { return $null }
  $p = $obj.PSObject.Properties[$name]
  if ($null -eq $p) { return $null }
  return $p.Value
}

function Parse-Version([string]$v) {
  if ($v -notmatch '^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$') { return $null }
  return [int[]]@([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
}

function Compare-Version([int[]]$a, [int[]]$b) {
  for ($i = 0; $i -lt 3; $i++) { if ($a[$i] -ne $b[$i]) { if ($a[$i] -lt $b[$i]) { return -1 } else { return 1 } } }
  return 0
}

# SIDs trusted to write where this script and ZapTill live: SYSTEM, Administrators, TrustedInstaller.
$TrustedSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
# Rights that let a holder change what is in a folder or file (or its permissions).
$WriteMask = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x40000000 -bor 0x10000000

# Who other than SYSTEM / Administrators / TrustedInstaller can change $path - '' when nobody.
function Get-UntrustedWriter([string]$path) {
  $acl = Get-Acl -LiteralPath $path
  $owner = (New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($TrustedSids -notcontains $owner) { return ('its owner ' + $acl.Owner) }
  foreach ($r in $acl.Access) {
    if ($r.AccessControlType -ne 'Allow') { continue }
    if (($r.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    $sid = $null
    try { $sid = $r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $sid = [string]$r.IdentityReference }
    if ($TrustedSids -contains $sid) { continue }
    if (([int64]$r.FileSystemRights -band $WriteMask) -ne 0) { return [string]$r.IdentityReference }
  }
  return ''
}

function Test-ReparseChain([string]$path) {
  # True when the path or any folder above it is a junction / symbolic link.
  $p = $path
  while ($p) {
    $it = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    if ($null -eq $it) { return $true }
    if (($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $true }
    $parent = [IO.Path]::GetDirectoryName($p)
    if (-not $parent -or $parent -eq $p) { break }
    $p = $parent
  }
  return $false
}

# --- one run at a time ------------------------------------------------------------------------------------------------
$mutex = New-Object System.Threading.Mutex($false, $(if ($Test) { 'Local\ZapTillUpdaterTest' } else { 'Global\ZapTillUpdater' }))
if (-not $mutex.WaitOne(0)) { Write-Log 'another update is already running - this request waits for the next one.'; exit 9 }

try {
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  if ($Test -and $me.User.Value -eq 'S-1-5-18') { Write-Log 'refused: test mode is never used by the updater task.'; exit 2 }
  # Not the task: nothing is written (this may be a copy anywhere, e.g. resources\updater).
  if (-not $Test -and $me.User.Value -ne 'S-1-5-18') { [Console]::Error.WriteLine('refused: this updater runs only as the ZapTill Updater task.'); exit 2 }

  # --- the request (untrusted) --------------------------------------------------------------------------------------
  if (-not (Test-Path -LiteralPath $RequestFile -PathType Leaf)) { Stop-Refused 'there was no update request' '' 3 }
  if ((Get-Item -LiteralPath $RequestFile).Length -gt 4096) { Stop-Refused 'the update request is too large' '' 3 }
  $req = $null
  try { $req = (Get-Content -LiteralPath $RequestFile -Raw) | ConvertFrom-Json } catch { $req = $null }
  if ($null -eq $req) { Stop-Refused 'the update request could not be read' '' 3 }
  $id = [string](Get-Field $req 'id')
  if ($id -match '^[A-Za-z0-9-]{1,64}$') { $RequestId = $id }
  $version = [string](Get-Field $req 'version')
  $installerPath = [string](Get-Field $req 'installerPath')
  $relaunch = ((Get-Field $req 'relaunch') -eq $true)
  Write-Status 'started' '' ''
  $want = Parse-Version $version
  if ($null -eq $want) { Stop-Refused 'the version asked for is not a plain version number' '' 4 }
  Write-Log ('asked to install ' + $version + $(if ($relaunch) { ' and start ZapTill again after' } else { '' }) + '.')

  # --- where ZapTill is installed (written by the installer next to this script - administrators only) -----------------
  $dirFile = Join-Path $Base 'install-dir.txt'
  if (-not (Test-Path -LiteralPath $dirFile -PathType Leaf)) { Stop-Refused 'the installer did not record where ZapTill is installed' $version 5 }
  $installDir = ((Get-Content -LiteralPath $dirFile -TotalCount 1) | Out-String).Trim()
  $exe = Join-Path $installDir 'ZapTill.exe'
  if (-not $Test) {
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { Stop-Refused ('ZapTill.exe is not in ' + $installDir) $version 5 }
    # The installer runs the old uninstaller from the install folder - a folder a standard user could write to would
    # let them swap it. Refused: such a machine installs on close (through Windows' own permission prompt).
    foreach ($p in @($Base, $installDir, (Join-Path $installDir 'resources'))) {
      if (Test-ReparseChain $p) { Stop-Refused ($p + ' is a link to another folder') $version 6 }
      $w = Get-UntrustedWriter $p
      if ($w) { Stop-Refused ($p + ' can be changed by ' + $w + ', not only by administrators') $version 6 }
    }
    $un = Get-ChildItem -LiteralPath $installDir -Filter 'Uninstall *.exe' -File -ErrorAction SilentlyContinue
    foreach ($f in @($un) + @(Get-Item -LiteralPath $exe)) {
      if ($null -eq $f) { continue }
      $w = Get-UntrustedWriter $f.FullName
      if ($w) { Stop-Refused ($f.Name + ' can be changed by ' + $w) $version 6 }
    }
  }

  # --- the version installed now (from ZapTill.exe, never from the request) -----------------------------------------
  $installedText = if ($Test) { $TestInstalledVersion } else { [string](Get-Item -LiteralPath $exe).VersionInfo.FileVersion }
  $m = [regex]::Match($installedText, '^(\d{1,4})\.(\d{1,4})\.(\d{1,4})')
  if (-not $m.Success) { Stop-Refused ('the installed version could not be read (' + $installedText + ')') $version 5 }
  $installed = [int[]]@([int]$m.Groups[1].Value, [int]$m.Groups[2].Value, [int]$m.Groups[3].Value)
  $installedVersion = ($installed -join '.')
  if ((Compare-Version $want $installed) -le 0) {
    Stop-Refused ($version + ' is not newer than the installed ' + $installedVersion + ' (never a downgrade or a re-install)') $version 7
  }

  # --- latest.yml for that version, from the official release location over HTTPS ------------------------------------
  $yml = ''
  if ($Test) {
    if (-not $TestFeedFile -or -not (Test-Path -LiteralPath $TestFeedFile -PathType Leaf)) { Stop-Refused 'the official release list could not be reached (test feed missing)' $version 8 }
    $yml = Get-Content -LiteralPath $TestFeedFile -Raw
  } else {
    $url = $FeedBase + '/v' + $version + '/latest.yml'
    try {
      $proto = [Net.SecurityProtocolType]::Tls12
      try { $proto = $proto -bor [Net.SecurityProtocolType]'Tls13' } catch { }
      [Net.ServicePointManager]::SecurityProtocol = $proto
      [Net.ServicePointManager]::ServerCertificateValidationCallback = $null   # the default: certificates are checked
      $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -MaximumRedirection 5 -TimeoutSec 60
      $final = $resp.BaseResponse.ResponseUri
      if ($final.Scheme -ne 'https' -or ($AllowedHosts -notcontains $final.Host.ToLowerInvariant())) {
        Stop-Refused ('the release list was served from ' + $final.Host + ', not GitHub') $version 8
      }
      if ($resp.Content -is [byte[]]) { $yml = [Text.Encoding]::UTF8.GetString($resp.Content) } else { $yml = [string]$resp.Content }
    } catch {
      Stop-Refused ('the official release list could not be reached over HTTPS (' + $_.Exception.Message + ') - offline, or behind a branch server without internet') $version 8
    }
  }
  if ($yml.Length -gt 65536) { Stop-Refused 'the release list is too large' $version 8 }
  $ymlVersion = [regex]::Match($yml, '(?m)^version:\s*[''"]?([0-9.]+)[''"]?\s*$')
  if (-not $ymlVersion.Success -or $ymlVersion.Groups[1].Value -ne $version) { Stop-Refused ('the release list is not for ' + $version) $version 8 }
  $ymlPath = [regex]::Match($yml, '(?m)^path:\s*[''"]?([^''"\r\n]+?)[''"]?\s*$')
  if (-not $ymlPath.Success) { Stop-Refused 'the release list names no installer' $version 8 }
  $fileName = $ymlPath.Groups[1].Value
  if ($fileName -notmatch '^[A-Za-z0-9._-]{1,100}\.exe$') { Stop-Refused 'the release list names an unexpected installer' $version 8 }
  # The files: entry for that installer: url, sha512, size (electron-builder writes them in this order).
  $entry = [regex]::Match($yml, '(?ms)^\s*-\s*url:\s*[''"]?' + [regex]::Escape($fileName) + '[''"]?\s*$\s*^\s*sha512:\s*([A-Za-z0-9+/=]{80,100})\s*$\s*^\s*size:\s*(\d{1,12})\s*$')
  if (-not $entry.Success) { Stop-Refused 'the release list has no checksum and size for the installer' $version 8 }
  $wantSha = $entry.Groups[1].Value
  $wantSize = [int64]$entry.Groups[2].Value

  # --- the installer the app downloaded (untrusted path) -------------------------------------------------------------
  if ($installerPath -notmatch '^[A-Za-z]:\\[^<>"|?*:\x00-\x1f]{1,400}\.exe$' -or $installerPath -match '\\\.\.?\\') {
    Stop-Refused 'the installer path is not a plain local file path' $version 10
  }
  if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) { Stop-Refused 'the downloaded installer is not there' $version 10 }
  if (Test-ReparseChain $installerPath) { Stop-Refused 'the downloaded installer is behind a link' $version 10 }
  if ((Get-Item -LiteralPath $installerPath).Length -ne $wantSize) { Stop-Refused 'the downloaded installer is not the size the release list gives' $version 11 }

  # --- the work folder: SYSTEM and Administrators only, made afresh ----------------------------------------------------
  if (Test-Path -LiteralPath $Work) {
    $wi = Get-Item -LiteralPath $Work -Force
    if (($wi.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { [IO.Directory]::Delete($Work, $false) }   # the link only
    else { Remove-Item -LiteralPath $Work -Recurse -Force }
  }
  New-Item -ItemType Directory -Path $Work | Out-Null
  $grants = @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
  if ($Test) { $grants += ('*' + $me.User.Value + ':(OI)(CI)F') }   # a test runs as the person running it
  & icacls.exe $Work /inheritance:r /grant:r @grants | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-Refused 'the private work folder could not be locked' $version 12 }
  New-Item -ItemType Directory -Path (Join-Path $Work 'tmp') | Out-Null
  $copy = Join-Path $Work $fileName

  # Copy (at most the size the release list gives), then hash ONLY the copy.
  $src = $null; $dst = $null
  try {
    $src = New-Object IO.FileStream($installerPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $dst = New-Object IO.FileStream($copy, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $buf = New-Object byte[] 1048576
    $total = [int64]0
    while (($n = $src.Read($buf, 0, $buf.Length)) -gt 0) {
      $total += $n
      if ($total -gt $wantSize) { break }
      $dst.Write($buf, 0, $n)
    }
  } catch {
    Stop-Refused ('the downloaded installer could not be copied (' + $_.Exception.Message + ')') $version 12
  } finally {
    if ($dst) { $dst.Dispose() }
    if ($src) { $src.Dispose() }
  }
  if ($TestSwapWith) { Copy-Item -LiteralPath $TestSwapWith -Destination $installerPath -Force }   # test: a swap after the copy

  if ((Get-Item -LiteralPath $copy).Length -ne $wantSize) { Remove-Item -LiteralPath $copy -Force; Stop-Refused 'the copied installer is not the size the release list gives' $version 11 }
  $sha = New-Object System.Security.Cryptography.SHA512CryptoServiceProvider
  $fs = [IO.File]::OpenRead($copy)
  try { $gotSha = [Convert]::ToBase64String($sha.ComputeHash($fs)) } finally { $fs.Dispose() }
  if ($gotSha -cne $wantSha) { Remove-Item -LiteralPath $copy -Force; Stop-Refused 'the downloaded installer does not match the checksum in the official release list' $version 13 }
  Write-Log ('the installer for ' + $version + ' matches the official release list (size and SHA-512).')

  # --- ready: the app closes, the installer runs -----------------------------------------------------------------------
  Write-Status 'ready' '' $version
  $ReadySent = $true
  if (-not $Test) {
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
      $running = @(Get-Process -Name 'ZapTill' -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and $_.Path.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase) } catch { $false } })
      if ($running.Count -eq 0) { break }
      Start-Sleep -Seconds 2
    }
  }

  $instArgs = @('--updated', '/S')
  if ($Test) {
    $o = [ordered]@{ exe = $copy; args = $instArgs; relaunch = $relaunch; temp = (Join-Path $Work 'tmp') }
    Set-Content -LiteralPath (Join-Path $Base 'would-run.json') -Value ($o | ConvertTo-Json -Compress) -Encoding UTF8
    Write-Log ('test: would run the checked installer for ' + $version + ' with ' + ($instArgs -join ' ') + '.')
    Write-Status 'done' 'test' $version
    exit 0
  }

  Write-Log ('installing ' + $version + ' (was ' + $installedVersion + ').')
  $code = -1
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $copy
    $psi.Arguments = ($instArgs -join ' ')
    $psi.UseShellExecute = $false
    $psi.WorkingDirectory = $Work
    # The installer unpacks into a folder only SYSTEM and Administrators can write - not C:\Windows\Temp.
    $psi.EnvironmentVariables['TEMP'] = (Join-Path $Work 'tmp')
    $psi.EnvironmentVariables['TMP'] = (Join-Path $Work 'tmp')
    $proc = [System.Diagnostics.Process]::Start($psi)
    if ($proc.WaitForExit(20 * 60 * 1000)) { $code = $proc.ExitCode } else { $code = -2 }
  } catch {
    Write-Log ('the installer could not be started (' + $_.Exception.Message + ').')
  }
  $now = ''
  try { $now = [string](Get-Item -LiteralPath $exe).VersionInfo.FileVersion } catch { }
  if ($code -eq 0 -and $now -match ('^' + [regex]::Escape($version) + '(\.0)?$')) {
    Write-Log ('installed ' + $version + ' (was ' + $installedVersion + ').')
    Write-Status 'done' '' $version
  } else {
    Write-Log ('the install of ' + $version + ' did not finish (installer exit ' + $code + '; ZapTill.exe is ' + $now + ') - it is tried again when ZapTill is next closed.')
    Write-Status 'failed' ('installer exit ' + $code) $version
  }
  try { Remove-Item -LiteralPath $copy -Force } catch { }
  if ($relaunch) {
    & schtasks.exe /Run /TN $RelaunchTask | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Log 'started ZapTill again for the signed-in user.' }
    else { Write-Log ('could not start ZapTill again (schtasks exit ' + $LASTEXITCODE + ') - it starts at the next sign-in.') }
  }
  if ($code -eq 0) { exit 0 } else { exit 14 }
} catch {
  Write-Log ('the updater stopped: ' + $_.Exception.Message)
  Write-Status $(if ($ReadySent) { 'failed' } else { 'refused' }) 'the updater stopped' ''
  if ($ReadySent -and $relaunch -and -not $Test) { & schtasks.exe /Run /TN $RelaunchTask | Out-Null }   # ZapTill was closed for it
  exit 1
} finally {
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
}
