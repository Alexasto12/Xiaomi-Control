package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed bridge.py
var bridgeScript []byte

const (
	deviceIP                = "192.168.1.163"
	deviceToken             = "259f844702c6c47f4998c2fd3c5d6908"
	pythonBin               = "C:\\Python314\\python.exe"
	indoorTelemetryInterval = 15 * time.Second
	outdoorAQInterval       = 60 * time.Second
	bridgeTimeout           = 12 * time.Second
	outdoorHTTPTimeout      = 10 * time.Second
	outdoorDefaultCity      = "Granollers"
	openMeteoGeocodeURL     = "https://geocoding-api.open-meteo.com/v1/search"
	openMeteoAirURL         = "https://air-quality-api.open-meteo.com/v1/air-quality"
)

var filterPropertyCandidates = []miotProperty{
	{Did: "filter", Siid: 4, Piid: 1},
	{Did: "filter", Siid: 4, Piid: 3},
	{Did: "filter", Siid: 4, Piid: 4},
}

type App struct {
	ctx          context.Context
	daemonCtx    context.Context
	daemonCancel context.CancelFunc

	stateMu            sync.RWMutex
	outdoorCity        string
	geocodeCache       map[string]geoPoint
	filterCandidateIdx int
}

type miotProperty struct {
	Did   string      `json:"did"`
	Siid  int         `json:"siid"`
	Piid  int         `json:"piid"`
	Value interface{} `json:"value,omitempty"`
}

type miotTelemetryItem struct {
	Code    int         `json:"code"`
	Did     string      `json:"did"`
	Siid    int         `json:"siid"`
	Piid    int         `json:"piid"`
	Value   interface{} `json:"value,omitempty"`
	Message string      `json:"message,omitempty"`
}

type miotResult struct {
	Code    int    `json:"code"`
	Message string `json:"message,omitempty"`
}

type geoPoint struct {
	Name      string
	Latitude  float64
	Longitude float64
}

