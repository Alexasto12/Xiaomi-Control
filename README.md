# Xiaomi MIOT Local Dashboard

![Platform](https://img.shields.io/badge/Platform-Windows-blue?style=flat-square)
![Stack](https://img.shields.io/badge/Stack-Go%20%2B%20React%20%2B%20TypeScript-blueviolet?style=flat-square)
![Runtime](https://img.shields.io/badge/Integration-Wails-brightgreen?style=flat-square)

Aplicación de escritorio local para monitorizar y controlar un purificador Xiaomi Smart Air Purifier 4 Compact (`zhimi.airp.cpa4`) con arquitectura de puente nativo basada en Wails.

## Características principales

- Panel de telemetría en tiempo real para PM2.5 con codificación de color intuitiva.
- Control de energía `On/Off`, modos de operación (`Auto`, `Sleep`, `Manual`) y velocidad de ventilador 1-3.
- Cadencia push indoor cada 15 segundos (sin polling en React).
- PM2.5 exterior con Open-Meteo cada 60 segundos, configurable por ciudad desde la UI.
- Gestión de conexión robusta: la interfaz muestra `Online` o `Offline` según el resultado del puente MIOT.
- Gestión de capacidades del modelo: fan y filtro muestran soporte/no soporte sin romper la interfaz.
- Arquitectura local segura: el backend no utiliza HTTP, sino `os/exec` para invocar `bridge.py` y cifrar las solicitudes MIOT.

## Arquitectura del proyecto

- `bridge.py`: motor Python que cifra y envía payloads MIOT con `python-miio`.
- `main.go`: bootstrap Wails que carga assets embebidos y expone la aplicación de escritorio.
- `app.go`: backend Wails con métodos públicos para el frontend:
  - `GetTelemetry()`
  - `SetPower(state bool)`
  - `SetMode(mode int)`
  - `SetFanSpeed(speed int)`
  - `GetOutdoorCity()`
  - `SetOutdoorCity(city string)`
- `frontend/`: interfaz React + TypeScript y CSS puro.

## MIOT Mapping usado

El backend utiliza exclusivamente estos `siid`/`piid` para generar los payloads:

- PM2.5: `siid=3`, `piid=4`
- Power: `siid=2`, `piid=1`
- Mode: `siid=2`, `piid=4`
- Fan Speed: `siid=2`, `piid=5`

## Uso

### Backend

```powershell
go mod tidy
go build ./...
```

### Ejecutar la app

- En PowerShell:

```powershell
.\run.ps1
```

- En CMD:

```cmd
run.bat
```

> Importante: no utilices `go run main.go`, ya que Go necesita compilar todos los archivos del paquete.

### Frontend

```powershell
cd frontend
npm install
npm run build
```

## Requisitos

- Windows 10/11
- Python 3.14 con `python-miio`
- `C:\Python314\python.exe`
- Wails instalado para compilar el paquete de escritorio nativo

## Diseño UI

- Estética técnica y funcional, inspirada en dashboards industriales.
- Tipografía monoespaciada para datos numéricos.
- Controles discretos para modo y velocidad del ventilador.
- Se prioriza lectura rápida y estado claro sin animaciones innecesarias.

## Notas adicionales

- El backend invoca el puente MIOT a través de un `bridge.py` embebido, lo que permite que el ejecutable funcione sin depender de rutas relativas externas.
- La UI no expone endpoints HTTP externos; la comunicación es interna entre React y el backend Wails.
- En Windows el proceso Python del bridge se ejecuta oculto para evitar popups de consola.
- El estado de filtro depende del modelo MIOT; si la propiedad no existe, la UI lo reporta como no soportado con su código MIOT.
