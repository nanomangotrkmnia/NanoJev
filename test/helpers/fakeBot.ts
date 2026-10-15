import { Vec3 } from "vec3";
import type { Entity } from "prismarine-entity";
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import type { BotLike, ControlState, PlayerLike } from "../../src/minecraft/bot.js";

const AIR: Partial<Block> = { name: "air", boundingBox: "empty" };
const STONE: Partial<Block> = { name: "stone", boundingBox: "block" };

export interface FakeBotCalls {
  controls: Array<{ control: ControlState; state: boolean }>;
  looks: Array<{ yaw: number; pitch: number; force?: boolean }>;
  looksAt: Vec3[];
  attacks: Entity[];
  equipped: Array<{ item: Item; destination?: string }>;
  activated: Array<boolean | undefined>;
  deactivated: number;
  quit: string[];
  raycasts: number;
}

export interface FakeTargetSpec {
  id?: number;
  username: string;
  position: [number, number, number];
  health?: number;
  onGround?: boolean;
  type?: Entity["type"];
}

export interface FakeBotOptions {
  username?: string;
  position?: [number, number, number];
  yaw?: number;
  pitch?: number;
  health?: number;
  food?: number;
  onGround?: boolean;
  heldItem?: ItemSpec | null;
  items?: ItemSpec[];
  equipment?: ItemSpec[];
  blocks?: string[];
  target?: FakeTargetSpec | null;
  solidAt?: (x: number, y: number, z: number) => boolean;
  raycastOccluder?: [number, number, number] | null;
  hasWorld?: boolean;
}

export type ItemSpec = Partial<Item> & { boundingBox?: "block" | "empty" };

export interface FakeBot {
  bot: BotLike;
  calls: FakeBotCalls;
  setPosition(position: [number, number, number]): void;
  setTarget(target: FakeTargetSpec | null): void;
  addEntity(spec: FakeTargetSpec): Entity;
  removeEntity(id: number): void;
  targetEntity(): Entity | null;
}

function toItem(partial: ItemSpec | null | undefined): Item | null {
  if (!partial) return null;
  return { name: "stone", count: 1, boundingBox: "empty", ...partial } as unknown as Item;
}

function makeEntity(spec: FakeTargetSpec): Entity {
  const entity = {
    id: spec.id ?? 42,
    type: spec.type ?? "player",
    username: spec.username,
    name: spec.username,
    isValid: true,
    onGround: spec.onGround ?? true,
    health: spec.health,
    yaw: 0,
    pitch: 0,
    height: 1.8,
    width: 0.6,
    position: new Vec3(spec.position[0], spec.position[1], spec.position[2]),
    velocity: new Vec3(0, 0, 0),
    equipment: [],
    effects: [],
  };
  return entity as unknown as Entity;
}

export function createFakeBot(options: FakeBotOptions = {}): FakeBot {
  const calls: FakeBotCalls = {
    controls: [],
    looks: [],
    looksAt: [],
    attacks: [],
    equipped: [],
    activated: [],
    deactivated: 0,
    quit: [],
    raycasts: 0,
  };

  const position = new Vec3(...(options.position ?? [0, 0, 0]));
  const entity = {
    id: 1,
    type: "player" as const,
    username: options.username ?? "NanoJev",
    name: options.username ?? "NanoJev",
    isValid: true,
    onGround: options.onGround ?? true,
    yaw: options.yaw ?? 0,
    pitch: options.pitch ?? 0,
    height: 1.8,
    width: 0.6,
    eyeHeight: 1.62,
    position,
    velocity: new Vec3(0, 0, 0),
    equipment: options.equipment ? options.equipment.map((item) => toItem(item)!) : [],
    effects: [],
  } as unknown as Entity;

  const entities: Record<string, Entity> = { "1": entity };
  const players: Record<string, PlayerLike> = {
    [entity.username!]: { username: entity.username!, entity },
  };

  let targetEntity: Entity | null = options.target ? addTarget(options.target) : null;

  function addTarget(spec: FakeTargetSpec): Entity {
    const created = makeEntity(spec);
    entities[String(created.id)] = created;
    players[spec.username] = { username: spec.username, entity: created };
    return created;
  }

  const items = (options.items ?? []).map((item) => toItem(item)!).filter(Boolean);

  const bot: BotLike = {
    username: entity.username!,
    version: "1.21.4",
    entity,
    players,
    entities,
    health: options.health ?? 20,
    food: options.food ?? 20,
    heldItem: toItem(options.heldItem ?? { name: "iron_sword", boundingBox: "empty" }),
    inventory: {
      items: () => items,
      slots: [],
    },
    game: { dimension: "minecraft:overworld" },
    registry: options.blocks ? { blocksByName: Object.fromEntries(options.blocks.map((name) => [name, {}])) } : undefined,
    world: options.hasWorld === false
      ? undefined
      : {
          raycast: async () => {
            calls.raycasts += 1;
            if (options.raycastOccluder) {
              return {
                name: "stone",
                boundingBox: "block",
                position: new Vec3(...options.raycastOccluder),
              } as unknown as Block;
            }
            return null;
          },
        },
    setControlState(control, state) {
      calls.controls.push({ control, state });
    },
    clearControlStates() {
      calls.controls.push({ control: "forward" as ControlState, state: false });
    },
    async look(yaw, pitch, force) {
      calls.looks.push({ yaw, pitch, force });
    },
    async lookAt(point) {
      calls.looksAt.push(point);
    },
    attack(target) {
      calls.attacks.push(target);
    },
    activateItem(offhand) {
      calls.activated.push(offhand);
    },
    deactivateItem() {
      calls.deactivated += 1;
    },
    async equip(item, destination) {
      calls.equipped.push({ item, destination });
    },
    async unequip() {
      /* no-op */
    },
    blockAt(point) {
      const solid = options.solidAt ? options.solidAt(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z)) : false;
      return (solid ? STONE : AIR) as unknown as Block;
    },
    nearestEntity(filter) {
      const all = Object.values(entities);
      return all.find((e) => (filter ? filter(e) : true)) ?? null;
    },
    quit(reason) {
      calls.quit.push(reason ?? "");
    },
    once() {
      return bot;
    },
    on() {
      return bot;
    },
    off() {
      return bot;
    },
  };

  return {
    bot,
    calls,
    setPosition(next) {
      position.x = next[0];
      position.y = next[1];
      position.z = next[2];
    },
    setTarget(next) {
      if (targetEntity) {
        targetEntity.isValid = false;
        delete entities[String(targetEntity.id)];
        if (targetEntity.username) delete players[targetEntity.username];
      }
      targetEntity = next ? addTarget(next) : null;
    },
    addEntity: (spec) => addTarget(spec),
    removeEntity(id) {
      const existing = entities[String(id)];
      if (existing) existing.isValid = false;
      if (existing?.username) delete players[existing.username];
      delete entities[String(id)];
      if (targetEntity && targetEntity.id === id) targetEntity = null;
    },
    targetEntity: () => targetEntity,
  };
}
