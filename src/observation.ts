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

function collectInventory(bot: BotLike): SelfState["inventory"] {
  let sword = false;
  let axe = false;
  let food = 0;
  let blocks = 0;
  let totalItems = 0;

  const items = safeItems(bot);
  const blockNames = bot.registry?.blocksByName;
  for (const item of items) {
    totalItems += item.count ?? 1;
    const name = item.name ?? "";
    if (name.endsWith("_sword")) sword = true;
    else if (name.endsWith("_axe")) axe = true;
    if (FOOD_NAMES.has(name)) food += item.count ?? 1;
    if (blockNames && name in blockNames) blocks += item.count ?? 1;
  }

  return { sword, axe, food, blocks, totalItems };
}

function safeItems(bot: BotLike): Item[] {
  try {
    return bot.inventory?.items() ?? [];
  } catch {
    return [];
  }
}

function shieldAvailable(bot: BotLike, entity: Entity): boolean {
  if (heldOrEquipped(entity).includes("shield")) return true;
  return safeItems(bot).some((item) => item.name === "shield");
}

function heldOrEquipped(entity: Entity): string[] {
  const equipment = Array.isArray(entity.equipment) ? entity.equipment : [];
  return equipment.map((item) => (item?.name ? item.name : "")).filter((name) => name !== "");
}

function armorNames(entity: Entity): string[] {
  return heldOrEquipped(entity).filter(isArmor);
}

function buildSelfState(bot: BotLike, attackReady: boolean): SelfState {
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
    shieldAvailable: shieldAvailable(bot, entity),
    armor: armorNames(entity),
    inventory: collectInventory(bot),
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
    return { visible: null, method: "unavailable" };
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
    return { visible: null, method: "unavailable" };
  }
}

function isSolid(block: Block | null): boolean {
  return Boolean(block && block.boundingBox === "block");
}

function directionClearance(bot: BotLike): DirectionClearance {
  const base = bot.entity.position;
  const feetY = Math.floor(base.y);
  const check = (dx: number, dz: number): boolean => {
    const x = Math.floor(base.x) + dx;
    const z = Math.floor(base.z) + dz;
    const feet = bot.blockAt(new Vec3(x, feetY, z));
    const head = bot.blockAt(new Vec3(x, feetY + 1, z));
    return !isSolid(feet) && !isSolid(head);
  };
  return {
    north: check(0, -1),
    south: check(0, 1),
    east: check(1, 0),
    west: check(-1, 0),
  };
}

function blockAtFeet(bot: BotLike): Block | null {
  const p = bot.entity.position;
  return bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)));
}

function blockBelow(bot: BotLike): Block | null {
  const p = bot.entity.position;
  return bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)));
}

function countNearbyHostiles(bot: BotLike, range: number): number {
  let count = 0;
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity || entity.type !== "hostile") continue;
    if (entity.isValid === false) continue;
    if (distance(entity.position, bot.entity.position) <= range) count += 1;
  }
  return count;
}

function buildEnvironment(bot: BotLike, visibility: VisibilityResult, range: number): EnvironmentState {
  const clearance = directionClearance(bot);
  const feet = blockAtFeet(bot);
  const below = blockBelow(bot);
  const feetName = feet?.name ?? "";
  return {
    dimension: bot.game?.dimension ?? null,
    movingInto: clearance,
    openDirectionCount: [clearance.north, clearance.south, clearance.east, clearance.west].filter(Boolean).length,
    groundBelow: isSolid(below),
    inWater: feetName.includes("water"),
    inLava: feetName.includes("lava"),
    nearbyHostiles: countNearbyHostiles(bot, range),
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

export async function sampleObservation(bot: BotLike, config: Config, options: SampleOptions): Promise<Observation> {
  const botEntity = bot.entity;
  const botEye = eyePosition(botEntity);

  let visibility: VisibilityResult = { visible: null, method: "unavailable" };
  if (options.target) {
    visibility = await estimateVisibility(bot, botEye, eyePosition(options.target));
  }

  const target = options.target
    ? buildTargetState(options.target, botEntity, botEntity.yaw, botEntity.pitch, config.target.range, visibility)
    : null;

  const targetHealthSource: FieldSource = target ? (target.health === null ? "unavailable" : "measured") : "unavailable";
  const visibilitySource: FieldSource = options.target ? visibility.method === "raycast" ? "estimated" : "unavailable" : "unavailable";

  return {
    tick: options.tick,
    sampledAtMs: options.now,
    self: buildSelfState(bot, options.attackReady),
    target,
    environment: buildEnvironment(bot, visibility, config.target.range),
    sources: {
      targetHealth: targetHealthSource,
      visibility: visibilitySource,
      attackReady: "estimated",
    },
  };
}
