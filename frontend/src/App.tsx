import { useCallback, useEffect, useMemo, useState } from "react";
import { GetTelemetry, SetFanSpeed, SetMode, SetPower } from "../wailsjs/go/main/App";

type ConnectionState = "connecting" | "online" | "offline";
type DeviceMode = 0 | 1 | 2;
type FanSpeed = 1 | 2 | 3;

interface MiotTelemetryItem {
  code: number;
  did: string;
  siid: number;
  piid: number;
  value: number | boolean;
}

interface TelemetrySnapshot {
  pm25: number;
  power: boolean;
}

const MODE_LABELS: Record<DeviceMode, string> = {
  0: "Auto",
  1: "Sleep",
  2: "Manual",
};

const FAN_SPEED_VALUES: FanSpeed[] = [1, 2, 3];

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
    (typeof candidate.value === "number" || typeof candidate.value === "boolean")
  );
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

  const pm25Entry = items.find((item) => item.siid === 3 && item.piid === 4);
  const powerEntry = items.find((item) => item.siid === 2 && item.piid === 1);

  if (!pm25Entry || typeof pm25Entry.value !== "number") {
    throw new Error("PM2.5 field missing or invalid");
  }

  if (!powerEntry || typeof powerEntry.value !== "boolean") {
    throw new Error("Power field missing or invalid");
  }

  return {
    pm25: pm25Entry.value,
    power: powerEntry.value,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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

export default function App() {
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [pm25, setPm25] = useState<number | null>(null);
  const [power, setPower] = useState<boolean>(false);
  const [mode, setMode] = useState<DeviceMode>(0);
  const [fanSpeed, setFanSpeed] = useState<FanSpeed>(1);
  const [lastUpdated, setLastUpdated] = useState<string>("-");
  const [lastError, setLastError] = useState<string>("");

  const isManualMode = mode === 2;

  const refreshTelemetry = useCallback(async () => {
    try {
      const raw = await GetTelemetry();
      const snapshot = parseTelemetry(raw);
      setPm25(snapshot.pm25);
      setPower(snapshot.power);
      setConnection("online");
      setLastError("");
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (error) {
      setConnection("offline");
      setLastError(getErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    void refreshTelemetry();

    const timer = window.setInterval(() => {
      void refreshTelemetry();
    }, 5000);

    return () => {
      window.clearInterval(timer);
    };
  }, [refreshTelemetry]);

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
    const nextValue = !power;
    setPower(nextValue);

    try {
      await SetPower(nextValue);
      setConnection("online");
      setLastError("");
    } catch (error) {
      setPower(!nextValue);
      setConnection("offline");
      setLastError(getErrorMessage(error));
    }
  }, [power]);

  const onChangeMode = useCallback(
    async (nextMode: DeviceMode) => {
      const previousMode = mode;
      setMode(nextMode);

      try {
        await SetMode(nextMode);
        setConnection("online");
        setLastError("");
      } catch (error) {
        setMode(previousMode);
        setConnection("offline");
        setLastError(getErrorMessage(error));
      }
    },
    [mode]
  );

  const onChangeFanSpeed = useCallback(
    async (nextSpeed: FanSpeed) => {
      if (!isManualMode) {
        return;
      }

      const previousSpeed = fanSpeed;
      setFanSpeed(nextSpeed);

      try {
        await SetFanSpeed(nextSpeed);
        setConnection("online");
        setLastError("");
      } catch (error) {
        setFanSpeed(previousSpeed);
        setConnection("offline");
        setLastError(getErrorMessage(error));
      }
    },
    [fanSpeed, isManualMode]
  );

  return (
    <div className="dashboard-shell">
      <header className="dashboard-header">
        <div className="header-title-group">
          <h1>Xiaomi MIOT Local Dashboard</h1>
          <p>zhimi.airp.cpa4 telemetry</p>
        </div>
        <div className={`connection-chip connection-${connection}`}>
          <span className="chip-dot" />
          {connectionLabel}
        </div>
      </header>

      <main className="dashboard-main">
        <section className="critical-panel">
          <p className="critical-label">PM2.5</p>
          <div className={`pm25-value ${getPm25Class(pm25)}`}>{pm25 ?? "--"}</div>
          <p className="critical-unit">ug/m3</p>
        </section>

        <section className="control-panel">
          <div className="control-row">
            <span className="control-label">Power</span>
            <button
              type="button"
              onClick={() => {
                void onTogglePower();
              }}
              className={`toggle-button ${power ? "toggle-on" : "toggle-off"}`}
            >
              {power ? "ON" : "OFF"}
            </button>
          </div>

          <div className="control-row">
            <span className="control-label">Mode</span>
            <div className="segmented-group">
              {(Object.keys(MODE_LABELS) as unknown as DeviceMode[]).map((modeValue) => (
                <button
                  key={modeValue}
                  type="button"
                  onClick={() => {
                    void onChangeMode(modeValue);
                  }}
                  className={mode === modeValue ? "segmented-active" : ""}
                >
                  {MODE_LABELS[modeValue]}
                </button>
              ))}
            </div>
          </div>

          <div className="control-row">
            <span className="control-label">Fan Speed</span>
            <div className="segmented-group">
              {FAN_SPEED_VALUES.map((speed) => (
                <button
                  key={speed}
                  type="button"
                  disabled={!isManualMode}
                  onClick={() => {
                    void onChangeFanSpeed(speed);
                  }}
                  className={fanSpeed === speed ? "segmented-active" : ""}
                >
                  {speed}
                </button>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="dashboard-footer">
        <span>Last update: {lastUpdated}</span>
        <span>{isManualMode ? "Manual mode: speed enabled" : "Speed locked outside manual mode"}</span>
        <span className="error-slot">{lastError}</span>
      </footer>
    </div>
  );
}
