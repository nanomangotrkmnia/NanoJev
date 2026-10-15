import { Vec3 } from "vec3";
import type { Entity } from "prismarine-entity";
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import type { Config } from "./config.js";
import type { BotLike } from "./minecraft/bot.js";
import {
  distance,
  horizontalLength,
  relativePitchDegrees,
  relativeYawDegrees,
  round,
  subtract,
  toDegrees,
  vectorLength,
  type Vec3Like,
} from "./minecraft/math.js";
import type {
  DirectionClearance,
  EnvironmentState,
  FieldSource,
  Observation,
  SelfState,
  TargetState,
} from "./state.js";

const ARMOR_SUFFIXES = ["_helmet", "_chestplate", "_leggings", "_boots", "_cap", "_tunic", "_pants"];
const FOOD_NAMES = new Set([
  "apple",
  "golden_apple",
  "enchanted_golden_apple",
  "bread",
  "cooked_beef",
  "cooked_porkchop",
  "cooked_chicken",
  "cooked_mutton",
  "cooked_rabbit",
  "cooked_cod",
  "cooked_salmon",
  "baked_potato",
  "carrot",
  "golden_carrot",
  "melon_slice",
  "sweet_berries",
  "dried_kelp",
]);

// Refresh windows for expensive per-tick work. Within a window the cached value is reused, so a
// stationary bot with a stationary target does far less work per tick.
const VISIBILITY_TTL_MS = 250;
const GEOMETRY_TTL_MS = 500;
const HOSTILE_TTL_MS = 250;
const INVENTORY_TTL_MS = 250;

const UNAVAILABLE: VisibilityResult = { visible: null, method: "unavailable" };

interface GeometrySnapshot {
  movingInto: DirectionClearance;
  openDirectionCount: number;
  groundBelow: boolean;
  inWater: boolean;
  inLava: boolean;
}

interface InventorySnapshot {
  summary: SelfState["inventory"];
  shield: boolean;
}

/**
 * Per-bot scratch space that lets the tick loop skip expensive observation work. Callers own one
 * instance and pass it to every `sampleObservation` call; omit it to always recompute (tests).
 */
export interface ObservationCache {
  visibility?: { key: string; atMs: number; result: VisibilityResult };
  geometry?: { key: string; atMs: number; value: GeometrySnapshot };
  hostiles?: { atMs: number; count: number };
  inventory?: { atMs: number; value: InventorySnapshot };
}

function cellKey(v: Vec3Like): string {
  return `${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`;
}

function eyeHeightOf(entity: Entity): number {
  const candidate = (entity as unknown as { eyeHeight?: number }).eyeHeight;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 1.62;
}

export function eyePosition(entity: Entity): Vec3Like {
  return { x: entity.position.x, y: entity.position.y + eyeHeightOf(entity), z: entity.position.z };
}

export function itemName(item: Item | null | undefined): string | null {
  return item && typeof item.name === "string" ? item.name : null;
}

