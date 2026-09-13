import { spawnSync } from "child_process";
import * as path from "path";

const testOnWindows = process.platform === "win32" ? test : test.skip;

testOnWindows("practice helper rejects normal starts and propagates MAA callback failures without loading MaaCore", () => {
  const root = path.resolve(__dirname, "..");
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(root, "scripts", "enter-practice.ps1"), "-SelfTest",
  ], { cwd: root, encoding: "utf8", timeout: 20_000, windowsHide: true });

  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || `SelfTest exited with ${result.status}`);
  }
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ ok: true, selfTest: true });
}, 25_000);
