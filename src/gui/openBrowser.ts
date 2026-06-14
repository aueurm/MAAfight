import * as fs from "fs";
import { spawn } from "child_process";

function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.unref();
    resolve();
  });
}

export async function openUrl(url: string): Promise<void> {
  if (process.platform === "win32") {
    await spawnDetached("cmd", ["/c", "start", "", url]);
    return;
  }
  if (process.platform === "darwin") {
    await spawnDetached("open", [url]);
    return;
  }
  await spawnDetached("xdg-open", [url]);
}

export async function openOutputDirectory(outputDir: string): Promise<void> {
  if (!outputDir || !fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) {
    throw new Error(`Output directory does not exist: ${outputDir || "(empty)"}`);
  }

  if (process.platform === "win32") {
    await spawnDetached("cmd", ["/c", "start", "", outputDir]);
    return;
  }
  if (process.platform === "darwin") {
    await spawnDetached("open", [outputDir]);
    return;
  }
  await spawnDetached("xdg-open", [outputDir]);
}
