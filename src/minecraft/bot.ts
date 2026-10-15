import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import type { Block } from "prismarine-block";
import type { Vec3 } from "vec3";

export type ControlState = "forward" | "back" | "left" | "right" | "jump" | "sprint" | "sneak";

export interface PlayerLike {
  username: string;
  entity: Entity | null;
}

export interface WorldRaycaster {
  raycast(from: Vec3, direction: Vec3, range: number): Promise<Block | null>;
}

/**
 * The subset of the Mineflayer `Bot` used by NanoJev.
 *
 * Declared with method syntax so a real `mineflayer.Bot` is structurally assignable, and so
 * tests can supply a fake without importing the whole bot.
 */
export interface BotLike {
  readonly username: string;
  readonly version: string;
  entity: Entity;
  players: Record<string, PlayerLike>;
  entities: Record<string, Entity>;
  health: number;
  food: number;
  heldItem: Item | null;
  inventory: { items(): Item[]; slots: unknown[] };
  game?: { dimension?: string };
  registry?: { blocksByName?: Record<string, unknown> };
  world?: WorldRaycaster;

  setControlState(control: ControlState, state: boolean): void;
  clearControlStates(): void;
  look(yaw: number, pitch: number, force?: boolean): Promise<void>;
  lookAt(point: Vec3, force?: boolean): Promise<void>;
  attack(entity: Entity): void;
  activateItem(offhand?: boolean): void;
  deactivateItem(): void;
  equip(item: Item, destination?: string): Promise<void>;
  unequip(destination?: string): Promise<void>;
  blockAt(point: Vec3): Block | null;
  nearestEntity(filter?: (entity: Entity) => boolean): Entity | null;
  quit(reason?: string): void;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export type RealBot = Bot;
