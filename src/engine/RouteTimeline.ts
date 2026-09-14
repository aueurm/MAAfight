import type { EnemyDetail, EnemyRoute, SpawnEvent } from "../types";

export interface Cell {
  row: number;
  col: number;
}

export interface RouteTimelinePoint extends Cell {
  time: number;
  visible: boolean;
}

export interface SpawnRouteTimeline {
  routeId: number;
  motionMode: EnemyRoute["motionMode"];
  points: RouteTimelinePoint[];
  coverageGaps: string[];
}

export interface RouteTimelineOptions {
  bucketSeconds?: number;
  moveMultiplier?: number;
}

function sameCell(left: Cell, right: Cell): boolean {
  return left.row === right.row && left.col === right.col;
}

export function manhattanCells(from: Cell, to: Cell): Cell[] {
  const cells: Cell[] = [{ ...from }];
  let row = from.row;
  let col = from.col;
  while (row !== to.row || col !== to.col) {
    if (row !== to.row) row += Math.sign(to.row - row);
    else col += Math.sign(to.col - col);
    cells.push({ row, col });
  }
  return cells;
}

function isMovementCheckpoint(route: EnemyRoute, index: number): boolean {
  const type = route.checkpoints[index].type;
  return type === undefined || type === "MOVE" || type === "APPEAR_AT_POS";
}

interface RouteTraversal {
  cells: Cell[];
  waits: Map<number, number>;
  visibility: Map<number, boolean>;
  coverageGaps: string[];
}

function routeTraversal(route: EnemyRoute): RouteTraversal {
  const cells: Cell[] = [{ ...route.startPosition }];
  const waits = new Map<number, number>();
  const visibility = new Map<number, boolean>();
  const coverageGaps: string[] = [];
  let visible = true;
  visibility.set(0, visible);
  const append = (target: Cell): void => {
    for (const cell of manhattanCells(cells.at(-1)!, target).slice(1)) cells.push(cell);
  };

  for (const [index, checkpoint] of route.checkpoints.entries()) {
    if (isMovementCheckpoint(route, index)) {
      append(checkpoint);
      if (checkpoint.type === "APPEAR_AT_POS") visible = true;
      visibility.set(cells.length - 1, visible);
      continue;
    }
    if (checkpoint.type === "WAIT_FOR_SECONDS") {
      waits.set(cells.length - 1, (waits.get(cells.length - 1) || 0) + Math.max(0, checkpoint.waitSeconds || 0));
      continue;
    }
    if (checkpoint.type === "WAIT_CURRENT_FRAGMENT_TIME") {
      coverageGaps.push("route_wait_current_fragment_unknown");
      continue;
    }
    if (checkpoint.type === "DISAPPEAR") {
      visible = false;
      visibility.set(cells.length - 1, visible);
      coverageGaps.push("route_visibility_unknown");
    }
  }
  append(route.endPosition);
  visibility.set(cells.length - 1, visible);
  if (cells.length === 1 && !sameCell(route.startPosition, route.endPosition)) coverageGaps.push("route_path_empty");
  return { cells, waits, visibility, coverageGaps };
}

export function routePathCells(route: EnemyRoute): Cell[] {
  return routeTraversal(route).cells;
}

export function buildSpawnRouteTimeline(
  spawn: SpawnEvent,
  route: EnemyRoute,
  enemy: EnemyDetail,
  options: RouteTimelineOptions = {}
): SpawnRouteTimeline {
  const bucketSeconds = Math.max(0.1, options.bucketSeconds || 1);
  const traversal = routeTraversal(route);
  const rawSpeed = Number(enemy.moveSpeed);
  const moveMultiplier = options.moveMultiplier ?? 1;
  if (!Number.isFinite(moveMultiplier) || moveMultiplier <= 0) throw new Error("Invalid route moveMultiplier");
  const validSpeed = Number.isFinite(rawSpeed) && rawSpeed > 0;
  // moveMultiplier defines tiles per game second; MAA SpeedUp only changes the wall clock.
  const speed = (validSpeed ? rawSpeed : 1) * moveMultiplier;
  const coverageGaps = [...traversal.coverageGaps, ...(validSpeed ? [] : ["invalid_move_speed"])];
  const points: RouteTimelinePoint[] = [];
  let time = Math.max(0, spawn.time);
  let cellIndex = 0;
  let movement = 0;
  let waitRemaining = traversal.waits.get(0) || 0;
  let visible = traversal.visibility.get(0) ?? true;
  const push = (): void => {
    points.push({ ...traversal.cells[cellIndex], time: Number(time.toFixed(6)), visible });
  };
  push();

  for (let samples = 0; (cellIndex < traversal.cells.length - 1 || waitRemaining > 0) && samples < 10_000; samples++) {
    time += bucketSeconds;
    if (waitRemaining > 0) {
      waitRemaining = Math.max(0, waitRemaining - bucketSeconds);
    } else {
      movement += speed * bucketSeconds;
      while (movement >= 1 && cellIndex < traversal.cells.length - 1) {
        movement -= 1;
        cellIndex++;
        visible = traversal.visibility.get(cellIndex) ?? visible;
        waitRemaining += traversal.waits.get(cellIndex) || 0;
        if (waitRemaining > 0) break;
      }
    }
    push();
  }
  if (points.length >= 10_001) coverageGaps.push("route_timeline_limit");
  return { routeId: route.id, motionMode: route.motionMode, points, coverageGaps: [...new Set(coverageGaps)].sort() };
}
