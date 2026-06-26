import * as fs from "fs";
import * as path from "path";

export function packageVersion(): string {
  const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
  if (!fs.existsSync(pkgPath)) return "unknown";
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string };
  return pkg.version || "unknown";
}
