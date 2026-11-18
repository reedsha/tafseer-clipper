; Tauri NSIS installer hooks (see bundle.windows.nsis.installerHooks).
;
; 0.1.4 moved the Python engine from a onefile `backend.exe` at the install root
; to the onedir resource folder `backend\`. Upgrading from 0.1.3 or older leaves
; the previous ~144 MB executable behind because the new installer no longer
; carries a file at that path. It is dead weight and must never be launched, so
; remove it after the new files are in place.
!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\backend.exe"
!macroend
