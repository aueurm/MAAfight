import type { RequirementsMode } from "../core/pipeline";

export interface ApiSuccess<T> {
  success: true;
  warnings: string[];
  errors: string[];
  data: T;
}

export interface ApiFailure {
  success: false;
  warnings: string[];
  errors: string[];
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

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
  requirementsMode?: RequirementsMode;
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
