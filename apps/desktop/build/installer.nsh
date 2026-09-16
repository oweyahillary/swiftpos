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

!macroend

!macro customUnInstall

  ; Leave nothing behind. Without this, every reinstall-over-uninstall cycle
  ; leaves an orphaned rule and the machine accumulates them.
  DetailPrint "Removing the SwiftPOS firewall rule..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="SwiftPOS Branch Server"'
  Pop $0

!macroend
