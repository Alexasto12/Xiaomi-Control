package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

//go:embed bridge.py
var bridgeScript []byte

const (
	deviceIP    = "192.168.1.163"
	deviceToken = "259f844702c6c47f4998c2fd3c5d6908"
	pythonBin   = "C:\\Python314\\python.exe"
)

type App struct {
	ctx context.Context
}

type miotProperty struct {
	Did   string      `json:"did"`
	Siid  int         `json:"siid"`
	Piid  int         `json:"piid"`
	Value interface{} `json:"value,omitempty"`
}

type miotResult struct {
	Code    int    `json:"code"`
	Message string `json:"message,omitempty"`
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

func ensureBridgeScript() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("unable to locate executable path: %w", err)
	}

	exeDir := filepath.Dir(exePath)
	candidate := filepath.Join(exeDir, "bridge.py")
	if _, err := os.Stat(candidate); err == nil {
		return candidate, nil
	}

	tmpDir := filepath.Join(os.TempDir(), "xiaomi-miot-bridge")
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return "", fmt.Errorf("unable to create temp bridge directory: %w", err)
	}

	tmpPath := filepath.Join(tmpDir, "bridge.py")
	if err := os.WriteFile(tmpPath, bridgeScript, 0o755); err != nil {
		return "", fmt.Errorf("unable to write embedded bridge.py: %w", err)
	}

	return tmpPath, nil
}

func runMiotCmd(action string, payload string) (string, error) {
	bridgePath, err := ensureBridgeScript()
	if err != nil {
		return "", err
	}

	cmd := exec.Command(pythonBin, bridgePath, deviceIP, deviceToken, action, payload)
	out, err := cmd.CombinedOutput()
	raw := strings.TrimSpace(string(out))

	if err != nil {
		if raw == "" {
			raw = err.Error()
		}
		return "", fmt.Errorf("miot bridge error: %s", raw)
	}

	return raw, nil
}

func marshalPayload(props []miotProperty) (string, error) {
	b, err := json.Marshal(props)
	if err != nil {
		return "", fmt.Errorf("payload marshal error: %w", err)
	}
	return string(b), nil
}

func validateSetResponse(raw string) error {
	var results []miotResult
	if err := json.Unmarshal([]byte(raw), &results); err != nil {
		return fmt.Errorf("invalid bridge response: %w", err)
	}

	if len(results) == 0 {
		return errors.New("empty bridge response")
	}

	for _, item := range results {
		if item.Code != 0 {
			if item.Message != "" {
				return fmt.Errorf("miot error code %d: %s", item.Code, item.Message)
			}
			return fmt.Errorf("miot error code %d", item.Code)
		}
	}

	return nil
}

func (a *App) GetTelemetry() (string, error) {
	payload, err := marshalPayload([]miotProperty{
		{Did: "pm25", Siid: 3, Piid: 4},
		{Did: "pwr", Siid: 2, Piid: 1},
	})
	if err != nil {
		return "", err
	}

	return runMiotCmd("get_properties", payload)
}

func (a *App) SetPower(state bool) error {
	return a.setProperty("power", 2, 1, state)
}

func (a *App) SetMode(mode int) error {
	if mode < 0 || mode > 2 {
		return fmt.Errorf("invalid mode: %d", mode)
	}

	return a.setProperty("mode", 2, 4, mode)
}

func (a *App) SetFanSpeed(speed int) error {
	if speed < 1 || speed > 3 {
		return fmt.Errorf("invalid fan speed: %d", speed)
	}

	return a.setProperty("fan_speed", 2, 5, speed)
}

func (a *App) setProperty(did string, siid int, piid int, value interface{}) error {
	payload, err := marshalPayload([]miotProperty{{Did: did, Siid: siid, Piid: piid, Value: value}})
	if err != nil {
		return err
	}

	raw, err := runMiotCmd("set_properties", payload)
	if err != nil {
		return err
	}

	return validateSetResponse(raw)
}