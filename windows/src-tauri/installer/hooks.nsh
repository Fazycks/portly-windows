; Portly installer hooks (Tauri NSIS, currentUser install).
;
; The app installs to Tauri's per-user default, $LOCALAPPDATA\Portly. An older,
; Electron-based Portly lived in $LOCALAPPDATA\Programs\Portly: a different
; folder, so cleaning it up can never touch this install.
;
; - PREINSTALL: offer to remove the older Electron build (both bind port 7737;
;   a silent install never removes it), then stop this app's daemon so bin\portlyd.exe can be overwritten.
; - POSTINSTALL: put $INSTDIR\bin (portly.exe, portlyd.exe) on the user PATH.
; - PREUNINSTALL: stop the daemon (and the servers it supervises) so its files
;   can be deleted, and remove the "Portly Forever" logon task.
; - POSTUNINSTALL: take $INSTDIR\bin back off the user PATH.
;
; PATH is edited in plain NSIS (REG_EXPAND_SZ, existing entries untouched). NSIS
; strings are capped at NSIS_MAX_STRLEN, so whenever the current value cannot be
; read whole (too long, or unreadable) the edit is delegated to PowerShell,
; which has no such limit, instead of risking a truncated PATH.

!ifndef HWND_BROADCAST
  !define HWND_BROADCAST 0xffff
!endif
!ifndef WM_SETTINGCHANGE
  !define WM_SETTINGCHANGE 0x001A
!endif

!define PORTLY_OLD_DIR "$LOCALAPPDATA\Programs\Portly"
!define PORTLY_OLD_UNINSTALLER "$LOCALAPPDATA\Programs\Portly\Uninstall Portly.exe"
;  Launch at login: same names as src-tauri/src/autostart.rs.
!define PORTLY_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define PORTLY_APPROVED_KEY "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
!define PORTLY_CHOICE_KEY "Software\Portly"
!define PORTLY_PS "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command"

; ---------------------------------------------------------------------------
; Helpers

; Case-insensitive substring search. In: $R0 haystack, $R1 needle. Out: $R2 index or -1.
!macro PORTLY_DEFINE_INDEXOF prefix
Function ${prefix}Portly_IndexOf
  Push $R3
  Push $R4
  Push $R5
  StrLen $R3 $R1
  StrLen $R4 $R0
  StrCpy $R2 0
  loop:
    IntOp $R5 $R2 + $R3
    IntCmp $R5 $R4 0 0 notfound
    StrCpy $R5 $R0 $R3 $R2
    StrCmp $R5 $R1 done
    IntOp $R2 $R2 + 1
    Goto loop
  notfound:
    StrCpy $R2 -1
  done:
  Pop $R5
  Pop $R4
  Pop $R3
FunctionEnd
!macroend
!insertmacro PORTLY_DEFINE_INDEXOF ""
!insertmacro PORTLY_DEFINE_INDEXOF "un."

!macro PORTLY_BROADCAST_ENVIRONMENT
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

