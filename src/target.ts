import type { Entity } from "prismarine-entity";
import type { Config } from "./config.js";
import type { BotLike } from "./minecraft/bot.js";
import { distance } from "./minecraft/math.js";

export interface TargetSelectorOptions {
  mode: "explicit" | "nearest";
  username?: string;
  range: number;
}

export class TargetSelector {
  private readonly options: TargetSelectorOptions;
  private current: Entity | null = null;

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
  }

  select(bot: BotLike): Entity | null {
    if (this.options.mode === "explicit") {
      const entity = this.resolveExplicit(bot);
      this.current = entity;
      return entity;
    }
    return this.selectNearest(bot);
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

  private selectNearest(bot: BotLike): Entity | null {
    if (this.current && this.isEligible(bot, this.current)) return this.current;

    let best: Entity | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const entity of Object.values(bot.entities ?? {})) {
      if (!entity || entity.type !== "player") continue;
      if (!this.isEligible(bot, entity)) continue;
      const dist = distance(entity.position, bot.entity.position);
      if (dist < bestDistance) {
        best = entity;
        bestDistance = dist;
      }
    }
    this.current = best;
    return best;
  }

  private isEligible(bot: BotLike, entity: Entity, opts: { requireUsername?: boolean } = {}): boolean {
    if (entity.isValid === false) return false;
    if (entity.id === bot.entity.id) return false;
    if (entity.type !== "player") return false;
    if (this.options.username && opts.requireUsername && entity.username !== this.options.username) return false;
    if (entity.username !== undefined && entity.username === bot.username) return false;
    if (typeof entity.health === "number" && entity.health <= 0) return false;
    if (distance(entity.position, bot.entity.position) > this.options.range) return false;
    return true;
  }
}
