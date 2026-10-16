export const COMBAT_ACTION_IDS = [
  "approach",
  "close_distance_sprinting",
  "strafe_left",
  "strafe_right",
  "retreat",
  "hold_position",
  "track_target",
  "attack_target",
  "jump_attack",
  "sprint_reset_attack",
  "hitselect",
  "jump_reset",
  "raise_shield",
  "reposition",
] as const;

export type CombatActionId = (typeof COMBAT_ACTION_IDS)[number];

export interface Vec3State {
  x: number;
  y: number;
  z: number;
}

export interface SelfState {
  username: string;
  position: Vec3State;
  yawDeg: number;
  pitchDeg: number;
  velocity: Vec3State;
  speed: number;
  onGround: boolean;
  health: number;
  food: number;
  heldItem: string | null;
  shieldAvailable: boolean;
  armor: string[];
  inventory: {
    sword: boolean;
    axe: boolean;
    food: number;
    blocks: number;
    totalItems: number;
  };
  attackReady: boolean;
}

export interface TargetState {
  id: number;
  username: string;
  valid: boolean;
  alive: boolean;
  distance: number;
  relativeYawDeg: number;
  relativePitchDeg: number;
  position: Vec3State;
  velocity: Vec3State;
  onGround: boolean | null;
  health: number | null;
  inRange: boolean;
  visible: boolean | null;
}

export interface DirectionClearance {
  north: boolean;
  south: boolean;
  east: boolean;
  west: boolean;
}

export interface EnvironmentState {
  dimension: string | null;
  movingInto: DirectionClearance;
  openDirectionCount: number;
  groundBelow: boolean;
  inWater: boolean;
  inLava: boolean;
  nearbyHostiles: number;
  visibilityMethod: "raycast" | "unavailable";
}

export type FieldSource = "measured" | "estimated" | "unavailable";

export interface Observation {
  tick: number;
  sampledAtMs: number;
  self: SelfState;
  target: TargetState | null;
  environment: EnvironmentState;
  sources: {
    targetHealth: FieldSource;
    visibility: FieldSource;
    attackReady: FieldSource;
  };
}

export interface LegalAction {
  id: CombatActionId;
  description: string;
}

export interface ChoiceSpec {
  instructions: string;
  criteria: Record<string, string>;
}

export interface DecisionResult {
  actionId: CombatActionId;
  probabilities: Record<string, number>;
  confidence: number | null;
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  latencyMs: number;
  answeredAtMs: number;
}

export type DecisionFailureKind = "timeout" | "unavailable" | "auth" | "invalid" | "stale" | "unknown";

export class JevError extends Error {
  readonly kind: DecisionFailureKind;
  readonly status?: number;

  constructor(kind: DecisionFailureKind, message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "JevError";
    this.kind = kind;
    this.status = status;
  }
}
