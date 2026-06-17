; DQSync Agent — custom NSIS hooks.
;
; THE BUG: updating from a previously-installed version showed
;   "DQSync Agent cannot be closed. Please close it manually and click retry..."
; and the only manual workaround was to delete the app's "Uninstall" key in
; regedit before installing.
;
; ROOT CAUSE (verified against the electron-builder NSIS templates):
;   During an update the installer runs the PREVIOUS version's uninstaller with
;   the --updated flag. In that mode the old uninstaller does NOT do a plain
;   delete — it tries to atomically *rename* every file in the install dir
;   (uninstaller.nsh -> un.atomicRMDir -> Rename). Rename/MoveFile fails if a
;   file is locked even momentarily (the app's own exe, an AV/indexer scan, or
;   a handle that hasn't been released yet). On failure it Aborts with a
;   non-zero exit code, the installer retries 5x, then shows
;   "$(appCannotBeClosed)". Deleting the Uninstall reg key worked because it
;   makes uninstallOldVersion find nothing and skip that fragile step entirely —
;   the new files are simply written over the old ones.
;
; THE FIX (two parts, both self-contained in the NEW installer so updates from
; ANY older version are fixed immediately — no "takes one more version" trap):
;   1. customInit: force-kill any running instance, then delete the app's own
;      Uninstall registry entry. This automates the proven reg-delete workaround
;      so uninstallOldVersion returns early and the brittle old uninstaller
;      never runs. The new install re-creates the Uninstall entry afterwards
;      (registryAddInstallInfo), so Add/Remove Programs still works.
;   2. customCheckAppRunning / customUnInit / customRemoveFiles: force-kill the
;      app and, where the uninstaller does run, remove files tolerantly
;      (RMDir /r, which never aborts on a locked file) instead of the
;      rename-or-abort path.

; Force-kill the app and all of its Electron helper processes. They all share
; the same image name ("DQSync Agent.exe"), so /IM catches every one of them —
; no /T (which could also terminate this installer if it were spawned as a child
; of the app during an auto-update). Sleep afterwards so Windows has time to
; release the file handles before we touch the install directory.
!macro killDqsyncAgent
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "DQSync Agent.exe"'
  Pop $0
  Sleep 2000
!macroend

; Runs first, in .onInit — before ALLOW_ONLY_ONE..., before the running-app
; check, and before uninstallOldVersion. initMultiUser (which sets SHELL_CONTEXT)
; and multiUser.nsh (which defines UNINSTALL_REGISTRY_KEY) have already run by the
; time this macro is inserted, so both are safe to use here.
!macro customInit
  !insertmacro killDqsyncAgent
  ; Skip the previous version's fragile uninstaller: remove its registry entry so
  ; uninstallOldVersion finds no UninstallString and returns early. Cover both the
  ; current-user hive (where this per-user install lives) and the machine hive in
  ; case an older build registered there.
  DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
!macroend

; Replace electron-builder's running-app check with a forced kill (no prompts).
!macro customCheckAppRunning
  !insertmacro killDqsyncAgent
!macroend

; Also kill it when the (new) uninstaller runs.
!macro customUnInit
  !insertmacro killDqsyncAgent
!macroend

; If the uninstaller ever does run during an update, remove files the tolerant
; way: a recursive delete that ignores locked files instead of the default
; "atomic rename or abort". This prevents the non-zero exit that triggers the
; "cannot be closed" retry loop.
!macro customRemoveFiles
  !insertmacro killDqsyncAgent
  RMDir /r $INSTDIR
!macroend
