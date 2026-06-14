import type { SquadMode } from "../core/pipeline";

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
  squadMode?: SquadMode;
  pretty?: boolean;
  outputDir?: string;
  fileName?: string;
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
