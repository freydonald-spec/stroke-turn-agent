; DQSync Agent — custom NSIS hooks.
;
; Replace electron-builder's default "is the app running?" check — which shows
; "DQSync Agent cannot be closed. Please close it manually and click retry to
; continue." — with a forced termination. This lets updates always replace the
; in-use files instead of stalling on the running app.
;
; NOTE: this kills the installed APP exe (productName + .exe), NOT the installer
; (DQSync-Agent-Setup.exe).

!macro customCheckAppRunning
  ; Force-kill the running app (and child processes). Ignore errors if it isn't
  ; running. Give the OS a moment to release file locks before we overwrite.
  nsExec::Exec 'taskkill /F /IM "DQSync Agent.exe" /T'
  Sleep 1500
!macroend

; Also kill it during uninstall (the assisted installer uninstalls the old
; version before reinstalling on update).
!macro customUnInit
  nsExec::Exec 'taskkill /F /IM "DQSync Agent.exe" /T'
  Sleep 1000
!macroend