function isArmor(name: string): boolean {
  return ARMOR_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function safeItems(bot: BotLike): Item[] {
  try {
    return bot.inventory?.items() ?? [];
  } catch {
    return [];
  }
}

/** A single pass over the inventory producing both the summary and whether a shield is carried. */
function scanInventory(bot: BotLike): InventorySnapshot {
  let sword = false;
  let axe = false;
  let food = 0;
  let blocks = 0;
  let totalItems = 0;
  let shield = false;

  const blockNames = bot.registry?.blocksByName;
  for (const item of safeItems(bot)) {
    const count = item.count ?? 1;
    totalItems += count;
    const name = item.name ?? "";
    if (name === "shield") shield = true;
    if (name.endsWith("_sword")) sword = true;
    else if (name.endsWith("_axe")) axe = true;
    if (FOOD_NAMES.has(name)) food += count;
    if (blockNames && name in blockNames) blocks += count;
  }

  return { summary: { sword, axe, food, blocks, totalItems }, shield };
}

function cachedInventory(bot: BotLike, cache: ObservationCache | undefined, asOf: number): InventorySnapshot {
  const hit = cache?.inventory;
  if (hit && asOf - hit.atMs < INVENTORY_TTL_MS) return hit.value;
  const value = scanInventory(bot);
  if (cache) cache.inventory = { atMs: asOf, value };
  return value;
}

function equipmentHasShield(entity: Entity): boolean {
  const equipment = entity.equipment;
  if (!Array.isArray(equipment)) return false;
  for (const item of equipment) {
    if (item && item.name === "shield") return true;
  }
  return false;
}

function armorNames(entity: Entity): string[] {
  const equipment = entity.equipment;
  if (!Array.isArray(equipment)) return [];
  const names: string[] = [];
  for (const item of equipment) {
    const name = item?.name;
    if (name && isArmor(name)) names.push(name);
  }
  return names;
}

function buildSelfState(bot: BotLike, attackReady: boolean, inventory: InventorySnapshot): SelfState {
  const entity = bot.entity;
  const velocity = entity.velocity ?? { x: 0, y: 0, z: 0 };
  return {
    username: bot.username,
    position: roundVec(entity.position),
    yawDeg: round(toDegrees(entity.yaw)),
    pitchDeg: round(toDegrees(entity.pitch)),
    velocity: roundVec(velocity),
    speed: round(horizontalLength(velocity)),
    onGround: Boolean(entity.onGround),
    health: bot.health,
    food: bot.food,
    heldItem: itemName(bot.heldItem),
    shieldAvailable: equipmentHasShield(entity) || inventory.shield,
    armor: armorNames(entity),
    inventory: inventory.summary,
    attackReady,
  };
}

function roundVec(v: Vec3Like): Vec3Like {
  return { x: round(v.x), y: round(v.y), z: round(v.z) };
}

export interface VisibilityResult {
  visible: boolean | null;
  method: "raycast" | "unavailable";
}

export async function estimateVisibility(
  bot: BotLike,
  from: Vec3Like,
  to: Vec3Like,
): Promise<VisibilityResult> {
  if (!bot.world || typeof bot.world.raycast !== "function") {
    return UNAVAILABLE;
  }
  const delta = subtract(to, from);
  const range = vectorLength(delta);
  if (range <= 0.01) return { visible: true, method: "raycast" };
  const direction = { x: delta.x / range, y: delta.y / range, z: delta.z / range };
  try {
    const hit = await bot.world.raycast(new Vec3(from.x, from.y, from.z), new Vec3(direction.x, direction.y, direction.z), range);
    if (!hit || !hit.position) return { visible: true, method: "raycast" };
    const blockedAt = distance(hit.position, from);
    return { visible: blockedAt >= range - 0.5, method: "raycast" };
  } catch {
    return UNAVAILABLE;
  }
}

async function cachedVisibility(
  bot: BotLike,
  botEye: Vec3Like,
  target: Entity,
  cache: ObservationCache | undefined,
  asOf: number,
): Promise<VisibilityResult> {
  const key = `${target.id}|${cellKey(target.position)}|${cellKey(botEye)}`;
  const hit = cache?.visibility;
  if (hit && hit.key === key && asOf - hit.atMs < VISIBILITY_TTL_MS) return hit.result;
  const result = await estimateVisibility(bot, botEye, eyePosition(target));
  if (cache) cache.visibility = { key, atMs: asOf, result };
  return result;
}

function isSolid(block: Block | null): boolean {
  return Boolean(block && block.boundingBox === "block");
}

function geometrySnapshot(bot: BotLike): GeometrySnapshot {
  const base = bot.entity.position;
  const bx = Math.floor(base.x);
  const feetY = Math.floor(base.y);
  const bz = Math.floor(base.z);
  const check = (dx: number, dz: number): boolean => {
    const x = bx + dx;
    const z = bz + dz;
    const feet = bot.blockAt(new Vec3(x, feetY, z));
    const head = bot.blockAt(new Vec3(x, feetY + 1, z));
    return !isSolid(feet) && !isSolid(head);
  };
  const movingInto: DirectionClearance = {
    north: check(0, -1),
    south: check(0, 1),
    east: check(1, 0),
    west: check(-1, 0),
  };
  const feet = bot.blockAt(new Vec3(bx, feetY, bz));
  const below = bot.blockAt(new Vec3(bx, feetY - 1, bz));
  const feetName = feet?.name ?? "";
  return {
    movingInto,
    openDirectionCount: (movingInto.north ? 1 : 0) + (movingInto.south ? 1 : 0) + (movingInto.east ? 1 : 0) + (movingInto.west ? 1 : 0),
    groundBelow: isSolid(below),
    inWater: feetName.includes("water"),
    inLava: feetName.includes("lava"),
  };
}

function cachedGeometry(bot: BotLike, cache: ObservationCache | undefined, asOf: number): GeometrySnapshot {
  const key = cellKey(bot.entity.position);
  const hit = cache?.geometry;
  if (hit && hit.key === key && asOf - hit.atMs < GEOMETRY_TTL_MS) return hit.value;
  const value = geometrySnapshot(bot);
  if (cache) cache.geometry = { key, atMs: asOf, value };
  return value;
}

function countNearbyHostiles(bot: BotLike, range: number, botPosition: Vec3Like): number {
  let count = 0;
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity || entity.type !== "hostile") continue;
    if (entity.isValid === false) continue;
    if (distance(entity.position, botPosition) <= range) count += 1;
  }
  return count;
}

