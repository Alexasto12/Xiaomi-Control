# Xiaomi MIOT Local Dashboard

Aplicación de escritorio nativa para Windows construida con Wails (Go + React + TypeScript) que funciona como panel local de telemetría para el purificador Xiaomi Smart Air Purifier 4 Compact (`zhimi.airp.cpa4`).

## Arquitectura

- `bridge.py`: puente Python que cifra y envía payloads MIOT mediante `python-miio`.
- `main.go`: bootstrap de Wails que carga los assets embebidos y arranca la aplicación.
- `app.go`: backend Wails expone métodos para el frontend y ejecuta `bridge.py` con `os/exec`.
- `frontend/`: UI React + TypeScript con polling de telemetría y controles de Power, Mode y Fan Speed.

## Comandos

### Backend

```powershell
cd "c:\Users\Alexasto\Desktop\Xiaomi Control"
go mod tidy
go build ./...
```

### Frontend

```powershell
cd "c:\Users\Alexasto\Desktop\Xiaomi Control\frontend"
npm install
npm run build
```

## Requisitos

- Windows 10/11
- `C:\Python314\python.exe`
- Python 3.14 con `python-miio` instalado
- Wails configurado si se desea compilar el paquete nativo

## Notas

- El backend usa `python bridge.py <IP> <TOKEN> <ACTION> <JSON_PAYLOAD>`.
- El frontend realiza polling cada 5000 ms y muestra estado `Online`/`Offline`.
- Las propiedades MIOT usadas son:
  - PM2.5: `siid=3`, `piid=4`
  - Power: `siid=2`, `piid=1`
  - Mode: `siid=2`, `piid=4`
  - Fan Speed: `siid=2`, `piid=5`
