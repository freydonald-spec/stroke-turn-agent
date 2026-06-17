; DQSync Agent — custom NSIS hooks.
;
; The update flow runs the PREVIOUS version's uninstaller, whose default
; "is the app running?" check can throw:
;   "DQSync Agent cannot be closed. Please close it manually and click retry..."
;
; We force-kill any running instance as early as possible so no check ever
; blocks the install. customInit runs in .onInit (before the install section and
; before the old uninstaller is invoked), so it's the most reliable hook.
; customCheckAppRunning additionally replaces the running-app check itself.
;
; NOTE: this kills the installed APP exe (productName + .exe), NOT the installer
; (DQSync-Agent-Setup.exe).

!macro killDqsyncAgent
  nsExec::Exec 'taskkill /F /IM "DQSync Agent.exe" /T'
  Sleep 1500
!macroend

; Runs first, in .onInit — before the running-app check and the old uninstaller.
!macro customInit
  !insertmacro killDqsyncAgent
!macroend

; Replace electron-builder's running-app check with a forced kill.
!macro customCheckAppRunning
  !insertmacro killDqsyncAgent
!macroend

; Also kill it when the (new) uninstaller runs.
!macro customUnInit
  !insertmacro killDqsyncAgent
!macroend
