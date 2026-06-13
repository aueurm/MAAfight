import * as fs from "fs";
import * as path from "path";
import { OperatorBox } from "./OperatorBox";

export interface MaafightLocalConfig {
  operatorsPath?: string;
  updatedAt?: string;
}

export interface SavedOperatorConfig {
  configPath: string;
  operatorsPath: string;
  box: OperatorBox;
}

export interface LoadedOperatorConfig {
  configPath: string;
  operatorsPath: string;
  box: OperatorBox;
}

const CONFIG_DIR = ".maafight";
const CONFIG_FILE = "config.json";
const OPERATORS_FILE = "operators.json";

export function getMaafightDir(cwd = process.cwd()): string {
  return path.resolve(cwd, CONFIG_DIR);
}

export function getConfigPath(cwd = process.cwd()): string {
  return path.join(getMaafightDir(cwd), CONFIG_FILE);
}

export function getDefaultOperatorsPath(cwd = process.cwd()): string {
  return path.join(getMaafightDir(cwd), OPERATORS_FILE);
}

function resolveOperatorsPath(config: MaafightLocalConfig, cwd = process.cwd()): string | null {
  if (!config.operatorsPath) return null;
  if (path.isAbsolute(config.operatorsPath)) return config.operatorsPath;
  return path.resolve(getMaafightDir(cwd), config.operatorsPath);
}

export function saveOperatorConfig(rawJson: string, cwd = process.cwd()): SavedOperatorConfig {
  const dir = getMaafightDir(cwd);
  const configPath = getConfigPath(cwd);
  const operatorsPath = getDefaultOperatorsPath(cwd);
  const operators = OperatorBox.parseJson(rawJson);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(operatorsPath, JSON.stringify(operators, null, 2), "utf-8");
  fs.writeFileSync(configPath, JSON.stringify({
    operatorsPath: OPERATORS_FILE,
    updatedAt: new Date().toISOString(),
  }, null, 2), "utf-8");

  return {
    configPath,
    operatorsPath,
    box: OperatorBox.fromOperators(operators),
  };
}

export function loadLocalConfig(cwd = process.cwd()): MaafightLocalConfig | null {
  const configPath = getConfigPath(cwd);
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, "utf-8")) as MaafightLocalConfig;
}

export function loadConfiguredOperatorBox(cwd = process.cwd()): LoadedOperatorConfig | null {
  const config = loadLocalConfig(cwd);
  if (!config) return null;

  const operatorsPath = resolveOperatorsPath(config, cwd);
  if (!operatorsPath || !fs.existsSync(operatorsPath)) return null;

  return {
    configPath: getConfigPath(cwd),
    operatorsPath,
    box: new OperatorBox(operatorsPath),
  };
}
