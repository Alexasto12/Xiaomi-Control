import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  CloudSun,
  Gauge,
  LoaderCircle,
  MapPin,
  MoonStar,
  Power,
  Sparkles,
  Wind,
  Wrench,
} from "lucide-react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { GetOutdoorCity, SetFanSpeed, SetMode, SetOutdoorCity, SetPower } from "../wailsjs/go/main/App";
import { EventsOff, EventsOn } from "../wailsjs/runtime/runtime";

type ConnectionState = "connecting" | "online" | "offline";
type DeviceMode = 0 | 1 | 2;
type FanSpeed = 1 | 2 | 3;

interface MiotTelemetryItem {
  code: number;
  did: string;
  siid: number;
  piid: number;
  value?: number | boolean;
}

interface TelemetrySnapshot {
  pm25: number;
  power: boolean;
  mode: DeviceMode;
  fanSpeed: FanSpeed | null;
  fanSupported: boolean;
  fanCode: number | null;
  filterLife: number | null;
  filterSupported: boolean;
  filterCode: number | null;
}

interface OutdoorSnapshot {
  city: string;
  latitude: number;
  longitude: number;
  pm25: number;
  updatedAt: string;
  source: string;
}

interface Pm25HistoryPoint {
  time: string;
  pm25: number;
}

const HISTORY_LIMIT = 60;
const OUTDOOR_HISTORY_LIMIT = 24;
const DEFAULT_OUTDOOR_CITY = "Granollers";
const UI_REVISION = "push-sync-r7";

const FILTER_CANDIDATES: Array<{ siid: number; piid: number }> = [
  { siid: 4, piid: 1 },
  { siid: 4, piid: 3 },
  { siid: 4, piid: 4 },
];

const MODE_OPTIONS: Array<{ value: DeviceMode; label: string; hint: string }> = [
  { value: 0, label: "Auto", hint: "Adaptive" },
  { value: 1, label: "Sleep", hint: "Low noise" },
  { value: 2, label: "Manual", hint: "Direct speed" },
];

const FAN_SPEED_VALUES: FanSpeed[] = [1, 2, 3];

function isDeviceMode(value: number): value is DeviceMode {
  return value === 0 || value === 1 || value === 2;
}

function isFanSpeed(value: number): value is FanSpeed {
  return value === 1 || value === 2 || value === 3;
}

function isMiotTelemetryItem(value: unknown): value is MiotTelemetryItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<MiotTelemetryItem>;
  return (
    typeof candidate.code === "number" &&
    typeof candidate.did === "string" &&
    typeof candidate.siid === "number" &&
    typeof candidate.piid === "number" &&
    (candidate.value === undefined || typeof candidate.value === "number" || typeof candidate.value === "boolean")
  );
}

function parsePowerValue(value: number | boolean | undefined): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number" && (value === 0 || value === 1)) {
    return value === 1;
  }

  throw new Error("Power field missing or invalid");
}

function getEntry(items: MiotTelemetryItem[], siid: number, piid: number): MiotTelemetryItem | undefined {
  return items.find((item) => item.siid === siid && item.piid === piid);
}

function requireSuccessfulEntry(
  items: MiotTelemetryItem[],
  siid: number,
  piid: number,
  label: string
): MiotTelemetryItem {
  const entry = getEntry(items, siid, piid);
  if (!entry) {
    throw new Error(`${label} field missing`);
  }

  if (entry.code !== 0) {
    throw new Error(`${label} telemetry error code ${entry.code}`);
  }

  return entry;
}

