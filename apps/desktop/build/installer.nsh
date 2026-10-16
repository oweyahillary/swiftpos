; ─────────────────────────────────────────────────────────────────────────────
;  installer.nsh — SwiftPOS custom install steps
;
;  Wired in via package.json:  "nsis": { "include": "build/installer.nsh" }
;
;  WHY THE FIREWALL RULE LIVES HERE AND NOT IN THE APP
;
;  Adding a Windows firewall rule needs administrator rights. The Electron app
;  runs as the logged-in cashier, so doing it at runtime means a UAC prompt on
;  a POS terminal — a dialog a cashier will dismiss, at the exact moment the
;  thing being asked for is the thing that makes the till work. The installer
;  already elevates, so the rule is added once, by whoever is doing the install,
;  and never asked about again.
;
;  This requires "perMachine": true in the nsis config. A per-user install does
;  not elevate and netsh would fail silently, which is worse than not trying.
; ─────────────────────────────────────────────────────────────────────────────

!macro customInstall

  ; ── Branch server inbound rule ────────────────────────────────────────────
  ; One till per branch runs the aggregation node (src/main/nodeServer.ts) on
  ; TCP 4100, and the other tills push to it over the LAN. Without this rule
  ; Windows silently drops those connections and tills 2 and 3 report
  ; 'node unreachable' forever, with nothing on any screen explaining why.
  ;
  ; The range 4100-4103 matches the node's port fallback: when 4100 is taken it
  ; walks up to 4103, and a rule that only covered 4100 would leave exactly the
  ; recovered case blocked.
  ;
  ; profile=private ONLY. Never add this to the public profile — a shop's POS
  ; frequently shares a network with customer wifi, and the node's X-Node-Secret
  ; check should not be the only thing standing between a guest device and the
  ; branch's sales data.
  ;
  ; Added on every install, including tills that will not run the node. One
  ; unused rule on the private profile is not a risk, and the alternative is
  ; asking the installer a question whose answer is not known until setup runs.
  DetailPrint "Adding firewall rule for the SwiftPOS branch server..."

  ; Delete first so a reinstall does not stack duplicates with the same name.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="SwiftPOS Branch Server"'
  Pop $0

  nsExec::ExecToLog 'netsh advfirewall firewall add rule \
    name="SwiftPOS Branch Server" \
    description="Allows other SwiftPOS tills on this branch LAN to sync to this machine." \
    dir=in action=allow protocol=TCP localport=4100-4103 profile=private'
  Pop $0

  ${If} $0 == 0
    DetailPrint "Firewall rule added (TCP 4100-4103, private networks)."
  ${Else}
    ; Not fatal. A single-till branch never needs the rule, and an admin can add
    ; it later. Failing the whole install over it would be the wrong trade.
    DetailPrint "Could not add the firewall rule (exit $0)."
    DetailPrint "If this till is the branch server, run this as administrator:"
    DetailPrint '  netsh advfirewall firewall add rule name="SwiftPOS Branch Server" dir=in action=allow protocol=TCP localport=4100-4103 profile=private'
  ${EndIf}

  ; ── A427: branch server discovery (UDP 4199) ─────────────────────────────
  ; The branch server announces itself on the shop network every few seconds
  ; (src/main/serverBeacon.ts) and a till being installed LISTENS on UDP 4199
  ; to find it. The listening machine needs this inbound rule, so it is added on
  ; every install, private profile only, for the same reasons as the rule above.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="ZapTill Server Discovery"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule \
    name="ZapTill Server Discovery" \
    description="Lets a ZapTill till being installed find the branch server on this network." \
    dir=in action=allow protocol=UDP localport=4199 profile=private'
  Pop $0
  ${If} $0 == 0
    DetailPrint "Firewall rule added (UDP 4199, private networks)."
  ${Else}
    DetailPrint "Could not add the discovery rule (exit $0). Tills can still be set up by typing the server address."
  ${EndIf}

  ; ── A513: start after sign-in, not at it ───────────────────────────────────────────────────────────────────────────
  ; A branch server used to start with Windows from the Run key — Task Manager counts that as a Startup app ("High"
  ; impact on a slow PC, at the moment Windows itself is loading). Instead, one logon task, registered here (a logon
  ; trigger needs administrator rights; the installer has them): 45 s after ANY user signs in it starts
  ;   ZapTill.exe --at-login
  ; which ends at once — before the rest of ZapTill loads, no window — unless that user's ZapTill is a branch server
  ; (a marker file the app writes in its data folder: src/main/lowImpactStart.ts, startGate.ts). A server hands over
  ; to its restart task (serverWatchdog.ts) and runs in the tray with no window.
  ;   - the signed-in user (BUILTIN\Users, least privilege) — never SYSTEM, never elevated;
  ;   - no time limit (PT0S): Task Scheduler never ends a server it started; normal priority (5), not below-normal;
  ;   - users may read and run it, never change it (the same security descriptor as the A509 tasks).
  ; Both flavours, each its own task. The app removes its Run entry once it sees this task (serverMode.syncLoginEntry).
  InitPluginsDir
  Push $1
  FileOpen $1 "$PLUGINSDIR\start-task.xml" w
  FileWriteUTF16LE /BOM $1 `<?xml version="1.0" encoding="UTF-16"?>$\r$\n`
  FileWriteUTF16LE $1 `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">$\r$\n`
  FileWriteUTF16LE $1 `  <RegistrationInfo><Description>Starts the ZapTill branch server 45 seconds after Windows sign-in, in the tray; on a till it ends at once (A513).</Description><SecurityDescriptor>D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;AU)</SecurityDescriptor></RegistrationInfo>$\r$\n`
  FileWriteUTF16LE $1 `  <Triggers><LogonTrigger><Enabled>true</Enabled><Delay>PT45S</Delay></LogonTrigger></Triggers>$\r$\n`
  FileWriteUTF16LE $1 `  <Principals><Principal id="Author"><GroupId>S-1-5-32-545</GroupId><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>$\r$\n`
  FileWriteUTF16LE $1 `  <Settings><MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>false</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>5</Priority></Settings>$\r$\n`
  FileWriteUTF16LE $1 `  <Actions Context="Author"><Exec><Command>"$INSTDIR\${APP_EXECUTABLE_FILENAME}"</Command><Arguments>--at-login</Arguments><WorkingDirectory>$INSTDIR</WorkingDirectory></Exec></Actions>$\r$\n`
  FileWriteUTF16LE $1 `</Task>$\r$\n`
  FileClose $1
  nsExec::ExecToLog 'schtasks /Create /TN "${PRODUCT_NAME} start at sign-in" /XML "$PLUGINSDIR\start-task.xml" /F'
  Pop $0
  ${If} $0 == 0
    DetailPrint "Sign-in task registered: a branch server starts 45 s after sign-in, in the tray."
  ${Else}
    ; Not fatal: a branch server then keeps its "start with Windows" entry, and waits before it starts.
    DetailPrint "Could not register the sign-in task (exit $0). A branch server starts with Windows as before."
  ${EndIf}
  Delete "$PLUGINSDIR\start-task.xml"
  Pop $1

  ; ── A509: the updater task — updates install with nobody there to answer Windows ──
  ; The installer is per machine and unsigned, so electron-updater starts it through elevate.exe and Windows asks for
  ; permission (UAC) at every update; on a till nobody is at, nobody answers. The installer already runs elevated, so
  ; it registers, once, a scheduled task that applies an update with administrator rights, SAFELY:
  ;   - "ZapTill Updater": runs as SYSTEM, highest privileges, no trigger (started on demand), one fixed script
  ;     (updater\zaptill-update.ps1, written here from the installer's own payload into
  ;     "%ProgramFiles%\ZapTill Updater", which only administrators can write) and NO arguments. Its security
  ;     descriptor lets a signed-in user RUN it (read + execute), never change or delete it.
  ;   - the script trusts nothing the app gives it (request\update-request.json): no downgrade, the installer copied
  ;     into work\ (SYSTEM and Administrators only) and that copy's SHA-512 and size checked against latest.yml read
  ;     over HTTPS from ZapTill's official release location. Anything off: nothing runs, and ZapTill installs the update
  ;     when it is next closed, through Windows' prompt, as before.
  ;   - "ZapTill Relaunch": starts ZapTill.exe again in the signed-in user's session (the INTERACTIVE group, least
  ;     privilege) — never as SYSTEM.
  ; Only the prod flavour: the dev build never updates itself (autoUpdate.ts), and two flavours must not share a task.
  !if "${PRODUCT_NAME}" == "ZapTill"
  Push $1
  Push $2
  StrCpy $2 "$PROGRAMFILES64\ZapTill Updater"
  DetailPrint "Registering the ZapTill updater task..."
  CreateDirectory "$2"
  CreateDirectory "$2\request"
  ; Administrators own it; SYSTEM and Administrators write; users read (the log, the status). Nothing inherited.
  nsExec::ExecToLog 'icacls "$2" /setowner *S-1-5-32-544 /C'
  Pop $0
  nsExec::ExecToLog 'icacls "$2" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-32-545:(OI)(CI)RX'
  Pop $0
  ; request\ is the one place users write (the app's request, untrusted by the script): files in it, not the folder.
  nsExec::ExecToLog 'icacls "$2\request" /grant *S-1-5-32-545:(OI)(CI)(IO)M *S-1-5-32-545:(WD,AD,WEA,WA)'
  Pop $0
  SetOutPath "$2"
  File "${PROJECT_DIR}\updater\zaptill-update.ps1"
  SetOutPath "$INSTDIR"
  ; Where ZapTill is installed (the script reads the installed version from ZapTill.exe there).
  FileOpen $1 "$2\install-dir.txt" w
  FileWriteUTF16LE /BOM $1 "$INSTDIR"
  FileClose $1

  FileOpen $1 "$2\updater-task.xml" w
  FileWriteUTF16LE /BOM $1 `<?xml version="1.0" encoding="UTF-16"?>$\r$\n`
  FileWriteUTF16LE $1 `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">$\r$\n`
  FileWriteUTF16LE $1 `  <RegistrationInfo><Description>Installs ZapTill updates the app has downloaded, after checking them against the official release (A509).</Description><SecurityDescriptor>D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;AU)</SecurityDescriptor></RegistrationInfo>$\r$\n`
  FileWriteUTF16LE $1 `  <Triggers />$\r$\n`
  FileWriteUTF16LE $1 `  <Principals><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>$\r$\n`
  FileWriteUTF16LE $1 `  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>false</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><ExecutionTimeLimit>PT1H</ExecutionTimeLimit><Priority>7</Priority></Settings>$\r$\n`
  FileWriteUTF16LE $1 `  <Actions Context="Author"><Exec><Command>%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe</Command><Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$2\zaptill-update.ps1"</Arguments><WorkingDirectory>$2</WorkingDirectory></Exec></Actions>$\r$\n`
  FileWriteUTF16LE $1 `</Task>$\r$\n`
  FileClose $1
  nsExec::ExecToLog 'schtasks /Create /TN "ZapTill Updater" /XML "$2\updater-task.xml" /F'
  Pop $0
  ${If} $0 == 0
    DetailPrint "Updater task registered: updates install without a Windows prompt."
  ${Else}
    ; Not fatal: without the task an update installs as before (Windows asks for permission when ZapTill closes).
    DetailPrint "Could not register the updater task (exit $0). Updates install when ZapTill is closed, with Windows' prompt."
  ${EndIf}
  Delete "$2\updater-task.xml"

  FileOpen $1 "$2\relaunch-task.xml" w
  FileWriteUTF16LE /BOM $1 `<?xml version="1.0" encoding="UTF-16"?>$\r$\n`
  FileWriteUTF16LE $1 `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">$\r$\n`
  FileWriteUTF16LE $1 `  <RegistrationInfo><Description>Starts ZapTill again for the signed-in user after the updater installed an update (A509).</Description><SecurityDescriptor>D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;AU)</SecurityDescriptor></RegistrationInfo>$\r$\n`
  FileWriteUTF16LE $1 `  <Triggers />$\r$\n`
  FileWriteUTF16LE $1 `  <Principals><Principal id="Author"><GroupId>S-1-5-4</GroupId><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>$\r$\n`
  ; A513: normal priority (5) — the default 7 ran a relaunched ZapTill below normal, slower on a slow PC.
  FileWriteUTF16LE $1 `  <Settings><MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>false</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>5</Priority></Settings>$\r$\n`
  FileWriteUTF16LE $1 `  <Actions Context="Author"><Exec><Command>"$INSTDIR\${APP_EXECUTABLE_FILENAME}"</Command><Arguments>--updated</Arguments><WorkingDirectory>$INSTDIR</WorkingDirectory></Exec></Actions>$\r$\n`
  FileWriteUTF16LE $1 `</Task>$\r$\n`
  FileClose $1
  nsExec::ExecToLog 'schtasks /Create /TN "ZapTill Relaunch" /XML "$2\relaunch-task.xml" /F'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Could not register the relaunch task (exit $0). After an update ZapTill starts at the next sign-in."
  ${EndIf}
  Delete "$2\relaunch-task.xml"
  Pop $2
  Pop $1
  !endif

!macroend

!macro customUnInstall

  ; Leave nothing behind. Without this, every reinstall-over-uninstall cycle
  ; leaves an orphaned rule and the machine accumulates them.
  DetailPrint "Removing the SwiftPOS firewall rule..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="SwiftPOS Branch Server"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="ZapTill Server Discovery"'
  Pop $0

  ; A513: the sign-in task — on a real uninstall only (an update's customInstall registers it again anyway).
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog 'schtasks /Delete /TN "${PRODUCT_NAME} start at sign-in" /F'
    Pop $0
  ${endIf}

  ; A509: the updater and relaunch tasks and their folder — on a real uninstall only. An update runs this uninstaller
  ; too (with --updated), from inside the updater task: deleting the task there would pull it out from under the
  ; install, and the new version's customInstall registers both again anyway.
  !if "${PRODUCT_NAME}" == "ZapTill"
  ${ifNot} ${isUpdated}
    DetailPrint "Removing the ZapTill updater tasks..."
    nsExec::ExecToLog 'schtasks /Delete /TN "ZapTill Updater" /F'
    Pop $0
    nsExec::ExecToLog 'schtasks /Delete /TN "ZapTill Relaunch" /F'
    Pop $0
    ; work\ is SYSTEM and Administrators only — removed whole. request\ is writable by users, so only the one file the
    ; app writes is deleted and the folder removed if empty (never a recursive delete where a user could plant a link).
    RMDir /r "$PROGRAMFILES64\ZapTill Updater\work"
    Delete "$PROGRAMFILES64\ZapTill Updater\request\update-request.json"
    RMDir "$PROGRAMFILES64\ZapTill Updater\request"
    Delete "$PROGRAMFILES64\ZapTill Updater\zaptill-update.ps1"
    Delete "$PROGRAMFILES64\ZapTill Updater\install-dir.txt"
    Delete "$PROGRAMFILES64\ZapTill Updater\updater-status.json"
    Delete "$PROGRAMFILES64\ZapTill Updater\updater.log"
    RMDir "$PROGRAMFILES64\ZapTill Updater"
  ${endIf}
  !endif

!macroend