; Stops this app's daemon, gracefully first: "portly quit" asks it to stop the
; dev servers it supervises, the same as quitting Portly. Only a portlyd.exe
; running from $INSTDIR\bin is then waited on and, if still alive after 10 s,
; force-stopped (closing its job objects ends the servers). Other installs'
; daemons are left alone. The installer is about to replace (or remove)
; portlyd.exe.
!macro PORTLY_STOP_DAEMON
  Push $0
  IfFileExists "$INSTDIR\bin\portly.exe" 0 +3
    nsExec::Exec '"$INSTDIR\bin\portly.exe" quit'
    Pop $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "PORTLY_BIN", t "$INSTDIR\bin")i'
  nsExec::Exec `${PORTLY_PS} "$$d=$$env:PORTLY_BIN + '\'; $$f={ @(Get-Process portlyd -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and $$_.Path.StartsWith($$d, [System.StringComparison]::OrdinalIgnoreCase) }) }; for ($$i=0; $$i -lt 40 -and (& $$f).Count -gt 0; $$i++) { Start-Sleep -Milliseconds 250 }; & $$f | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $0
  Pop $0
  Sleep 300
!macroend

; Adds $INSTDIR\bin to HKCU\Environment\Path when absent.
Function Portly_AddToPath
  Push $R0
  Push $R1
  Push $R2
  Push $R6
  Push $R7
  StrCpy $R6 "$INSTDIR\bin"

  ClearErrors
  ReadRegStr $R0 HKCU "Environment" "Path"
  IfErrors 0 +3
    ; Missing value, or too long to read: let PowerShell do it.
    Call Portly_AddToPathPowerShell
    Goto finish
  StrLen $R7 $R0
  IntCmp $R7 ${NSIS_MAX_STRLEN} 0 +3 0
    Call Portly_AddToPathPowerShell
    Goto finish
  IntOp $R7 $R7 + 512
  IntCmp $R7 ${NSIS_MAX_STRLEN} 0 +3 0
    Call Portly_AddToPathPowerShell
    Goto finish

  ; Already present? Compare whole entries: ";a;b;" contains ";dir;".
  StrCpy $R0 ";$R0;"
  StrCpy $R1 ";$R6;"
  Call Portly_IndexOf
  IntCmp $R2 -1 0 finish finish
  StrCpy $R1 ";$R6\;"
  Call Portly_IndexOf
  IntCmp $R2 -1 0 finish finish

  ; Re-read the original value and append.
  ReadRegStr $R0 HKCU "Environment" "Path"
  StrCmp $R0 "" 0 +3
    StrCpy $R0 "$R6"
    Goto write
  StrCpy $R7 $R0 "" -1
  StrCmp $R7 ";" 0 +3
    StrCpy $R0 "$R0$R6"
    Goto write
  StrCpy $R0 "$R0;$R6"
  write:
  WriteRegExpandStr HKCU "Environment" "Path" "$R0"
  !insertmacro PORTLY_BROADCAST_ENVIRONMENT

  finish:
  Pop $R7
  Pop $R6
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

Function Portly_AddToPathPowerShell
  Push $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "PORTLY_BIN", t "$INSTDIR\bin")i'
  nsExec::Exec `${PORTLY_PS} "$$d=$$env:PORTLY_BIN; $$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $$p=[string]$$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $$e=@($$p -split ';' | Where-Object { $$_ -ne '' }); if (-not ($$e | Where-Object { $$_.TrimEnd('\') -ieq $$d })) { $$k.SetValue('Path', ((@($$e) + $$d) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString) }; $$k.Close()"`
  Pop $0
  Pop $0
  !insertmacro PORTLY_BROADCAST_ENVIRONMENT
FunctionEnd

; Removes every "$INSTDIR\bin" entry from HKCU\Environment\Path.
Function un.Portly_RemoveFromPath
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R6
  Push $R7
  StrCpy $R6 "$INSTDIR\bin"

  ClearErrors
  ReadRegStr $R0 HKCU "Environment" "Path"
  IfErrors 0 +3
    Call un.Portly_RemoveFromPathPowerShell
    Goto finish
  StrLen $R7 $R0
  IntOp $R7 $R7 + 8
  IntCmp $R7 ${NSIS_MAX_STRLEN} 0 +3 0
    Call un.Portly_RemoveFromPathPowerShell
    Goto finish

  StrCpy $R0 ";$R0;"
  StrCpy $R3 0                       ; changed?
  StrCpy $R1 ";$R6;"
  Call un.Portly_RemoveEntries
  StrCpy $R1 ";$R6\;"
  Call un.Portly_RemoveEntries
  StrCmp $R3 0 finish

  ; Drop the sentinels added above.
  StrCpy $R0 $R0 "" 1
  StrCpy $R0 $R0 -1
  StrCmp $R0 "" 0 +3
    DeleteRegValue HKCU "Environment" "Path"
    Goto broadcast
  WriteRegExpandStr HKCU "Environment" "Path" "$R0"
  broadcast:
  !insertmacro PORTLY_BROADCAST_ENVIRONMENT

  finish:
  Pop $R7
  Pop $R6
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

; In/out: $R0 ";a;b;" haystack, $R1 ";entry;" needle, $R3 set to 1 when changed.
Function un.Portly_RemoveEntries
  Push $R4
  Push $R5
  loop:
    Call un.Portly_IndexOf
    IntCmp $R2 -1 done
    StrCpy $R4 $R0 $R2               ; left of the match
    StrLen $R5 $R1
    IntOp $R5 $R2 + $R5
    IntOp $R5 $R5 - 1
    StrCpy $R5 $R0 "" $R5            ; from the needle's closing ";"
    StrCpy $R0 "$R4$R5"
    StrCpy $R3 1
    Goto loop
  done:
  Pop $R5
  Pop $R4
FunctionEnd

Function un.Portly_RemoveFromPathPowerShell
  Push $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "PORTLY_BIN", t "$INSTDIR\bin")i'
  nsExec::Exec `${PORTLY_PS} "$$d=$$env:PORTLY_BIN; $$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $$true); if ($$k) { $$p=[string]$$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $$e=@($$p -split ';' | Where-Object { $$_ -ne '' }); $$n=@($$e | Where-Object { $$_.TrimEnd('\') -ine $$d }); if ($$n.Count -ne $$e.Count) { $$k.SetValue('Path', ($$n -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString) }; $$k.Close() }"`
  Pop $0
  Pop $0
  !insertmacro PORTLY_BROADCAST_ENVIRONMENT
FunctionEnd

; Launch at login. An existing entry is kept and pointed at this install's
; Portly.exe (Task Manager's enabled/disabled state is left as is). Otherwise,
; unless the user already chose in Settings, ask once; a silent install or an
; update (the app's automatic update runs unattended) never turns it on and
; leaves the question for a later interactive install.
; A macro, not a Function: this file is included before the template defines
; MAINBINARYNAME and declares $UpdateMode, so only an insertion point sees them.
!macro PORTLY_SETUP_LAUNCH_AT_LOGIN
  Push $0
  ClearErrors
  ReadRegStr $0 HKCU "${PORTLY_RUN_KEY}" "Portly"
  IfErrors portly_ask
    WriteRegStr HKCU "${PORTLY_RUN_KEY}" "Portly" '"$INSTDIR\${MAINBINARYNAME}.exe" --hidden'
    Goto portly_done
  portly_ask:
  IfSilent portly_done
  StrCmp $UpdateMode 1 portly_done
  ClearErrors
  ReadRegDWORD $0 HKCU "${PORTLY_CHOICE_KEY}" "LaunchAtLoginChosen"
  IfErrors 0 portly_done
  WriteRegDWORD HKCU "${PORTLY_CHOICE_KEY}" "LaunchAtLoginChosen" 1
  MessageBox MB_YESNO|MB_ICONQUESTION "Launch Portly automatically when you sign in to Windows?$\r$\n$\r$\nPortly will start in the tray. You can change this later in Portly Settings > General." IDNO portly_done
    WriteRegStr HKCU "${PORTLY_RUN_KEY}" "Portly" '"$INSTDIR\${MAINBINARYNAME}.exe" --hidden'
    WriteRegBin HKCU "${PORTLY_APPROVED_KEY}" "Portly" 020000000000000000000000
  portly_done:
  Pop $0
!macroend

; ---------------------------------------------------------------------------
; Hooks

!macro NSIS_HOOK_PREINSTALL
  ; An older Electron build of Portly would fight this one for port 7737.
  IfFileExists "${PORTLY_OLD_UNINSTALLER}" 0 portly_no_old_install
    MessageBox MB_YESNO|MB_ICONQUESTION "An older version of Portly is installed in$\r$\n${PORTLY_OLD_DIR}.$\r$\n$\r$\nUninstall it now? (recommended — both use port 7737)" /SD IDNO IDNO portly_no_old_install
    ; Stop only processes running from the old folder (path-scoped, never this install).
    Push $0
    System::Call 'Kernel32::SetEnvironmentVariable(t "PORTLY_OLD", t "${PORTLY_OLD_DIR}")i'
    nsExec::Exec `${PORTLY_PS} "Get-Process | Where-Object { $$_.Path -and $$_.Path.StartsWith($$env:PORTLY_OLD + '\', [System.StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue"`
    Pop $0
    Pop $0
    Sleep 500
    ; _?= runs the uninstaller in place so ExecWait really waits for it.
    ExecWait '"${PORTLY_OLD_UNINSTALLER}" /S _?=${PORTLY_OLD_DIR}'
    Delete "${PORTLY_OLD_UNINSTALLER}"
    RMDir "${PORTLY_OLD_DIR}"
  portly_no_old_install:

  ; This app's daemon keeps bin\portlyd.exe open; the installer replaces it.
  !insertmacro PORTLY_STOP_DAEMON
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Call Portly_AddToPath
  !insertmacro PORTLY_SETUP_LAUNCH_AT_LOGIN
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro PORTLY_STOP_DAEMON
  Push $0
  nsExec::Exec 'schtasks.exe /Delete /TN "Portly Forever" /F'
  Pop $0
  Pop $0
  ; Updates run the old uninstaller with /UPDATE: keep the user's choice then.
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "${PORTLY_RUN_KEY}" "Portly"
    DeleteRegValue HKCU "${PORTLY_APPROVED_KEY}" "Portly"
    DeleteRegValue HKCU "${PORTLY_CHOICE_KEY}" "LaunchAtLoginChosen"
    DeleteRegKey /ifempty HKCU "${PORTLY_CHOICE_KEY}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Call un.Portly_RemoveFromPath
!macroend
