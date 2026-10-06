@echo off
rem Stops the Jobwork dev servers: the windows started by start.bat, and anything
rem else still holding the backend (4000) or frontend (5175) port.
taskkill /fi "WINDOWTITLE eq Jobwork backend :4000*" /t /f >nul 2>&1
taskkill /fi "WINDOWTITLE eq Jobwork frontend :5175*" /t /f >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":4000 .*LISTENING"') do taskkill /pid %%p /t /f >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":5175 .*LISTENING"') do taskkill /pid %%p /t /f >nul 2>&1
echo  Jobwork servers stopped.
