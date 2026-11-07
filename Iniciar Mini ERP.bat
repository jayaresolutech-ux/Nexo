@echo off
chcp 65001 >nul
title Mini ERP
cd /d "%~dp0"
set "ALVO=app.pyc"
if not exist "%ALVO%" set "ALVO=app.py"

call :achar
if defined PYCMD goto rodar

for %%I in (instalador\python-3.12*.exe) do set "INST=%%I"
if not defined INST (
  echo Python 3.12 nao encontrado e o instalador nao esta na pasta "instalador".
  echo Baixe em https://www.python.org/downloads/release/python-31210/
  pause
  exit /b 1
)
echo Instalando o Python 3.12 ^(necessario uma unica vez^)... aguarde.
"%INST%" /passive InstallAllUsers=0 PrependPath=1 Include_test=0 Include_launcher=1
call :achar
if not defined PYCMD (
  echo Nao foi possivel instalar o Python. Execute o instalador manualmente em "instalador".
  pause
  exit /b 1
)

:rodar
%PYCMD% "%ALVO%" %*
pause
exit /b

:achar
set "PYCMD="
py -3.12 -c "import sys" >nul 2>nul && set "PYCMD=py -3.12"
if not defined PYCMD python -c "import sys;sys.exit(sys.version_info[:2]!=(3,12))" >nul 2>nul && set "PYCMD=python"
if not defined PYCMD if exist "%LocalAppData%\Programs\Python\Python312\python.exe" set "PYCMD="%LocalAppData%\Programs\Python\Python312\python.exe""
exit /b
