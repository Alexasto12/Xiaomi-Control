@echo off
cd /d "%~dp0"
cd frontend
call npm run build
cd ..
go run .