function cachedHostiles(
  bot: BotLike,
  range: number,
  cache: ObservationCache | undefined,
  asOf: number,
): number {
  const hit = cache?.hostiles;
  if (hit && asOf - hit.atMs < HOSTILE_TTL_MS) return hit.count;
  const count = countNearbyHostiles(bot, range, bot.entity.position);
  if (cache) cache.hostiles = { atMs: asOf, count };
  return count;
}

function buildEnvironment(
  bot: BotLike,
  config: Config,
  visibility: VisibilityResult,
  cache: ObservationCache | undefined,
  asOf: number,
): EnvironmentState {
  const geometry = cachedGeometry(bot, cache, asOf);
  return {
    dimension: bot.game?.dimension ?? null,
    movingInto: geometry.movingInto,
    openDirectionCount: geometry.openDirectionCount,
    groundBelow: geometry.groundBelow,
    inWater: geometry.inWater,
    inLava: geometry.inLava,
    nearbyHostiles: cachedHostiles(bot, config.target.range, cache, asOf),
    visibilityMethod: visibility.method,
  };
}

function buildTargetState(
  entity: Entity,
  botEntity: Entity,
  botYaw: number,
  botPitch: number,
  range: number,
  visibility: VisibilityResult,
): TargetState {
  const from = botEntity.position;
  const targetEye = eyePosition(entity);
  const botEye = eyePosition(botEntity);
  const dist = distance(from, entity.position);
  const health = typeof entity.health === "number" && Number.isFinite(entity.health) ? entity.health : null;
  const valid = entity.isValid !== false;
  return {
    id: entity.id,
    username: entity.username ?? entity.name ?? `entity-${entity.id}`,
    valid,
    alive: valid && (health === null || health > 0),
    distance: round(dist),
    relativeYawDeg: round(relativeYawDegrees(botYaw, botEye, targetEye)),
    relativePitchDeg: round(relativePitchDegrees(botPitch, botEye, targetEye)),
    position: roundVec(entity.position),
    velocity: roundVec(entity.velocity ?? { x: 0, y: 0, z: 0 }),
    onGround: typeof entity.onGround === "boolean" ? entity.onGround : null,
    health,
    inRange: dist <= range,
    visible: visibility.visible,
  };
}

export interface SampleOptions {
  tick: number;
  now: number;
  attackReady: boolean;
  target: Entity | null;
}

export async function sampleObservation(
  bot: BotLike,
  config: Config,
  options: SampleOptions,
  cache?: ObservationCache,
): Promise<Observation> {
  const asOf = options.now;
  const botEntity = bot.entity;
  const botEye = eyePosition(botEntity);

  const visibility = options.target
    ? await cachedVisibility(bot, botEye, options.target, cache, asOf)
    : UNAVAILABLE;

  const target = options.target
    ? buildTargetState(options.target, botEntity, botEntity.yaw, botEntity.pitch, config.target.range, visibility)
    : null;

  const inventory = cachedInventory(bot, cache, asOf);
  const self = buildSelfState(bot, options.attackReady, inventory);

  const targetHealthSource: FieldSource = target ? (target.health === null ? "unavailable" : "measured") : "unavailable";
  const visibilitySource: FieldSource = options.target && visibility.method === "raycast" ? "estimated" : "unavailable";

  return {
    tick: options.tick,
    sampledAtMs: asOf,
    self,
    target,
    environment: buildEnvironment(bot, config, visibility, cache, asOf),
    sources: {
      targetHealth: targetHealthSource,
      visibility: visibilitySource,
      attackReady: "estimated",
    },
  };
}
