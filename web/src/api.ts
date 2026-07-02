export type RequirementsMode = "none" | "player";

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
  engine: "v2";
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
  generationId?: string;
  scriptHash?: string;
  candidateScore?: number;
  modelVersion?: string;
  combatCoverage?: number;
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

export interface OpenOutputDirResponse extends ApiBase {
  outputDir?: string;
}

export interface EnterPracticeResponse extends ApiBase {
  result?: {
    ok?: boolean;
    stage?: string;
    startupTaskId?: number;
    navigationTaskId?: number;
    closedProxy?: boolean;
    practiceCallId?: number;
  };
}

export interface GenerateRequest {
  stage: string;
  operatorsJson?: string;
  operatorFilePath?: string;
  pretty: boolean;
  outputDir?: string;
  fileName?: string;
  newCandidate?: boolean;
  requirementsMode?: RequirementsMode;
}

export interface FeedbackResponse extends ApiBase {
  record?: {
    ratio: number;
    usableForLearning: boolean;
    operatorBoxChanged: boolean;
  };
}

export interface FeedbackSummary {
  count: number;
  usableCount: number;
  fullClearCount: number;
}

export interface FeedbackSummaryResponse extends ApiBase {
  summary?: FeedbackSummary;
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

export async function generateCopilot(body: GenerateRequest): Promise<GenerateResponse> {
  return postJson<GenerateResponse>("/api/generate", body);
}

export async function validateScript(scriptJson: string): Promise<ValidateResponse> {
  return postJson<ValidateResponse>("/api/validate", { scriptJson });
}

export async function openOutputDir(outputDir: string): Promise<OpenOutputDirResponse> {
  return postJson<OpenOutputDirResponse>("/api/open-output-dir", { outputDir });
}

export async function enterPractice(stage: string): Promise<EnterPracticeResponse> {
  return postJson<EnterPracticeResponse>("/api/enter-practice", { stage });
}

export async function saveOperatorsJson(operatorsJson: string): Promise<SaveOperatorsResponse> {
  return postJson<SaveOperatorsResponse>("/api/operators/save", { operatorsJson });
}

export async function recordFeedback(body: {
  scriptHash: string;
  killed: number;
  total?: number;
  notes?: string;
}): Promise<FeedbackResponse> {
  return postJson<FeedbackResponse>("/api/feedback", body);
}

export async function getFeedbackSummary(stage?: string): Promise<FeedbackSummaryResponse> {
  const params = stage ? `?${new URLSearchParams({ stage }).toString()}` : "";
  const res = await fetch(`/api/feedback/summary${params}`);
  return res.json() as Promise<FeedbackSummaryResponse>;
}