function parseTelemetry(raw: string): TelemetrySnapshot {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Bridge payload is not an array");
  }

  const items = parsed;
  if (!items.every(isMiotTelemetryItem)) {
    throw new Error("Bridge payload has invalid item shape");
  }

  const pm25Entry = requireSuccessfulEntry(items, 3, 4, "PM2.5");
  const powerEntry = requireSuccessfulEntry(items, 2, 1, "Power");
  const modeEntry = requireSuccessfulEntry(items, 2, 4, "Mode");
  const fanEntry = getEntry(items, 2, 5);
  const filterEntry = FILTER_CANDIDATES.map((candidate) => getEntry(items, candidate.siid, candidate.piid)).find(
    (item) => item !== undefined
  );

  if (!pm25Entry || typeof pm25Entry.value !== "number") {
    throw new Error("PM2.5 field missing or invalid");
  }

  const powerValue = parsePowerValue(powerEntry.value);

  if (!modeEntry || typeof modeEntry.value !== "number" || !isDeviceMode(modeEntry.value)) {
    throw new Error("Mode field missing or invalid");
  }

  let fanSpeed: FanSpeed | null = null;
  let fanSupported = false;
  let fanCode: number | null = null;
  if (fanEntry && fanEntry.code === 0 && typeof fanEntry.value === "number" && isFanSpeed(fanEntry.value)) {
    fanSpeed = fanEntry.value;
    fanSupported = true;
  } else if (fanEntry) {
    fanCode = fanEntry.code;
  }

  let filterLife: number | null = null;
  let filterSupported = false;
  let filterCode: number | null = null;
  if (filterEntry && filterEntry.code === 0 && typeof filterEntry.value === "number") {
    filterLife = Math.round(filterEntry.value);
    filterSupported = true;
  } else if (filterEntry) {
    filterCode = filterEntry.code;
  }

  return {
    pm25: pm25Entry.value,
    power: powerValue,
    mode: modeEntry.value,
    fanSpeed,
    fanSupported,
    fanCode,
    filterLife,
    filterSupported,
    filterCode,
  };
}

