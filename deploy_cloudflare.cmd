@echo off
setlocal

set "ROOT=%~dp0"
set "WRANGLER_CMD="

for %%W in (
  "%ROOT%node_modules\.bin\wrangler.cmd"
  "C:\Users\kanzi\AppData\Roaming\npm\wrangler.cmd"
) do (
  if exist %%~W (
    set "WRANGLER_CMD=%%~W"
    goto :wrangler_found
  )
)

echo Wrangler executable not found.
echo Checked:
echo %ROOT%node_modules\.bin\wrangler.cmd
echo C:\Users\kanzi\AppData\Roaming\npm\wrangler.cmd
echo.
echo Install once in a normal desktop PowerShell:
echo npm install -g wrangler
exit /b 1

:wrangler_found
echo Using Wrangler:
echo %WRANGLER_CMD%

cd /d "%ROOT%"
"%WRANGLER_CMD%" deploy

