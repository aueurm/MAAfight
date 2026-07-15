export interface AnalyzeRequest {
  stage?: string;
  operatorsJson?: string;
  operatorFilePath?: string;
}

export interface GenerateRequest extends AnalyzeRequest {
  pretty?: boolean;
  outputDir?: string;
  fileName?: string;
  newCandidate?: boolean;
  core?: "rule-core" | "deepseek-core";
}

export interface EnterPracticeRequest {
  stage?: string;
  maaPath?: string;
  scriptHash?: string;
  scriptPath?: string;
}

export interface FeedbackRequest {
  scriptHash?: string;
  killed?: number;
  total?: number;
  notes?: string;
}

export interface ValidateRequest {
  scriptJson?: string;
}

export interface OpenOutputDirRequest {
  outputDir?: string;
}

export interface SaveOperatorsRequest {
  operatorsJson?: string;
}
