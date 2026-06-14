import type { DeploymentPoint, MapData } from "../types";
import type { BattleTask, PositionScore } from "./types";

export type PositionPurpose = "melee" | "ranged" | "healing" | "both";

function distance(a: { row: number; col: number }, b: { row: number; col: number }): number {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

function nearestDistance(position: { row: number; col: number }, points: Array<{ row: number; col: number }>): number {
  if (points.length === 0) return 99;
  return Math.min(...points.map(point => distance(position, point)));
}

function routePoints(mapData: MapData): Array<{ row: number; col: number; routeId: number }> {
  return (mapData.routes || []).flatMap(route =>
    (route.checkpoints || []).map(point => ({ ...point, routeId: route.id }))
  );
}

function fallbackPointsFromDeploymentOrder(mapData: MapData): DeploymentPoint[] {
  return (mapData.deploymentOrder || []).map(rec => {
    const point = (mapData.deploymentPoints || []).find(dp =>
      dp.row === rec.position.row && dp.col === rec.position.col
    );
    return point || {
      row: rec.position.row,
      col: rec.position.col,
      buildableType: rec.role === "sniper" || rec.role === "caster" || rec.role === "medic" ? "ranged" : "melee",
    };
  });
}

function compatiblePoint(point: DeploymentPoint, purpose: PositionPurpose): boolean {
  if (purpose === "both") return true;
  if (purpose === "healing") return point.buildableType === "ranged";
  return point.buildableType === purpose;
}

function coverRouteCount(point: DeploymentPoint, points: Array<{ row: number; col: number; routeId: number }>, radius: number): number {
  const covered = new Set<number>();
  for (const routePoint of points) {
    if (distance(point, routePoint) <= radius) {
      covered.add(routePoint.routeId);
    }
  }
  return covered.size;
}

export function purposeForTask(task: BattleTask, fallback: PositionPurpose): PositionPurpose {
  if (task === "healing") return "healing";
  if (task === "anti_air" || task === "arts_damage" || task === "support" || task === "elite_control") return "ranged";
  if (task === "early_dp" || task === "lane_block" || task === "lane_hold" || task === "fast_redeploy") return "melee";
  return fallback;
}

export function scoreDeploymentPositions(input: {
  mapData: MapData;
  task: BattleTask;
  purpose: PositionPurpose;
  usedPositions?: Set<string>;
  corePositions?: Array<{ row: number; col: number }>;
  limit?: number;
}): PositionScore[] {
  const used = input.usedPositions || new Set<string>();
  const allPoints = (input.mapData.deploymentPoints || []).length > 0
    ? input.mapData.deploymentPoints
    : fallbackPointsFromDeploymentOrder(input.mapData);
  const purpose = purposeForTask(input.task, input.purpose);
  const points = allPoints.filter(point => compatiblePoint(point, purpose));
  const routePointList = routePoints(input.mapData);
  const starts = (input.mapData.strategicPoints || []).filter(point => point.type === "start");
  const ends = (input.mapData.strategicPoints || []).filter(point => point.type === "end");
  const chokepoints = (input.mapData.strategicPoints || []).filter(point => point.type === "chokepoint");
  const corePositions = input.corePositions || [];

  const scored = points
    .filter(point => !used.has(`${point.row},${point.col}`))
    .map((point): PositionScore => {
      const reasons: string[] = [];
      const routeDist = nearestDistance(point, routePointList);
      const endDist = nearestDistance(point, ends);
      const startDist = nearestDistance(point, starts);
      const chokeDist = nearestDistance(point, chokepoints);
      const routeCoverage = coverRouteCount(point, routePointList, purpose === "melee" ? 1 : 3);
      let score = 0;

      if (purpose === "melee") {
        score += Math.max(0, 40 - routeDist * 6);
        score += Math.max(0, 30 - chokeDist * 8);
        score += Math.max(0, 18 - endDist * 4);
        score += routeCoverage * 8;
        if (startDist <= 1) score -= 10;
        if (routeDist <= 2) reasons.push("near enemy path");
        if (chokeDist <= 2) reasons.push("near chokepoint");
        if (endDist <= 3) reasons.push("near blue box");
      } else if (purpose === "healing") {
        const coreCoverage = corePositions.filter(core => distance(point, core) <= 3).length;
        score += coreCoverage * 24;
        score += Math.max(0, 20 - routeDist * 3);
        if (startDist <= 2) score -= 12;
        if (coreCoverage > 0) reasons.push(`covers ${coreCoverage} core positions`);
        if (routeDist <= 3) reasons.push("near front line");
      } else {
        score += Math.max(0, 35 - routeDist * 5);
        score += routeCoverage * 12;
        if (chokeDist <= 3) score += 8;
        if (routeCoverage > 0) reasons.push(`covers ${routeCoverage} routes`);
        if (routeDist <= 3) reasons.push("near main route");
      }

      if (reasons.length === 0) reasons.push("fallback deployment order");
      return { row: point.row, col: point.col, buildableType: point.buildableType, score, reasons };
    })
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, input.limit || scored.length);
}