function parseOutdoorSnapshot(raw: string): OutdoorSnapshot {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Outdoor payload is not an object");
  }

  const candidate = parsed as Partial<OutdoorSnapshot>;
  if (typeof candidate.city !== "string" || candidate.city.trim().length === 0) {
    throw new Error("Outdoor city missing");
  }

  if (typeof candidate.latitude !== "number" || typeof candidate.longitude !== "number") {
    throw new Error("Outdoor coordinates missing");
  }

  if (typeof candidate.pm25 !== "number") {
    throw new Error("Outdoor PM2.5 missing");
  }

  const updatedAt =
    typeof candidate.updatedAt === "string" && candidate.updatedAt.trim().length > 0
      ? candidate.updatedAt
      : new Date().toISOString();
  const source =
    typeof candidate.source === "string" && candidate.source.trim().length > 0 ? candidate.source : "open-meteo";

  return {
    city: candidate.city.trim(),
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    pm25: candidate.pm25,
    updatedAt,
    source,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getEventErrorMessage(eventData: unknown[]): string {
  const payload = eventData[0];

  if (typeof payload === "string" && payload.trim().length > 0) {
    return payload;
  }

  if (payload instanceof Error) {
    return payload.message;
  }

  if (payload === undefined || payload === null) {
    return "Unknown telemetry error";
  }

  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function getPm25Class(value: number | null): string {
  if (value === null) {
    return "pm25-unknown";
  }
  if (value <= 12) {
    return "pm25-good";
  }
  if (value <= 35) {
    return "pm25-moderate";
  }
  if (value <= 55) {
    return "pm25-sensitive";
  }
  return "pm25-danger";
}

function getPm25Tier(value: number | null): string {
  if (value === null) {
    return "No data";
  }
  if (value <= 12) {
    return "Good";
  }
  if (value <= 35) {
    return "Moderate";
  }
  if (value <= 55) {
    return "Sensitive";
  }
  return "Poor";
}

function getPm25Stroke(value: number | null): string {
  if (value === null) {
    return "#8ca2b8";
  }
  if (value <= 12) {
    return "#42e8a3";
  }
  if (value <= 35) {
    return "#f0c765";
  }
  if (value <= 55) {
    return "#f0a462";
  }
  return "#ff6a6a";
}

export default function App() {
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [pm25, setPm25] = useState<number | null>(null);
  const [power, setPower] = useState<boolean>(false);
  const [mode, setMode] = useState<DeviceMode>(0);
  const [fanSpeed, setFanSpeed] = useState<FanSpeed | null>(null);
  const [fanSupported, setFanSupported] = useState<boolean>(false);
  const [fanCode, setFanCode] = useState<number | null>(null);
  const [filterLife, setFilterLife] = useState<number | null>(null);
  const [filterSupported, setFilterSupported] = useState<boolean>(false);
  const [filterCode, setFilterCode] = useState<number | null>(null);
  const [pm25History, setPm25History] = useState<Pm25HistoryPoint[]>([]);
  const [outdoorHistory, setOutdoorHistory] = useState<Pm25HistoryPoint[]>([]);
  const [outdoorCity, setOutdoorCityName] = useState<string>(DEFAULT_OUTDOOR_CITY);
  const [outdoorInput, setOutdoorInput] = useState<string>(DEFAULT_OUTDOOR_CITY);
  const [outdoorSource, setOutdoorSource] = useState<string>("open-meteo");
  const [outdoorPm25, setOutdoorPm25] = useState<number | null>(null);
  const [outdoorLastUpdated, setOutdoorLastUpdated] = useState<string>("-");
  const [lastUpdated, setLastUpdated] = useState<string>("-");
  const [lastError, setLastError] = useState<string>("");
  const [outdoorError, setOutdoorError] = useState<string>("");
  const [isPowerPending, setIsPowerPending] = useState<boolean>(false);
  const [isModePending, setIsModePending] = useState<boolean>(false);
  const [isFanPending, setIsFanPending] = useState<boolean>(false);
  const [isOutdoorPending, setIsOutdoorPending] = useState<boolean>(false);

  const isManualMode = mode === 2;
  const fanControlsDisabled = !isManualMode || !fanSupported || isFanPending;
  const pm25Stroke = useMemo(() => getPm25Stroke(pm25), [pm25]);
  const pm25Class = useMemo(() => getPm25Class(pm25), [pm25]);
  const pm25Tier = useMemo(() => getPm25Tier(pm25), [pm25]);
  const outdoorPm25Stroke = useMemo(() => getPm25Stroke(outdoorPm25), [outdoorPm25]);
  const outdoorPm25Class = useMemo(() => getPm25Class(outdoorPm25), [outdoorPm25]);
  const outdoorPm25Tier = useMemo(() => getPm25Tier(outdoorPm25), [outdoorPm25]);
  const fanModeLabel = useMemo(() => {
    if (!isManualMode) {
      return "Speed locked outside manual mode";
    }

    if (!fanSupported) {
      if (fanCode !== null) {
        return `Manual mode: fan speed unsupported (code ${fanCode})`;
      }
      return "Manual mode: fan speed unsupported by telemetry";
    }

    if (fanSpeed === null) {
      return "Manual mode: waiting for speed telemetry";
    }

    return "Manual mode: speed enabled";
  }, [fanCode, fanSpeed, fanSupported, isManualMode]);
  const filterModeLabel = useMemo(() => {
    if (!filterSupported) {
      if (filterCode !== null) {
        return `Filter status unsupported (code ${filterCode})`;
      }
      return "Filter status unavailable for this model profile";
    }

    if (filterLife === null) {
      return "Filter status pending telemetry";
    }

    return `Filter life remaining: ${Math.max(0, filterLife)}%`;
  }, [filterCode, filterLife, filterSupported]);

  useEffect(() => {
    let isMounted = true;

    void GetOutdoorCity()
      .then((city) => {
        if (!isMounted) {
          return;
        }

        const trimmed = city.trim();
        if (trimmed.length > 0) {
          setOutdoorCityName(trimmed);
          setOutdoorInput(trimmed);
        }
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }

        setOutdoorError(getErrorMessage(error));
      });

    const unsubscribeTelemetry = EventsOn("telemetry_update", (...eventData: unknown[]) => {
      const payload = eventData[0];

      if (typeof payload !== "string") {
        setConnection("offline");
        setLastError("Telemetry payload is not a string");
        return;
      }

      try {
        const snapshot = parseTelemetry(payload);
        const time = new Date().toLocaleTimeString([], { hour12: false });

        setPm25(snapshot.pm25);
        setPower(snapshot.power);
        setMode(snapshot.mode);
        setFanSpeed(snapshot.fanSpeed);
        setFanSupported(snapshot.fanSupported);
        setFanCode(snapshot.fanCode);
        setFilterLife(snapshot.filterLife);
        setFilterSupported(snapshot.filterSupported);
        setFilterCode(snapshot.filterCode);
        setConnection("online");
        setLastUpdated(time);
        setLastError("");

        setPm25History((previous) => {
          const next = [...previous, { time, pm25: snapshot.pm25 }];
          if (next.length <= HISTORY_LIMIT) {
            return next;
          }
          return next.slice(next.length - HISTORY_LIMIT);
        });
      } catch (error) {
        setConnection("offline");
        setLastError(getErrorMessage(error));
      }
    });

    const unsubscribeTelemetryError = EventsOn("telemetry_error", (...eventData: unknown[]) => {
      setConnection("offline");
      setLastError(getEventErrorMessage(eventData));
    });

    const unsubscribeOutdoor = EventsOn("outdoor_aq_update", (...eventData: unknown[]) => {
      const payload = eventData[0];

      if (typeof payload !== "string") {
        setOutdoorError("Outdoor payload is not a string");
        return;
      }

      try {
        const snapshot = parseOutdoorSnapshot(payload);
        const parsedDate = new Date(snapshot.updatedAt);
        const time = Number.isNaN(parsedDate.getTime())
          ? new Date().toLocaleTimeString([], { hour12: false })
          : parsedDate.toLocaleTimeString([], { hour12: false });

        setOutdoorCityName(snapshot.city);
        setOutdoorPm25(snapshot.pm25);
        setOutdoorLastUpdated(time);
        setOutdoorSource(snapshot.source);
        setOutdoorError("");

        setOutdoorHistory((previous) => {
          const next = [...previous, { time, pm25: snapshot.pm25 }];
          if (next.length <= OUTDOOR_HISTORY_LIMIT) {
            return next;
          }
          return next.slice(next.length - OUTDOOR_HISTORY_LIMIT);
        });
      } catch (error) {
        setOutdoorError(getErrorMessage(error));
      }
    });

    const unsubscribeOutdoorError = EventsOn("outdoor_aq_error", (...eventData: unknown[]) => {
      setOutdoorError(getEventErrorMessage(eventData));
    });

    return () => {
      isMounted = false;
      unsubscribeTelemetry();
      unsubscribeTelemetryError();
      unsubscribeOutdoor();
      unsubscribeOutdoorError();
      EventsOff("telemetry_update", "telemetry_error");
      EventsOff("outdoor_aq_update", "outdoor_aq_error");
    };
  }, []);

  const connectionLabel = useMemo(() => {
    if (connection === "online") {
      return "Online";
    }
    if (connection === "offline") {
      return "Offline";
    }
    return "Connecting";
  }, [connection]);

  const onTogglePower = useCallback(async () => {
    if (isPowerPending) {
      return;
    }

    const nextValue = !power;
    setIsPowerPending(true);

    try {
      await SetPower(nextValue);
      setLastError("");
    } catch (error) {
      setConnection("offline");
      setLastError(getErrorMessage(error));
    } finally {
      setIsPowerPending(false);
    }
  }, [isPowerPending, power]);

  const onChangeMode = useCallback(
    async (nextMode: DeviceMode) => {
      if (isModePending) {
        return;
      }

      setIsModePending(true);

      try {
        await SetMode(nextMode);
        setLastError("");
      } catch (error) {
        setConnection("offline");
        setLastError(getErrorMessage(error));
      } finally {
        setIsModePending(false);
      }
    },
    [isModePending]
  );

  const onChangeFanSpeed = useCallback(
    async (nextSpeed: FanSpeed) => {
      if (!isManualMode || isFanPending || !fanSupported) {
        if (isManualMode && !fanSupported) {
          setLastError("Fan speed control is not available for this model profile");
        }
        return;
      }

      setIsFanPending(true);

      try {
        await SetFanSpeed(nextSpeed);
        setLastError("");
      } catch (error) {
        setConnection("offline");
        setLastError(getErrorMessage(error));
      } finally {
        setIsFanPending(false);
      }
    },
    [fanSupported, isFanPending, isManualMode]
  );

  const onApplyOutdoorCity = useCallback(async () => {
    if (isOutdoorPending) {
      return;
    }

    const nextCity = outdoorInput.trim();
    if (nextCity.length === 0) {
      setOutdoorError("City cannot be empty");
      return;
    }

    setIsOutdoorPending(true);

    try {
      await SetOutdoorCity(nextCity);
      setOutdoorCityName(nextCity);
      setOutdoorError("");
    } catch (error) {
      setOutdoorError(getErrorMessage(error));
    } finally {
      setIsOutdoorPending(false);
    }
  }, [isOutdoorPending, outdoorInput]);

  return (
    <div className="scene">
      <div className="dashboard-shell">
        <header className="dashboard-header glass-panel">
          <div className="brand-area">
            <div className="brand-mark" aria-hidden="true">
              <Sparkles size={16} />
            </div>
            <div className="header-title-group">
              <h1>Xiaomi Air Matrix</h1>
              <p>zhimi.airp.cpa4 · event stream control</p>
              <p className="build-revision">UI {UI_REVISION}</p>
            </div>
          </div>
          <div className={`connection-chip connection-${connection}`}>
            <span className="chip-dot" />
            {connectionLabel}
          </div>
        </header>

        <main className="dashboard-main">
          <section className="hero-panel glass-panel">
            <div className="hero-head">
              <p className="critical-label">
                <Activity size={14} /> PM2.5 Density
              </p>
              <span className={`quality-pill ${pm25Class}`}>{pm25Tier}</span>
            </div>

            <div className={`pm25-value ${pm25Class}`}>{pm25 ?? "--"}</div>
            <p className="critical-unit">micrograms / m3</p>

            <div className="pm25-trend">
              <div className="trend-meta">
                <span>Live trend</span>
                <span>
                  {pm25History.length}/{HISTORY_LIMIT}
                </span>
              </div>

              {pm25History.length > 1 ? (
                <ResponsiveContainer width="100%" height={126}>
                  <LineChart data={pm25History}>
                    <Line
                      type="monotone"
                      dataKey="pm25"
                      stroke={pm25Stroke}
                      strokeWidth={2.4}
                      dot={false}
                      isAnimationActive={pm25History.length > 2}
                      animationDuration={460}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="trend-placeholder">Waiting for telemetry samples</div>
              )}
            </div>
          </section>

          <section className="control-panel glass-panel">
            <article className="control-card">
              <div className="control-card-head">
                <span className="control-title">
                  <Power size={14} /> Power
                </span>
                <span className="control-subtitle">Instant toggle</span>
              </div>
              <button
                type="button"
                disabled={isPowerPending}
                onClick={() => {
                  void onTogglePower();
                }}
                className={`toggle-button ${power ? "toggle-on" : "toggle-off"}`}
              >
                {power ? "ON" : "OFF"}
              </button>
            </article>

            <article className="control-card">
              <div className="control-card-head">
                <span className="control-title">
                  <MoonStar size={14} /> Mode
                </span>
                <span className="control-subtitle">Device profile</span>
              </div>
              <div className="segmented-group">
                {MODE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    disabled={isModePending}
                    onClick={() => {
                      void onChangeMode(option.value);
                    }}
                    className={mode === option.value ? "segmented-active" : ""}
                  >
                    <span>{option.label}</span>
                    <small>{option.hint}</small>
                  </button>
                ))}
              </div>
            </article>

            <article className="control-card">
              <div className="control-card-head">
                <span className="control-title">
                  <Wind size={14} /> Fan Speed
                </span>
                <span className="control-subtitle">Manual mode and supported profile</span>
              </div>
              <div className="segmented-group">
                {FAN_SPEED_VALUES.map((speed) => (
                  <button
                    key={speed}
                    type="button"
                    disabled={fanControlsDisabled}
                    onClick={() => {
                      void onChangeFanSpeed(speed);
                    }}
                    className={fanSpeed === speed ? "segmented-active" : ""}
                  >
                    <span>{speed}</span>
                    <small>Level</small>
                  </button>
                ))}
              </div>
            </article>

            <article className="control-card outdoor-card">
              <div className="control-card-head">
                <span className="control-title">
                  <CloudSun size={14} /> Outdoor PM2.5
                </span>
                <span className="control-subtitle">Open-Meteo feed</span>
              </div>

              <div className="outdoor-reading">
                <span className={`outdoor-value ${outdoorPm25Class}`}>{outdoorPm25 ?? "--"}</span>
                <span className={`quality-pill ${outdoorPm25Class}`}>{outdoorPm25Tier}</span>
              </div>

              <form
                className="city-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void onApplyOutdoorCity();
                }}
              >
                <label htmlFor="outdoor-city-input">
                  <MapPin size={12} /> City
                </label>
                <div className="city-form-row">
                  <input
                    id="outdoor-city-input"
                    type="text"
                    value={outdoorInput}
                    onChange={(event) => {
                      setOutdoorInput(event.target.value);
                    }}
                    placeholder="Granollers"
                    autoComplete="off"
                  />
                  <button type="submit" disabled={isOutdoorPending}>
                    {isOutdoorPending ? <LoaderCircle size={14} className="spinning" /> : "Apply"}
                  </button>
                </div>
              </form>

              <small className="outdoor-meta">
                {outdoorCity} · updated {outdoorLastUpdated} · {outdoorSource}
              </small>

              {outdoorHistory.length > 1 ? (
                <ResponsiveContainer width="100%" height={90}>
                  <LineChart data={outdoorHistory}>
                    <Line
                      type="monotone"
                      dataKey="pm25"
                      stroke={outdoorPm25Stroke}
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={outdoorHistory.length > 2}
                      animationDuration={420}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="trend-placeholder trend-compact">Waiting for outdoor samples</div>
              )}
            </article>

            <article className="status-card">
              <p>
                <Gauge size={14} /> {fanModeLabel}
              </p>
            </article>

            <article className="control-card">
              <div className="control-card-head">
                <span className="control-title">
                  <Wrench size={14} /> Filter
                </span>
                <span className="control-subtitle">Model capability</span>
              </div>
              <button type="button" disabled className="toggle-button filter-toggle">
                {filterSupported ? "Read-only status" : "Unsupported"}
              </button>
              <p className="filter-status-note">{filterModeLabel}</p>
            </article>
          </section>
        </main>

        <footer className="dashboard-footer glass-panel">
          <span>Last update: {lastUpdated}</span>
          <span>Outdoor city: {outdoorCity}</span>
          <span>Connection: {connectionLabel}</span>
          <span className="error-slot">{lastError}</span>
          <span className="error-slot outdoor-error-slot">{outdoorError}</span>
        </footer>
      </div>
    </div>
  );
}
