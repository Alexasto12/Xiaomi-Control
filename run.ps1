Set-Location $PSScriptRoot
Set-Location frontend
npm run build
Set-Location ..
go run .
