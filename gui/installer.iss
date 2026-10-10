; Inno Setup script — produces a proper Windows installer with a wizard,
; Start Menu shortcut, desktop icon option, and uninstaller.
;
; To build: install Inno Setup (jrsoftware.org/isinfo.php), open this file
; in the Inno Setup Compiler, click Build > Compile.
; Output: installer_output\PTFSTracker_Setup.exe

#define MyAppName "PTFS Tracker"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "YourName"
#define MyAppExeName "PTFSTracker.exe"

[Setup]
AppId={{B9E4B6B0-6C1E-4B0E-9B0A-PTFSTRACKER01}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=installer_output
OutputBaseFilename=PTFSTracker_Setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
SetupIconFile=icon.ico

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; dist\PTFSTracker.exe is produced by `pyinstaller build.spec`
Source: "dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
