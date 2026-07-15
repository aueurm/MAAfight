const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
const releaseRoot = path.join(repoRoot, "release");
const packageName = `MAAfight-GUI-v${pkg.version}-preview-win-x64`;
const packageRoot = path.join(releaseRoot, packageName);
const appRoot = path.join(packageRoot, "app");

function copyDir(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    force: true,
    filter: source => !source.includes(`${path.sep}.cache${path.sep}`),
  });
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.replace(/\n/g, "\r\n"), "utf-8");
}

function makeAppPackageJson() {
  return JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    private: true,
    main: "dist/index.js",
    dependencies: pkg.dependencies || {},
  }, null, 2);
}

function writeStartBat() {
  write(path.join(packageRoot, "start-gui.bat"), `@echo off
setlocal
cd /d "%~dp0"
set "MAAFIGHT_HOME=%CD%"
set "MAAFIGHT_WEB_ROOT=%CD%\\app\\web-dist"
set "MAAFIGHT_OUTPUT_DIR=%CD%\\output"
set "MAAFIGHT_CACHE_DIR=%CD%\\cache"
set "MAAFIGHT_LOG_DIR=%CD%\\logs"

if exist "%CD%\\runtime\\node.exe" (
  set "NODE_EXE=%CD%\\runtime\\node.exe"
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Node.js was not found.
    echo Install Node.js 20+ or place node.exe at runtime\\node.exe.
    echo.
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)

if not exist "%MAAFIGHT_OUTPUT_DIR%" mkdir "%MAAFIGHT_OUTPUT_DIR%"
if not exist "%MAAFIGHT_CACHE_DIR%" mkdir "%MAAFIGHT_CACHE_DIR%"
if not exist "%MAAFIGHT_LOG_DIR%" mkdir "%MAAFIGHT_LOG_DIR%"

echo Starting MAAfight GUI...
echo Home: %MAAFIGHT_HOME%
echo Output: %MAAFIGHT_OUTPUT_DIR%
echo Logs: %MAAFIGHT_LOG_DIR%
echo.
"%NODE_EXE%" "%CD%\\app\\dist\\index.js" gui

echo.
echo MAAfight GUI has stopped.
if errorlevel 1 (
  echo [ERROR] Startup failed. Check logs\\gui.log for details.
)
pause
`);
}

function writeReadme() {
  write(path.join(packageRoot, "README-TEST.md"), `# MAAfight GUI 内测包

## 如何启动

1. 解压整个目录，不要只复制其中的单个文件。
2. 双击 \`start-gui.bat\`。
3. 浏览器会自动打开本地页面。若没有自动打开，请看命令行窗口中的 \`http://localhost:14514\` 或后续端口。

如果窗口提示找不到 Node.js，请安装 Node.js 20+，或把 \`node.exe\` 放到 \`runtime/node.exe\`。

## 如何生成脚本

1. 在页面输入关卡 ID 或关卡名，例如 \`GT-1\`。
2. 可选：选择 operators JSON 文件，或粘贴并保存 MAA 干员识别导出的 JSON。
3. 选择编队模式，默认推荐 \`混合模式（hybrid）\`。
4. 点击“生成脚本”。
5. 成功后页面会显示完整保存路径，文件会实际写入本包的 \`output/\` 目录，除非你手动指定其他输出目录。

## 默认目录

- 输出目录：\`output/\`
- 缓存目录：\`cache/\`
- 日志目录：\`logs/\`
- 本地干员库：\`.maafight/operators.json\`

这些目录都位于解压后的内测包根目录内。

## 如何导入 MAA 测试

1. 打开 MAA 的“作业”或 copilot 导入功能。
2. 选择 MAAfight 生成的 JSON 文件，默认在 \`output/\`。
3. 先人工检查关卡名、干员、部署位置和技能设置。
4. 再在 MAA 中运行测试。

MAAfight 只生成 MAA copilot JSON，不执行战斗，不调用 ADB，不修改 MAA。

## 反馈时请提供

- 页面中“复制调试信息”的内容。
- \`logs/gui.log\`。
- 生成失败时的关卡 ID、编队模式、页面 warnings/errors。
- 生成成功但不符合预期时，请附上 output 中对应 JSON。

## 隐私提醒

operators JSON 只在本地使用，用于筛选你拥有的干员。不建议公开上传完整干员 box。反馈问题时优先提供“复制调试信息”和日志，除非你明确愿意共享完整 box。
`);
}

function writeExamples() {
  write(path.join(packageRoot, "examples", "README.md"), `# 推荐测试关卡

可以优先用这些关卡做冒烟测试：

- GT-1：活动早期关卡，适合验证基础生成。
- 0-1：主线入门关卡，适合验证关卡搜索。
- CE-5：资源本，适合验证关卡索引与缓存。

本目录不包含真实玩家 operators JSON。请从自己的 MAA 干员识别结果导出或粘贴。
`);
}

function maybeZipPackage() {
  const zipPath = path.join(releaseRoot, `${packageName}.zip`);
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });

  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Compress-Archive -LiteralPath '${packageRoot.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
  ], { stdio: "inherit" });

  if (result.status !== 0) {
    console.warn(`[WARN] Zip creation failed. Package directory is still ready: ${packageRoot}`);
    return;
  }
  console.log(`Created zip: ${zipPath}`);
}

function main() {
  for (const required of ["dist", "web/dist", "node_modules"]) {
    const fullPath = path.join(repoRoot, required);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Missing ${required}. Run npm install and npm run build first.`);
    }
  }

  fs.mkdirSync(releaseRoot, { recursive: true });
  fs.rmSync(packageRoot, { recursive: true, force: true });
  fs.mkdirSync(appRoot, { recursive: true });

  copyDir(path.join(repoRoot, "dist"), path.join(appRoot, "dist"));
  copyDir(path.join(repoRoot, "web", "dist"), path.join(appRoot, "web-dist"));
  copyDir(path.join(repoRoot, "node_modules"), path.join(appRoot, "node_modules"));

  fs.writeFileSync(path.join(appRoot, "package.json"), makeAppPackageJson(), "utf-8");
  for (const dir of ["output", "cache", "logs", "examples"]) {
    fs.mkdirSync(path.join(packageRoot, dir), { recursive: true });
  }
  if (fs.existsSync(path.join(repoRoot, "cache"))) {
    copyDir(path.join(repoRoot, "cache"), path.join(packageRoot, "cache"));
  }
  writeStartBat();
  writeReadme();
  writeExamples();
  write(path.join(packageRoot, "VERSION.txt"), `MAAfight GUI Preview
Version: ${pkg.version}
Package: ${packageName}
Built: ${new Date().toISOString()}
`);

  maybeZipPackage();
  console.log(`Preview package ready: ${packageRoot}`);
}

main();
