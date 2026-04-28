@echo off
setlocal

set "ROOT=%~dp0"
set "PYTHON_EXE="

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

echo Python executable not found.
echo Checked:
echo C:\Users\kanzi\AppData\Local\Python\pythoncore-3.14-64\python.exe
echo C:\Users\kanzi\AppData\Local\Python\bin\python.exe
echo C:\Users\kanzi\AppData\Local\Microsoft\WindowsApps\python.exe
exit /b 1

:python_found
echo Using Python:
echo %PYTHON_EXE%

cd /d "%ROOT%"
"%PYTHON_EXE%" "%ROOT%scripts\telegram_bridge.py"
