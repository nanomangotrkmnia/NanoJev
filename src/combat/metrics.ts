export type DecisionOutcome = "ok" | "timeout" | "unavailable" | "auth" | "invalid" | "stale" | "unknown" | "skipped";

export interface DecisionSample {
  latencyMs: number;
  outcome: DecisionOutcome;
  atMs: number;
}

export interface MetricsSnapshot {
  decisions: number;
  ok: number;
  failures: number;
  timeouts: number;
  stale: number;
  skipped: number;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  maxLatencyMs: number | null;
  throughputPerSec: number;
}

export class DecisionMetrics {
  private readonly windowSize: number;
  private samples: DecisionSample[] = [];

  constructor(windowSize = 200) {
    this.windowSize = windowSize;
  }

  record(sample: DecisionSample): void {
    this.samples.push(sample);
    if (this.samples.length > this.windowSize) this.samples.splice(0, this.samples.length - this.windowSize);
  }

  private latencies(): number[] {
    return this.samples.filter((sample) => sample.outcome === "ok").map((sample) => sample.latencyMs).sort((a, b) => a - b);
  }

  snapshot(nowMs = Date.now()): MetricsSnapshot {
    const latencies = this.latencies();
    const ok = this.samples.filter((sample) => sample.outcome === "ok").length;
    const timeouts = this.samples.filter((sample) => sample.outcome === "timeout").length;
    const stale = this.samples.filter((sample) => sample.outcome === "stale").length;
    const skipped = this.samples.filter((sample) => sample.outcome === "skipped").length;
    const first = this.samples[0];
    const span = first ? Math.max(1, (nowMs - first.atMs) / 1000) : 1;

    return {
      decisions: this.samples.length,
      ok,
      failures: this.samples.length - ok - skipped,
      timeouts,
      stale,
      skipped,
      medianLatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      maxLatencyMs: latencies.length > 0 ? latencies[latencies.length - 1]! : null,
      throughputPerSec: ok / span,
    };
  }
}

export function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(p * sortedValues.length) - 1));
  return sortedValues[index]!;
}
