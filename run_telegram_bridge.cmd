@echo off
setlocal

set "ROOT=%~dp0"
set "NODE_EXE="
set "PYTHON_EXE="

for %%N in (
  "C:\Program Files\nodejs\node.exe"
) do (
  if exist %%~N (
    set "NODE_EXE=%%~N"
    goto :node_found
  )
)

for %%P in (
  "C:\Users\kanzi\AppData\Local\Python\pythoncore-3.14-64\python.exe"
  "C:\Users\kanzi\AppData\Local\Python\bin\python.exe"
  "C:\Users\kanzi\AppData\Local\Microsoft\WindowsApps\python.exe"
) do (
  if exist %%~P (
    set "PYTHON_EXE=%%~P"
    goto :python_found
  )
)

echo Neither Node.js nor Python executable was found.
echo Checked:
echo C:\Program Files\nodejs\node.exe
echo C:\Users\kanzi\AppData\Local\Python\pythoncore-3.14-64\python.exe
echo C:\Users\kanzi\AppData\Local\Python\bin\python.exe
echo C:\Users\kanzi\AppData\Local\Microsoft\WindowsApps\python.exe
exit /b 1

:node_found
echo Using Node:
echo %NODE_EXE%
cd /d "%ROOT%"
"%NODE_EXE%" "%ROOT%scripts\telegram_bridge.js"
exit /b %ERRORLEVEL%

:python_found
echo Using Python:
echo %PYTHON_EXE%
cd /d "%ROOT%"
"%PYTHON_EXE%" "%ROOT%scripts\telegram_bridge.py"
exit /b %ERRORLEVEL%
