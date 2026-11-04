; Math Notebook setup (Inno Setup 6). Built by notebook\build_release.py, which first makes the
; portable build and then runs:  ISCC /DAppVersion=x.y.z /DSourceDir=...\dist\Math Notebook MathNotebook.iss
; Only standard Windows controls, so NVDA reads every page, button and checkbox.

#ifndef AppVersion
  #error Give the version: /DAppVersion=x.y.z (build_release.py reads it from notebook\VERSION)
#endif
#ifndef SourceDir
  #define SourceDir "..\..\dist\Math Notebook"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\dist"
#endif

[Setup]
; The same AppId in every version, so a newer setup upgrades the installed copy in place.
AppId={{8B9D73FD-2AE0-454B-854B-C0F5BDB4DA68}
AppName=Math Notebook
AppVersion={#AppVersion}
AppVerName=Math Notebook {#AppVersion}
AppPublisher=Emir (personal project)
AppPublisherURL=https://github.com/ahemyaz06/math-lm
AppSupportURL=https://github.com/ahemyaz06/math-lm
AppUpdatesURL=https://github.com/ahemyaz06/math-lm/releases
VersionInfoVersion={#AppVersion}
VersionInfoProductName=Math Notebook
VersionInfoDescription=Math Notebook setup
; For this user only by default (no admin prompt); a first dialog offers all users instead.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
DefaultDirName={autopf}\Math Notebook
DisableDirPage=auto
DisableProgramGroupPage=yes
DisableWelcomePage=no
DisableReadyPage=yes
ShowLanguageDialog=no
UsePreviousAppDir=yes
CloseApplications=yes
WizardStyle=modern
SetupIconFile=MathNotebook.ico
UninstallDisplayIcon={app}\MathNotebook.ico
UninstallDisplayName=Math Notebook
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
Compression=lzma2/max
SolidCompression=yes
OutputDir={#OutputDir}
OutputBaseFilename=Math-Notebook-Setup

[Messages]
WelcomeLabel1=Install Math Notebook {#AppVersion}
WelcomeLabel2=This puts Math Notebook on this computer, with a Start menu shortcut and an uninstaller in Windows' Installed apps.%n%nThis version has no AI add-on: PDFs are read by exact rules on this computer, and nothing is sent anywhere.%n%nYour settings and the PDFs you import are kept in your own AppData folder, so installing a newer version keeps them.%n%nMath Notebook is not code-signed, so Windows SmartScreen may have warned you before this window. That is expected.%n%nPress Next to continue, or Cancel to stop.
FinishedLabel=Math Notebook is installed. Find it in the Start menu under Math Notebook.

[Tasks]
; Unchecked: the Start menu shortcut is always made, a desktop shortcut only if asked for.
Name: "desktopicon"; Description: "Also put a shortcut on the &desktop"; Flags: unchecked

[InstallDelete]
; An upgrade replaces the old program files completely (the data lives elsewhere).
Type: filesandordirs; Name: "{app}\resources"
Type: filesandordirs; Name: "{app}\locales"

[Files]
; The portable build, except its read-me (which says the data stays beside the exe).
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "\Read me first.txt,\data"; Flags: ignoreversion recursesubdirs createallsubdirs
; The marker that tells the app it is installed: data in %LOCALAPPDATA%\MathNotebook.
Source: "INSTALLED"; DestDir: "{app}\resources\app\notebook"; Flags: ignoreversion
Source: "MathNotebook.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Math Notebook"; Filename: "{app}\Math Notebook.exe"; IconFilename: "{app}\MathNotebook.ico"; Comment: "A maths notebook that reads well with NVDA and MathCAT"
Name: "{autodesktop}\Math Notebook"; Filename: "{app}\Math Notebook.exe"; IconFilename: "{app}\MathNotebook.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\Math Notebook.exe"; Description: "&Start Math Notebook now"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: dirifempty; Name: "{app}"

[Code]
var
  KeepData: Boolean;

// The same folder the app uses: %LOCALAPPDATA%\MathNotebook (the app reads the variable too).
function DataDir(): String;
begin
  Result := GetEnv('LOCALAPPDATA');
  if Result = '' then
    Result := ExpandConstant('{localappdata}');
  Result := Result + '\MathNotebook';
end;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  // /REMOVEDATA deletes the data in a silent uninstall; otherwise it is kept unless the person says no.
  KeepData := Pos('/REMOVEDATA', Uppercase(GetCmdTail)) = 0;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usUninstall) and KeepData and not UninstallSilent and DirExists(DataDir()) then
    KeepData := MsgBox('Keep your Math Notebook settings and the PDFs it has read?' + #13#10#13#10 +
      'Yes keeps them, so they are there again if you install Math Notebook later.' + #13#10 +
      'No deletes them from this computer.' + #13#10#13#10 +
      'Notebooks, Word files and PDFs you saved yourself are never deleted.',
      mbConfirmation, MB_YESNO) = IDYES;
  if CurUninstallStep = usPostUninstall then
  begin
    // Python's cache files are not data; they always go.
    DelTree(DataDir() + '\cache', True, True, True);
    if not KeepData then
      DelTree(DataDir(), True, True, True);
  end;
end;
