@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut($d+'\Mini ERP.lnk'); $s.TargetPath='%~dp0Iniciar Mini ERP.bat'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%SystemRoot%\System32\shell32.dll,21'; $s.Save()"
echo Atalho "Mini ERP" criado na Area de Trabalho.
pause
