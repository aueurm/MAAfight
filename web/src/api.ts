export type SquadMode = "fixed" | "groups" | "hybrid";

export interface ApiBase {
  success: boolean;
  warnings?: string[];
  errors?: string[];
}

export interface ConfigResponse extends ApiBase {
  version: string;
  homeDir: string;
  defaultOutputDir: string;
  defaultCacheDir: string;
  defaultCacheLevelsDir: string;
  defaultLogDir: string;
  defaultOperatorsPath: string;
  defaultSquadMode: SquadMode;
  supportedSquadModes: SquadMode[];
  configuredOperators?: {
    operatorsPath: string;
    count: number;
  } | null;
}

export interface StageSuggestion {
  stageId: string;
  stageName: string;
  code?: string;
  name?: string;
  category: string;
  filePath: string;
  series: string;
  number: string;
}

export interface StageSuggestionResponse extends ApiBase {
  suggestions: StageSuggestion[];
}

export interface AnalyzeResponse extends ApiBase {
  stageId?: string;
  stageName?: string;
  analysis?: unknown;
}

export interface GenerateResponse extends AnalyzeResponse {
  outputPath?: string;
  outputDir?: string;
  fileName?: string;
  script?: unknown;
  json?: string;
  validation?: unknown;
  protocol?: unknown;
  explain?: string;
}

export interface ValidateResponse extends ApiBase {
  validation?: unknown;
  protocol?: unknown;
}

export interface SaveOperatorsResponse extends ApiBase {
  operatorsPath?: string;
  configPath?: string;
  count?: number;
}

export interface GenerateRequest {
  stage: string;
  operatorsJson?: string;
  operatorFilePath?: string;
  squadMode: SquadMode;
  pretty: boolean;
  outputDir?: string;
  fileName?: string;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

export async function getConfig(): Promise<ConfigResponse> {
  const res = await fetch("/api/config");
  return res.json() as Promise<ConfigResponse>;
}

export async function searchStageSuggestions(query: string, limit = 24): Promise<StageSuggestionResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const res = await fetch(`/api/stages?${params.toString()}`);
  return res.json() as Promise<StageSuggestionResponse>;
}

export async function analyzeStage(body: Pick<GenerateRequest, "stage" | "operatorsJson" | "operatorFilePath">): Promise<AnalyzeResponse> {
  return postJson<AnalyzeResponse>("/api/analyze", body);
}

export async function generateScript(body: GenerateRequest): Promise<GenerateResponse> {
  return postJson<GenerateResponse>("/api/generate", body);
}

export async function validateScript(scriptJson: string): Promise<ValidateResponse> {
  return postJson<ValidateResponse>("/api/validate", { scriptJson });
}

export async function openOutputDir(outputDir: string): Promise<ApiBase> {
  return postJson<ApiBase>("/api/open-output-dir", { outputDir });
}

export async function saveOperatorsJson(operatorsJson: string): Promise<SaveOperatorsResponse> {
  return postJson<SaveOperatorsResponse>("/api/operators/save", { operatorsJson });
}
