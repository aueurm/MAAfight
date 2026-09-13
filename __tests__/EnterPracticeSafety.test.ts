import { spawnSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

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

testOnWindows("practice helper returns UTF-8 structured failures for Chinese paths", () => {
  const root = path.resolve(__dirname, "..");
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "maafight-practice-error-"));
  try {
    const missingScript = path.join(fixtureDir, "缺失脚本.json");
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(root, "scripts", "enter-practice.ps1"),
      "-MaaDir", fixtureDir, "-ScriptPath", missingScript,
    ], { cwd: root, encoding: "utf8", timeout: 20_000, windowsHide: true });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: false, error: `script file not found: ${missingScript}` });
    expect(result.stderr).not.toContain("CategoryInfo");
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}, 25_000);
