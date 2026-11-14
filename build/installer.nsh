; Droid Desk setup wizard: extra pages for electron-builder's assisted NSIS installer.
; Order of pages: Welcome > who to install for > folder > installing > Finish (with "Run Droid Desk").
; A licence page appears by itself when a build/license.txt (or .rtf/.html) file is added.

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Droid Desk Setup"
  !define MUI_WELCOMEPAGE_TEXT "Droid Desk manages an Android phone from this computer: messages, contacts, photos, files, apps and the phone's screen, over a USB cable or Wi-Fi.$\r$\n$\r$\nSetup will install Droid Desk ${VERSION}. No drivers or Android tools are needed.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Remove Droid Desk"
  !define MUI_WELCOMEPAGE_TEXT "Setup will remove Droid Desk from this computer.$\r$\n$\r$\nYour settings, paired phones and backups are kept. Nothing on your phone is changed.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
