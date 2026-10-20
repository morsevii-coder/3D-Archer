@echo off
git init
git add .
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMddHHmmss"') do set "COMMIT_DATE=%%i"
git commit -m "%COMMIT_DATE%"
git remote add origin https://github.com/morsevii-coder/3d-archer.git
git push
pause