type outdoorAQSnapshot struct {
	City      string  `json:"city"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	PM25      float64 `json:"pm25"`
	UpdatedAt string  `json:"updatedAt"`
	Source    string  `json:"source"`
}

type openMeteoGeoResponse struct {
	Results []openMeteoGeoResult `json:"results"`
}

type openMeteoGeoResult struct {
	Name      string  `json:"name"`
	Admin1    string  `json:"admin1"`
	Country   string  `json:"country"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

type openMeteoAQResponse struct {
	Current struct {
		Time string   `json:"time"`
		PM25 *float64 `json:"pm2_5"`
	} `json:"current"`
	Hourly struct {
		Time []string   `json:"time"`
		PM25 []*float64 `json:"pm2_5"`
	} `json:"hourly"`
}

func NewApp() *App {
	return &App{
		outdoorCity:        outdoorDefaultCity,
		geocodeCache:       make(map[string]geoPoint),
		filterCandidateIdx: 0,
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.daemonCtx, a.daemonCancel = context.WithCancel(ctx)
	go a.startTelemetryDaemon()
	go a.startOutdoorAQDaemon()
}

func (a *App) shutdown(_ context.Context) {
	if a.daemonCancel != nil {
		a.daemonCancel()
	}
}

func (a *App) startTelemetryDaemon() {
	ticker := time.NewTicker(indoorTelemetryInterval)
	defer ticker.Stop()

	a.emitTelemetryEvent()

	for {
		select {
		case <-a.daemonCtx.Done():
			return
		case <-a.ctx.Done():
			return
		case <-ticker.C:
			a.emitTelemetryEvent()
		}
	}
}

func (a *App) startOutdoorAQDaemon() {
	ticker := time.NewTicker(outdoorAQInterval)
	defer ticker.Stop()

	a.emitOutdoorAQEvent()

	for {
		select {
		case <-a.daemonCtx.Done():
			return
		case <-a.ctx.Done():
			return
		case <-ticker.C:
			a.emitOutdoorAQEvent()
		}
	}
}

func (a *App) emitTelemetryEvent() {
	if a.ctx == nil {
		return
	}

	raw, err := a.GetTelemetry()
	if err != nil {
		runtime.EventsEmit(a.ctx, "telemetry_error", err.Error())
		return
	}

	runtime.EventsEmit(a.ctx, "telemetry_update", raw)
}

func (a *App) emitOutdoorAQEvent() {
	if a.ctx == nil {
		return
	}

	snapshot, err := a.fetchOutdoorAQ()
	if err != nil {
		runtime.EventsEmit(a.ctx, "outdoor_aq_error", err.Error())
		return
	}

	payload, err := json.Marshal(snapshot)
	if err != nil {
		runtime.EventsEmit(a.ctx, "outdoor_aq_error", fmt.Sprintf("outdoor payload marshal error: %s", err.Error()))
		return
	}

	runtime.EventsEmit(a.ctx, "outdoor_aq_update", string(payload))
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

	cmdCtx, cancel := context.WithTimeout(context.Background(), bridgeTimeout)
	defer cancel()

	cmd := exec.CommandContext(cmdCtx, pythonBin, bridgePath, deviceIP, deviceToken, action, payload)
	setCmdHideWindow(cmd)
	out, err := cmd.CombinedOutput()
	raw := strings.TrimSpace(string(out))

	if errors.Is(cmdCtx.Err(), context.DeadlineExceeded) {
		return "", fmt.Errorf("miot bridge timeout after %s", bridgeTimeout)
	}

	if err != nil {
		if raw == "" {
			raw = err.Error()
		}
		return "", fmt.Errorf("miot bridge error: %s", normalizeBridgeError(raw))
	}

	return raw, nil
}

func normalizeBridgeError(raw string) string {
	clean := strings.TrimSpace(raw)
	if clean == "" {
		return "bridge command failed with no output"
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(clean), &payload); err == nil {
		if msg, ok := payload["error"].(string); ok && strings.TrimSpace(msg) != "" {
			return strings.TrimSpace(msg)
		}
	}

	if strings.Contains(clean, "Traceback (most recent call last):") {
		lines := strings.Split(clean, "\n")
		for i := len(lines) - 1; i >= 0; i-- {
			line := strings.TrimSpace(lines[i])
			if line == "" {
				continue
			}
			if strings.HasPrefix(line, "File ") || strings.HasPrefix(line, "Traceback") {
				continue
			}
			return line
		}
	}

	lines := strings.Split(clean, "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

func marshalPayload(props []miotProperty) (string, error) {
	b, err := json.Marshal(props)
	if err != nil {
		return "", fmt.Errorf("payload marshal error: %w", err)
	}
	return string(b), nil
}

func propertyLabel(did string) string {
	switch did {
	case "pwr":
		return "power"
	case "mod":
		return "mode"
	case "fan":
		return "fan speed"
	case "filter":
		return "filter status"
	default:
		return did
	}
}

func validateSetResponse(raw string, did string) error {
	var results []miotResult
	if err := json.Unmarshal([]byte(raw), &results); err != nil {
		return fmt.Errorf("invalid bridge response: %w", err)
	}

	if len(results) == 0 {
		return errors.New("empty bridge response")
	}

	for _, item := range results {
		if item.Code != 0 {
			if item.Code == -4001 {
				return fmt.Errorf("%s is not readable or unsupported by this device profile", propertyLabel(did))
			}

			if item.Code == -4002 {
				if did == "fan" {
					return errors.New("fan speed is not writable in the current mode or unsupported by this device profile")
				}
				return fmt.Errorf("%s is not writable for this device profile", propertyLabel(did))
			}

			if item.Message != "" {
				return fmt.Errorf("miot error code %d: %s", item.Code, item.Message)
			}
			return fmt.Errorf("miot error code %d", item.Code)
		}
	}

	return nil
}

func (a *App) GetTelemetry() (string, error) {
	props := []miotProperty{
		{Did: "pwr", Siid: 2, Piid: 1},
		{Did: "pm25", Siid: 3, Piid: 4},
		{Did: "mod", Siid: 2, Piid: 4},
		{Did: "fan", Siid: 2, Piid: 5},
	}

	if filterProperty, ok := a.currentFilterProperty(); ok {
		props = append(props, filterProperty)
	}

	payload, err := marshalPayload(props)
	if err != nil {
		return "", err
	}

	raw, err := runMiotCmd("get_properties", payload)
	if err != nil {
		return "", err
	}

	a.updateFilterCandidate(raw)
	return raw, nil
}

func (a *App) SetPower(state bool) error {
	if err := a.setBoolProperty("pwr", 2, 1, state); err != nil {
		return err
	}

	go a.emitTelemetryEvent()
	return nil
}

func (a *App) SetMode(mode int) error {
	if mode < 0 || mode > 2 {
		return fmt.Errorf("invalid mode: %d", mode)
	}

	if err := a.setIntProperty("mod", 2, 4, mode); err != nil {
		return err
	}

	go a.emitTelemetryEvent()
	return nil
}

func (a *App) SetFanSpeed(speed int) error {
	if speed < 1 || speed > 3 {
		return fmt.Errorf("invalid fan speed: %d", speed)
	}

	if currentMode, err := a.readCurrentMode(); err == nil && currentMode != 2 {
		return errors.New("fan speed can only be changed in manual mode")
	}

	if err := a.setIntProperty("fan", 2, 5, speed); err != nil {
		return err
	}

	go a.emitTelemetryEvent()
	return nil
}

func (a *App) setBoolProperty(did string, siid int, piid int, value bool) error {
	return a.setProperty(did, siid, piid, value)
}

func (a *App) setIntProperty(did string, siid int, piid int, value int) error {
	return a.setProperty(did, siid, piid, value)
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

	return validateSetResponse(raw, did)
}

func (a *App) currentFilterProperty() (miotProperty, bool) {
	if len(filterPropertyCandidates) == 0 {
		return miotProperty{}, false
	}

	a.stateMu.RLock()
	idx := a.filterCandidateIdx
	a.stateMu.RUnlock()

	if idx < 0 || idx >= len(filterPropertyCandidates) {
		idx = 0
	}

	return filterPropertyCandidates[idx], true
}

func (a *App) updateFilterCandidate(raw string) {
	var items []miotTelemetryItem
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		return
	}

	a.stateMu.Lock()
	defer a.stateMu.Unlock()

	if len(filterPropertyCandidates) == 0 {
		return
	}

	idx := a.filterCandidateIdx
	if idx < 0 || idx >= len(filterPropertyCandidates) {
		idx = 0
		a.filterCandidateIdx = 0
	}

	candidate := filterPropertyCandidates[idx]
	entry, ok := findTelemetryEntry(items, candidate.Siid, candidate.Piid)
	if !ok {
		return
	}

	if entry.Code == 0 {
		return
	}

	if (entry.Code == -4001 || entry.Code == -4002) && idx < len(filterPropertyCandidates)-1 {
		a.filterCandidateIdx = idx + 1
	}
}

func findTelemetryEntry(items []miotTelemetryItem, siid int, piid int) (miotTelemetryItem, bool) {
	for _, item := range items {
		if item.Siid == siid && item.Piid == piid {
			return item, true
		}
	}

	return miotTelemetryItem{}, false
}

func (a *App) readCurrentMode() (int, error) {
	payload, err := marshalPayload([]miotProperty{{Did: "mod", Siid: 2, Piid: 4}})
	if err != nil {
		return 0, err
	}

	raw, err := runMiotCmd("get_properties", payload)
	if err != nil {
		return 0, err
	}

	var items []miotTelemetryItem
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		return 0, fmt.Errorf("mode probe parse error: %w", err)
	}

	entry, ok := findTelemetryEntry(items, 2, 4)
	if !ok {
		return 0, errors.New("mode probe did not return mode property")
	}

	if entry.Code != 0 {
		return 0, fmt.Errorf("mode probe failed with code %d", entry.Code)
	}

	mode, ok := asInt(entry.Value)
	if !ok {
		return 0, errors.New("mode probe returned non-integer value")
	}

	return mode, nil
}

func asInt(value interface{}) (int, bool) {
	switch v := value.(type) {
	case int:
		return v, true
	case int32:
		return int(v), true
	case int64:
		return int(v), true
	case float32:
		return int(v), true
	case float64:
		return int(v), true
	default:
		return 0, false
	}
}

func (a *App) GetOutdoorCity() string {
	a.stateMu.RLock()
	defer a.stateMu.RUnlock()

	if strings.TrimSpace(a.outdoorCity) == "" {
		return outdoorDefaultCity
	}

	return a.outdoorCity
}

func (a *App) SetOutdoorCity(city string) error {
	clean := strings.TrimSpace(city)
	if clean == "" {
		return errors.New("outdoor city cannot be empty")
	}

	resolved, err := a.resolveCity(clean)
	if err != nil {
		return err
	}

	a.stateMu.Lock()
	a.outdoorCity = resolved.Name
	a.stateMu.Unlock()

	go a.emitOutdoorAQEvent()
	return nil
}

func (a *App) fetchOutdoorAQ() (outdoorAQSnapshot, error) {
	city := a.GetOutdoorCity()
	point, err := a.resolveCity(city)
	if err != nil {
		return outdoorAQSnapshot{}, err
	}

	pm25, measuredAt, err := fetchOutdoorPM25(point.Latitude, point.Longitude)
	if err != nil {
		return outdoorAQSnapshot{}, err
	}

	return outdoorAQSnapshot{
		City:      point.Name,
		Latitude:  point.Latitude,
		Longitude: point.Longitude,
		PM25:      math.Round(pm25*10) / 10,
		UpdatedAt: measuredAt,
		Source:    "open-meteo",
	}, nil
}

func (a *App) resolveCity(city string) (geoPoint, error) {
	trimmed := strings.TrimSpace(city)
	if trimmed == "" {
		return geoPoint{}, errors.New("outdoor city cannot be empty")
	}

	cacheKey := strings.ToLower(trimmed)
	a.stateMu.RLock()
	cached, ok := a.geocodeCache[cacheKey]
	a.stateMu.RUnlock()
	if ok {
		return cached, nil
	}

	query := url.Values{}
	query.Set("name", trimmed)
	query.Set("count", "1")
	query.Set("language", "en")
	query.Set("format", "json")

	endpoint := fmt.Sprintf("%s?%s", openMeteoGeocodeURL, query.Encode())

	var response openMeteoGeoResponse
	if err := getJSON(endpoint, &response); err != nil {
		return geoPoint{}, fmt.Errorf("outdoor city lookup failed: %w", err)
	}

	if len(response.Results) == 0 {
		return geoPoint{}, fmt.Errorf("outdoor city not found: %s", trimmed)
	}

	result := response.Results[0]
	point := geoPoint{
		Name:      formatResolvedCityName(result),
		Latitude:  result.Latitude,
		Longitude: result.Longitude,
	}

	a.stateMu.Lock()
	a.geocodeCache[cacheKey] = point
	a.stateMu.Unlock()

	return point, nil
}

func formatResolvedCityName(item openMeteoGeoResult) string {
	parts := []string{strings.TrimSpace(item.Name)}
	if admin := strings.TrimSpace(item.Admin1); admin != "" {
		parts = append(parts, admin)
	}
	if country := strings.TrimSpace(item.Country); country != "" {
		parts = append(parts, country)
	}

	return strings.Join(parts, ", ")
}

func fetchOutdoorPM25(latitude float64, longitude float64) (float64, string, error) {
	query := url.Values{}
	query.Set("latitude", fmt.Sprintf("%.6f", latitude))
	query.Set("longitude", fmt.Sprintf("%.6f", longitude))
	query.Set("current", "pm2_5")
	query.Set("hourly", "pm2_5")
	query.Set("timezone", "auto")

	endpoint := fmt.Sprintf("%s?%s", openMeteoAirURL, query.Encode())

	var response openMeteoAQResponse
	if err := getJSON(endpoint, &response); err != nil {
		return 0, "", fmt.Errorf("outdoor air-quality fetch failed: %w", err)
	}

	if response.Current.PM25 != nil {
		updatedAt := strings.TrimSpace(response.Current.Time)
		if updatedAt == "" {
			updatedAt = time.Now().Format(time.RFC3339)
		}
		return *response.Current.PM25, updatedAt, nil
	}

	for idx := len(response.Hourly.PM25) - 1; idx >= 0; idx-- {
		value := response.Hourly.PM25[idx]
		if value == nil {
			continue
		}

		updatedAt := time.Now().Format(time.RFC3339)
		if idx < len(response.Hourly.Time) && strings.TrimSpace(response.Hourly.Time[idx]) != "" {
			updatedAt = response.Hourly.Time[idx]
		}

		return *value, updatedAt, nil
	}

	return 0, "", errors.New("outdoor PM2.5 is not available from provider response")
}

func getJSON(endpoint string, target interface{}) error {
	requestCtx, cancel := context.WithTimeout(context.Background(), outdoorHTTPTimeout)
	defer cancel()

	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return fmt.Errorf("request creation failed: %w", err)
	}

	client := &http.Client{Timeout: outdoorHTTPTimeout}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode > 299 {
		snippet, _ := io.ReadAll(io.LimitReader(response.Body, 256))
		return fmt.Errorf("provider HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(snippet)))
	}

	decoder := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("response decode failed: %w", err)
	}

	return nil
}
