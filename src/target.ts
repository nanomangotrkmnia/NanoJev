import type { Entity } from "prismarine-entity";
import type { Config } from "./config.js";
import type { BotLike } from "./minecraft/bot.js";
import { distance } from "./minecraft/math.js";

/** When no eligible target is found, wait this long before scanning the entity list again. */
const EMPTY_SCAN_TTL_MS = 200;

export interface TargetSelectorOptions {
  mode: "explicit" | "nearest";
  username?: string;
  range: number;
}

export class TargetSelector {
  private readonly options: TargetSelectorOptions;
  private current: Entity | null = null;
  private emptyUntil = 0;

  constructor(options: TargetSelectorOptions) {
    this.options = options;
  }

  static fromConfig(config: Config): TargetSelector {
    return new TargetSelector({
      mode: config.target.mode ?? (config.target.username ? "explicit" : "nearest"),
      username: config.target.username,
      range: config.target.range,
    });
  }

  get currentTarget(): Entity | null {
    return this.current;
  }

  reset(): void {
    this.current = null;
    this.emptyUntil = 0;
  }

  select(bot: BotLike, now: number = Date.now()): Entity | null {
    if (this.options.mode === "explicit") {
      const entity = this.resolveExplicit(bot);
      this.current = entity;
      return entity;
    }
    return this.selectNearest(bot, now);
  }

  private resolveExplicit(bot: BotLike): Entity | null {
    const username = this.options.username;
    if (!username) return null;
    const player = bot.players[username];
    const entity = player?.entity ?? null;
    if (entity && this.isEligible(bot, entity, { requireUsername: true })) return entity;
    const byName = Object.values(bot.entities ?? {}).find(
      (candidate) => candidate?.username === username && this.isEligible(bot, candidate),
    );
    return byName ?? null;
  }

  private selectNearest(bot: BotLike, now: number): Entity | null {
    const current = this.current;
    if (current && this.isEligible(bot, current)) return current;
    if (!current && now < this.emptyUntil) return null;

    const botPosition = bot.entity.position;
    let best: Entity | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const entity of Object.values(bot.entities ?? {})) {
      if (!entity || entity.type !== "player") continue;
      const dist = distance(entity.position, botPosition);
      if (dist >= bestDistance) continue;
      if (!this.isEligible(bot, entity, { distance: dist })) continue;
      best = entity;
      bestDistance = dist;
    }

    this.current = best;
    this.emptyUntil = best ? 0 : now + EMPTY_SCAN_TTL_MS;
    return best;
  }

  private isEligible(bot: BotLike, entity: Entity, opts: { requireUsername?: boolean; distance?: number } = {}): boolean {
    if (entity.isValid === false) return false;
    if (entity.id === bot.entity.id) return false;
    if (entity.type !== "player") return false;
    if (this.options.username && opts.requireUsername && entity.username !== this.options.username) return false;
    if (entity.username !== undefined && entity.username === bot.username) return false;
    if (typeof entity.health === "number" && entity.health <= 0) return false;
    const dist = opts.distance ?? distance(entity.position, bot.entity.position);
    if (dist > this.options.range) return false;
    return true;
  }
}
