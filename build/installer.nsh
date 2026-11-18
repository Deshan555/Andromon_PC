; Andromon setup wizard: extra pages for electron-builder's assisted NSIS installer.
; Order of pages: Welcome > who to install for > folder > optional tools > installing > Finish (with "Run Andromon").
; A licence page appears by itself when a build/license.txt (or .rtf/.html) file is added.

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Andromon Setup"
  !define MUI_WELCOMEPAGE_TEXT "Andromon manages an Android phone from this computer: messages, contacts, photos, files, apps and the phone's screen, over a USB cable or Wi-Fi.$\r$\n$\r$\nSetup will install Andromon ${VERSION}. No drivers or Android tools are needed; a later page offers two optional ones.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Remove Andromon"
  !define MUI_WELCOMEPAGE_TEXT "Setup will remove Andromon from this computer.$\r$\n$\r$\nYour settings, paired phones and backups are kept. Nothing on your phone is changed.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

; ---------- "Optional tools" page: install Java and the Android platform tools before Andromon ----------
; Andromon works without either. Java 17 is needed only to patch apps on the ReVanced page; the platform
; tools add the adb command for people who also use a terminal. Nothing is ticked by default. A ticked tool
; is installed with Windows' own package manager (winget) when Next is pressed, before Andromon's files
; are copied; if winget is missing or fails, Setup offers to open the tool's download page instead.
!ifndef BUILD_UNINSTALLER
  !include "nsDialogs.nsh"
  !include "LogicLib.nsh"
  !include "WinMessages.nsh"

  Var ddJavaBox
  Var ddAdbBox
  Var ddState
  Var ddCode

  !macro customPageAfterChangeDir
    Page custom ddToolsShow ddToolsLeave
  !macroend

  Function ddToolsShow
    ; The page's title and subtitle (the wizard's header controls 1037 and 1038).
    GetDlgItem $0 $HWNDPARENT 1037
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Optional tools"
    GetDlgItem $0 $HWNDPARENT 1038
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Andromon works without these. Tick what Setup should install first."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 26u "Andromon talks to the phone by itself, so neither tool is required. Tick one to have Setup download and install it now, before Andromon."
    Pop $0

    ; Is Java on this computer already?
    nsExec::ExecToStack 'cmd /c java -version'
    Pop $ddCode
    Pop $0
    ${NSD_CreateCheckbox} 0 34u 100% 12u "Java 17 (Eclipse Temurin)"
    Pop $ddJavaBox
    ${If} $ddCode == 0
      ${NSD_CreateLabel} 12u 48u 96% 20u "Needed only to patch apps on the ReVanced page. Java was found on this computer, so you can leave this off."
    ${Else}
      ${NSD_CreateLabel} 12u 48u 96% 20u "Needed only to patch apps on the ReVanced page. Java was not found on this computer."
    ${EndIf}
    Pop $0

    nsExec::ExecToStack 'cmd /c adb version'
    Pop $ddCode
    Pop $0
    ${NSD_CreateCheckbox} 0 74u 100% 12u "Android platform tools (the adb command)"
    Pop $ddAdbBox
    ${If} $ddCode == 0
      ${NSD_CreateLabel} 12u 88u 96% 20u "Only for using adb in a terminal yourself. It was found on this computer."
    ${Else}
      ${NSD_CreateLabel} 12u 88u 96% 20u "Only for using adb in a terminal yourself. Andromon does not need it."
    ${EndIf}
    Pop $0

    ${NSD_CreateLabel} 0 116u 100% 20u "Both come from their makers through Windows' package manager (winget). You can also install them later from Andromon's Settings."
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function ddToolsLeave
    ${NSD_GetState} $ddJavaBox $ddState
    ${If} $ddState == ${BST_CHECKED}
      Banner::show /set 76 "Installing Java 17" "This can take a few minutes. Windows may ask for permission."
      nsExec::ExecToStack 'cmd /c winget install -e --id EclipseAdoptium.Temurin.17.JRE --silent --accept-package-agreements --accept-source-agreements'
      Pop $ddCode
      Pop $0
      Banner::destroy
      ${If} $ddCode != 0
        MessageBox MB_YESNO|MB_ICONEXCLAMATION "Setup could not install Java by itself (Windows' package manager is missing, or the installation failed).$\r$\n$\r$\nOpen Java's download page instead? Andromon's setup continues either way." IDNO ddJavaDone
        ExecShell "open" "https://adoptium.net/temurin/releases/?version=17"
        ddJavaDone:
      ${EndIf}
    ${EndIf}

    ${NSD_GetState} $ddAdbBox $ddState
    ${If} $ddState == ${BST_CHECKED}
      Banner::show /set 76 "Installing the Android platform tools" "This can take a minute."
      nsExec::ExecToStack 'cmd /c winget install -e --id Google.PlatformTools --silent --accept-package-agreements --accept-source-agreements'
      Pop $ddCode
      Pop $0
      Banner::destroy
      ${If} $ddCode != 0
        MessageBox MB_YESNO|MB_ICONEXCLAMATION "Setup could not install the Android platform tools by itself.$\r$\n$\r$\nOpen their download page instead? Andromon's setup continues either way." IDNO ddAdbDone
        ExecShell "open" "https://developer.android.com/tools/releases/platform-tools"
        ddAdbDone:
      ${EndIf}
    ${EndIf}
  FunctionEnd
!endif
