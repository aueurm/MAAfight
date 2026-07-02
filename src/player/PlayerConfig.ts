import * as fs from "fs";
import * as path from "path";
import { OperatorBox } from "./OperatorBox";

export interface MaafightLocalConfig {
  operatorsPath?: string;
  lastOutputDir?: string;
  maaPath?: string;
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

function saveLocalConfig(config: MaafightLocalConfig, cwd = process.cwd()): string {
  const dir = getMaafightDir(cwd);
  const configPath = getConfigPath(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    ...config,
    updatedAt: new Date().toISOString(),
  }, null, 2), "utf-8");
  return configPath;
}

function resolveOperatorsPath(config: MaafightLocalConfig, cwd = process.cwd()): string | null {
  if (!config.operatorsPath) return null;
  if (path.isAbsolute(config.operatorsPath)) return config.operatorsPath;
  return path.resolve(getMaafightDir(cwd), config.operatorsPath);
}

function resolveOutputDir(config: MaafightLocalConfig, cwd = process.cwd()): string | null {
  if (!config.lastOutputDir) return null;
  if (path.isAbsolute(config.lastOutputDir)) return config.lastOutputDir;
  return path.resolve(cwd, config.lastOutputDir);
}

function resolveMaaPath(config: MaafightLocalConfig, cwd = process.cwd()): string | null {
  if (!config.maaPath) return null;
  if (path.isAbsolute(config.maaPath)) return config.maaPath;
  return path.resolve(cwd, config.maaPath);
}

export function saveOperatorConfig(rawJson: string, cwd = process.cwd()): SavedOperatorConfig {
  const dir = getMaafightDir(cwd);
  const configPath = getConfigPath(cwd);
  const operatorsPath = getDefaultOperatorsPath(cwd);
  const operators = OperatorBox.parseJson(rawJson);
  const existing = loadLocalConfig(cwd) || {};

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(operatorsPath, JSON.stringify(operators, null, 2), "utf-8");
  saveLocalConfig({
    ...existing,
    operatorsPath: OPERATORS_FILE,
  }, cwd);

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

export function loadLastOutputDir(cwd = process.cwd()): string | null {
  const config = loadLocalConfig(cwd);
  if (!config) return null;
  return resolveOutputDir(config, cwd);
}

export function saveLastOutputDir(outputDir: string, cwd = process.cwd()): string {
  const existing = loadLocalConfig(cwd) || {};
  return saveLocalConfig({
    ...existing,
    lastOutputDir: path.resolve(outputDir),
  }, cwd);
}

export function loadConfiguredMaaPath(cwd = process.cwd()): string | null {
  const config = loadLocalConfig(cwd);
  if (!config) return null;
  return resolveMaaPath(config, cwd);
}

export function saveMaaPath(maaPath: string, cwd = process.cwd()): string {
  const existing = loadLocalConfig(cwd) || {};
  return saveLocalConfig({
    ...existing,
    maaPath: path.resolve(maaPath),
  }, cwd);
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
