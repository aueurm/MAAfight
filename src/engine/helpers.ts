import type { EnginePick } from "./types";

export function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

export function rotateDirection([row, col]: [number, number], direction: string): [number, number] {
  if (direction === "Down") return [col, -row];
  if (direction === "Left") return [-row, -col];
  if (direction === "Up") return [-col, row];
  return [row, col];
}

export function squadSignature(picks: EnginePick[]): string {
  return picks.map(pick => `${pick.operatorId}:${pick.skill}`).sort().join("|");
}
