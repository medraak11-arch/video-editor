; build/installer.nsh — source, not build output. Tracked in git.
;
; electron-builder resolves this file by convention from directories.buildResources
; (already `build`) and inserts customInstall at installSection.nsh:82, immediately
; after registerFileAssociations. That is the only point in the install path where
; the .veproj association exists AND the shell has not yet been told about it: the
; template's one SHChangeNotify call lives inside addDesktopLink, which runs earlier.
!macro customInstall
  ; SHCNE_ASSOCCHANGED. Without it an upgrade over an existing install leaves
  ; HKCU\Software\Classes\<ProgID>\DefaultIcon pointing at the same path with new
  ; contents, and Explorer keeps the previously cached icon until logoff.
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
