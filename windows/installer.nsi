; The Stupid Buddy for Windows installer (NSIS). Installs for the current user only (no administrator prompt),
; so updates can replace it quietly. Built by .github/workflows/windows.yml: makensis /DVERSION=x.y.z installer.nsi
Unicode true
!include "MUI2.nsh"
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
Name "The Stupid Buddy"
OutFile "dist\StupidBuddy-${VERSION}-windows-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\The Stupid Buddy"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\The Stupid Buddy.exe"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "The Stupid Buddy"
VIAddVersionKey "FileDescription" "The Stupid Buddy installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "lattewirell-creator"

Function .onInit
  ; Windows' web engine (WebView2) ships with Windows 11 and current Windows 10; offer it if missing.
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  StrCmp $0 "" 0 found
  ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  StrCmp $0 "" 0 found
  MessageBox MB_YESNO|MB_ICONINFORMATION "The Stupid Buddy needs Microsoft Edge WebView2, which is missing on this PC. Open Microsoft's download page now?" IDNO found
  ExecShell "open" "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
  found:
FunctionEnd

Section "Install"
  ; An update closes the running app first.
  nsExec::Exec 'taskkill /IM "The Stupid Buddy.exe"'
  Sleep 800
  SetOutPath "$INSTDIR"
  File "/oname=The Stupid Buddy.exe" "target\release\stupid-buddy.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\The Stupid Buddy.lnk" "$INSTDIR\The Stupid Buddy.exe"
  !define UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall\TheStupidBuddy"
  WriteRegStr HKCU "${UNINST}" "DisplayName" "The Stupid Buddy"
  WriteRegStr HKCU "${UNINST}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST}" "Publisher" "lattewirell-creator"
  WriteRegStr HKCU "${UNINST}" "DisplayIcon" "$INSTDIR\The Stupid Buddy.exe"
  WriteRegStr HKCU "${UNINST}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ; Settings and saved AI keys (in %APPDATA%\The Stupid Buddy) are kept for a reinstall.
  Delete "$INSTDIR\The Stupid Buddy.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\The Stupid Buddy.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TheStupidBuddy"
SectionEnd
