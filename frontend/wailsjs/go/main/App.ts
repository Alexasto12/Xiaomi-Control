type AppBindings = {
  GetTelemetry: () => Promise<string>;
  SetPower: (state: boolean) => Promise<void>;
  SetMode: (mode: number) => Promise<void>;
  SetFanSpeed: (speed: number) => Promise<void>;
};

type WailsWindow = {
  go?: {
    main?: {
      App?: AppBindings;
    };
  };
};

function appBindings(): AppBindings {
  const bindings = (window as unknown as WailsWindow).go?.main?.App;
  if (!bindings) {
    throw new Error("Wails bindings are unavailable. Start the app with Wails runtime.");
  }
  return bindings;
}

export function GetTelemetry(): Promise<string> {
  return appBindings().GetTelemetry();
}

export function SetPower(state: boolean): Promise<void> {
  return appBindings().SetPower(state);
}

export function SetMode(mode: number): Promise<void> {
  return appBindings().SetMode(mode);
}

export function SetFanSpeed(speed: number): Promise<void> {
  return appBindings().SetFanSpeed(speed);
}
