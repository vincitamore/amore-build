/**
 * Adaptive heartbeat  -  cycle interval by phase.
 * alert → elevated → resting → drowsy → dreaming
 */

export type HeartbeatState = "alert" | "elevated" | "resting" | "drowsy" | "dreaming";

const RATES: Record<HeartbeatState, number> = {
  alert: 2000,
  elevated: 4000,
  resting: 8000,
  drowsy: 30000,
  dreaming: 300000,
};

const DECAY_THRESHOLDS: Array<{ from: HeartbeatState; to: HeartbeatState; afterMs: number }> = [
  { from: "alert", to: "elevated", afterMs: 2 * 60 * 1000 },
  { from: "elevated", to: "resting", afterMs: 5 * 60 * 1000 },
  { from: "resting", to: "drowsy", afterMs: 15 * 60 * 1000 },
  { from: "drowsy", to: "dreaming", afterMs: 30 * 60 * 1000 },
];

export class Heartbeat {
  private state: HeartbeatState = "resting";
  private lastStimulus: number = Date.now();

  get intervalMs(): number {
    this.autoDecay();
    return RATES[this.state];
  }

  get current(): HeartbeatState {
    this.autoDecay();
    return this.state;
  }

  get isResting(): boolean {
    this.autoDecay();
    return this.state === "resting" || this.state === "drowsy" || this.state === "dreaming";
  }

  get isDreaming(): boolean {
    this.autoDecay();
    return this.state === "dreaming";
  }

  get isDrowsy(): boolean {
    this.autoDecay();
    return this.state === "drowsy" || this.state === "dreaming";
  }

  get bpm(): number {
    return Math.round(60000 / RATES[this.state]);
  }

  stimulate(): void {
    const prev = this.state;
    this.state = "alert";
    this.lastStimulus = Date.now();
    if (prev !== "alert") {
      console.log(`  [HEARTBEAT] ${prev} -> alert (${RATES.alert / 1000}s interval)`);
    }
  }

  forceDreaming(): void {
    const prev = this.state;
    this.state = "dreaming";
    this.lastStimulus = Date.now() - 60 * 60 * 1000;
    console.log(`  [HEARTBEAT] ${prev} -> dreaming (forced by operator)`);
  }

  private autoDecay(): void {
    if (this.state === "dreaming") return;
    const elapsed = Date.now() - this.lastStimulus;
    for (const threshold of DECAY_THRESHOLDS) {
      if (this.state === threshold.from && elapsed > threshold.afterMs) {
        const prev = this.state;
        this.state = threshold.to;
        console.log(
          `  [HEARTBEAT] ${prev} -> ${this.state} (${RATES[this.state] / 1000}s interval, ${Math.round(elapsed / 1000)}s since activity)`,
        );
      }
    }
  }

  toString(): string {
    this.autoDecay();
    return `${this.state} (${RATES[this.state] / 1000}s, ~${this.bpm} bpm)`;
  }
}
