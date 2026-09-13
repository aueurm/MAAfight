import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { loadConfiguredMaaPath } from "../player/PlayerConfig";
import type { EmulatorStartupStatus } from "../shared/emulatorStartup";

const STARTUP_TIMEOUT_SECONDS = 180;

export async function startMumu(cwd: string, signal: AbortSignal): Promise<EmulatorStartupStatus> {
  if (process.platform !== "win32") return { state: "skipped" };
  if (signal.aborted) return { state: "skipped" };
  const script = path.resolve(__dirname, "..", "..", "scripts", "start-mumu.ps1");
  if (!fs.existsSync(script)) throw new Error("MuMu 启动脚本不存在，请检查安装是否完整。");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-TimeoutSeconds", String(STARTUP_TIMEOUT_SECONDS)];
  const maaPath = loadConfiguredMaaPath(cwd);
  if (maaPath) args.push("-MaaDir", maaPath);

  return new Promise(resolve => {
    const child = spawn("powershell.exe", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (status: EmulatorStartupStatus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      resolve(status);
    };
    const cancel = (): void => {
      finish({ state: "skipped" });
      child.kill(); // Stop only this check; keep the independently launched emulator running.
    };
    const timer = setTimeout(() => {
      finish({ state: "failed", message: "MuMu 启动检查超时，请查看模拟器窗口中的提示，或手动启动后重试演习。" });
      child.kill();
    }, (STARTUP_TIMEOUT_SECONDS + 15) * 1000);
    signal.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", chunk => { stdout = (stdout + String(chunk)).slice(-16_384); });
    child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4_096); });
    child.on("error", error => finish({ state: "failed", message: `MuMu 启动失败：${error.message}` }));
    child.on("close", code => {
      let result: { usable?: boolean; bootCompleted?: boolean; skipped?: boolean; warning?: string } = {};
      try {
        const parsed = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) result = parsed;
      } catch { /* Report diagnostics below. */ }
      if (code === 0 && result.usable === true && result.bootCompleted === true) finish({ state: "ready" });
      else if (code === 0 && result.skipped) finish({ state: "skipped", message: result.warning });
      else finish({
        state: "failed",
        message: `MuMu 启动未完成：${result.warning || stderr.trim() || "未确认 Android 和 ADB 就绪，请查看模拟器窗口。"}`,
      });
    });
  });
}
