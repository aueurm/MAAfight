export interface EmulatorStartupStatus {
  state: "starting" | "ready" | "failed" | "skipped";
  message?: string;
}
