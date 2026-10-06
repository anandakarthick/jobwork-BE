@echo off
setlocal EnableDelayedExpansion
title Jobwork launcher

rem =============================================================================
rem  Jobwork - one-click start.
rem  Checks the machine (Node.js, Python + OCR libraries, MySQL), installs what is
rem  missing where it can, starts the backend (:4000) and the frontend (:5175) in
rem  their own windows, waits until the backend answers, then opens the app.
rem  Paths are relative to this file, so it works from a desktop shortcut.
rem =============================================================================
set "ROOT=%~dp0"
set "NEED_RERUN="

echo.
echo  Jobwork - checking the machine...
echo.

rem --- Node.js -----------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo  [node]     Node.js is not installed - installing with winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
  if errorlevel 1 (
    echo  [node]     Automatic install failed. Install Node.js LTS from https://nodejs.org and run start.bat again.
    pause
    exit /b 1
  )
  set "NEED_RERUN=1"
) else (
  for /f "tokens=*" %%v in ('node --version') do echo  [node]     Node.js %%v
)

rem --- Python (for the OCR training script) -----------------------------------
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY ( python --version >nul 2>&1 && set "PY=python" )
if not defined PY (
  echo  [python]   Python is not installed - installing Python 3.12 with winget...
  winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements --silent
  if errorlevel 1 (
    echo  [python]   winget failed - downloading the installer from python.org...
    powershell -NoProfile -Command "Invoke-WebRequest -Uri https://www.python.org/ftp/python/3.12.6/python-3.12.6-amd64.exe -OutFile $env:TEMP\python-installer.exe"
    if exist "%TEMP%\python-installer.exe" (
      "%TEMP%\python-installer.exe" /quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 Include_pip=1
      del "%TEMP%\python-installer.exe" >nul 2>&1
    ) else (
      echo  [python]   Could not download Python. Install it from https://www.python.org/downloads/ and run start.bat again.
      pause
      exit /b 1
    )
  )
  rem The new PATH is only visible to new processes - try the launcher, which goes to the Windows folder.
  py -3 --version >nul 2>&1 && set "PY=py -3"
  if not defined PY set "NEED_RERUN=1"
)
if defined PY (
  for /f "tokens=*" %%v in ('%PY% --version') do echo  [python]   %%v
  rem OCR libraries (PyMuPDF + RapidOCR). Installed once; no other program needed.
  %PY% -c "import fitz, rapidocr_onnxruntime" >nul 2>&1
  if errorlevel 1 (
    echo  [python]   installing the OCR libraries ^(first run, a few minutes^)...
    %PY% -m pip install --quiet --disable-pip-version-check --no-warn-script-location pymupdf rapidocr-onnxruntime
    %PY% -c "import fitz, rapidocr_onnxruntime" >nul 2>&1
    if errorlevel 1 (
      echo  [python]   OCR libraries could not be installed. Training will use the PDF text layer only
      echo             until you run:  %PY% -m pip install pymupdf rapidocr-onnxruntime
    ) else (
      echo  [python]   OCR libraries ready.
    )
  ) else (
    echo  [python]   OCR libraries ready.
  )
)

if defined NEED_RERUN (
  echo.
  echo  Software was installed. Please close this window and run start.bat again
  echo  so the new installation is picked up.
  pause
  exit /b 0
)

rem --- MySQL must be up (XAMPP) -----------------------------------------------
netstat -ano | findstr /r /c:":3306 .*LISTENING" >nul
if errorlevel 1 (
  echo  [mysql]    MySQL is not listening on port 3306 - start it in XAMPP first.
  echo             The backend cannot reach the database until it runs.
) else (
  echo  [mysql]    running on 3306
)

rem --- backend\.env must exist ------------------------------------------------
if not exist "%ROOT%backend\.env" (
  echo  [config]   backend\.env is missing. Create it with at least:
  echo             DATABASE_URL="mysql://root:@localhost:3306/jobwork_local"
  echo             PORT=4000
  echo             JWT_SECRET=^<a long random string^>
  pause
  exit /b 1
)

rem --- Stop any earlier copies so the ports are free (avoids EADDRINUSE) ------
call "%ROOT%stop.bat" >nul 2>&1

echo.
echo  Jobwork - starting...
echo.

rem --- Backend -----------------------------------------------------------------
if not exist "%ROOT%backend\node_modules\" (
  echo  [backend]  installing dependencies ^(first run^)...
  pushd "%ROOT%backend"
  call npm install
  call npx prisma generate
  popd
)
echo  [backend]  starting on http://localhost:4000 ...
rem migrate deploy = apply new database migrations; prisma generate = rebuild the DB
rem client for the current schema (needed after every git pull that changes it).
start "Jobwork backend :4000" cmd /k "cd /d "%ROOT%backend" && npx prisma migrate deploy && npx prisma generate && npm run dev"

rem --- Frontend ----------------------------------------------------------------
if not exist "%ROOT%frontend\node_modules\" (
  echo  [frontend] installing dependencies ^(first run^)...
  pushd "%ROOT%frontend"
  call npm install
  popd
)
echo  [frontend] starting on http://localhost:5175 ...
start "Jobwork frontend :5175" cmd /k "cd /d "%ROOT%frontend" && npm run dev"

rem --- Wait for the backend to answer before opening the browser -------------
echo.
echo  Waiting for the backend to be ready
set /a tries=0
:waitloop
set /a tries+=1
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri http://localhost:4000/api/settings/app -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto ready
if !tries! geq 60 goto timeout
<nul set /p "=."
timeout /t 2 /nobreak >nul
goto waitloop

:ready
echo.
echo  [backend]  ready.
start "" http://localhost:5175
echo.
echo  Both windows are running. Use stop.bat (or close the windows) to stop.
echo.
timeout /t 5 >nul
exit /b 0

:timeout
echo.
echo  [error]  The backend did not start within 2 minutes.
echo           Look at the "Jobwork backend :4000" window for the error
echo           (usually: MySQL not running, or backend\.env wrong).
echo.
pause
exit /b 1
