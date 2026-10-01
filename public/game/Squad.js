import * as THREE from "three";
import { Choice, Score } from "../engine/Jev.js";

export const TACTICS = {
  sweep: "Each guard walks its own patrol route. Right when nobody knows where the intruder is.",
  hold_cores: "Guards stand watch around the remaining data cores. Right when cores are disappearing but the intruder is unseen.",
  hunt: "Guards converge on the squad's last known intruder position from different angles. Right after a sighting goes cold.",
  pincer: "Guards in contact split and attack from opposite sides. Right when the intruder is visible and at least two guards are alive.",
  regroup: "Survivors pull together near the squad's centre. Right after heavy casualties.",
};

export const TACTIC_COLOR = { sweep: 0x6ee7b7, hold_cores: 0x7dd3fc, hunt: 0xfacc15, pincer: 0xc084fc, regroup: 0x9ca3af };

const MORALE = ["Broken", "Shaken", "Steady", "Confident", "Dominant"];

/**
 * Squad commander: a second, slower layer of Jev decisions. Its tactic is part
 * of the shared state, so each guard's own Choice is conditioned on it the
 * next tick (hierarchical control with no extra round trips; the commander's
 * questions ride along in the same batched request as the guards').
 */
export class Squad {
  constructor(game) {
    this.game = game;
    this.alive = true;
    this.tactic = "sweep";
    this.confidence = 1;
    this.probabilities = {};
    this.morale = 2;
    this.memory = null; // { pos: Vector3, t: number }  shared last-known intruder position
    this.brain = { id: "squad", questions: () => this.questions(), apply: (a) => this.apply(a) };
  }

  remember(pos, t) {
    this.memory = { pos: pos.clone(), t };
  }

  snapshot(time) {
    const alive = this.game.guards.filter((g) => g.alive);
    return {
      current_tactic: this.tactic,
      guards_alive: alive.length,
      casualties: this.game.guards.length - alive.length,
      any_guard_sees_intruder: alive.some((g) => g.sees),
      max_suspicion: +Math.max(0, ...alive.map((g) => g.suspicion)).toFixed(2),
      last_known_intruder_pos: this.memory ? [+this.memory.pos.x.toFixed(1), +this.memory.pos.z.toFixed(1)] : null,
      last_known_s_ago: this.memory ? +(time - this.memory.t).toFixed(1) : null,
    };
  }

  questions() {
    return {
      tactic: Choice(
        "You are the guard squad commander (state.squad). Choose the squad-wide tactic for the next several seconds.",
        TACTICS,
        (s) => {
          const q = s.squad;
          const stolen = parseInt(s.intruder.cores_stolen, 10) || 0;
          const cold = q.last_known_s_ago !== null && q.last_known_s_ago < 25 && !q.any_guard_sees_intruder;
          return {
            sweep: q.last_known_s_ago === null && stolen === 0 ? 2 : 0,
            hold_cores: !q.any_guard_sees_intruder && stolen >= 1 ? 1.4 + 0.3 * stolen - (cold ? 0.8 : 0) : -1,
            hunt: cold ? 2.2 : -1,
            pincer: q.any_guard_sees_intruder && q.guards_alive >= 2 ? 2.6 : -1,
            regroup: q.casualties >= 2 ? 1.8 + (q.any_guard_sees_intruder ? -0.6 : 0.4) : -2,
          };
        }
      ),
      morale: Score("How confident is the guard squad overall?", MORALE, (s) => {
        const q = s.squad;
        return Math.max(0, Math.min(4, 2.5 - q.casualties * 0.9 + (s.intruder.hp < 50 ? 1 : 0)));
      }),
    };
  }

  apply(ans) {
    const a = ans.tactic;
    if (a?.choice && TACTICS[a.choice] && (a.choice === this.tactic || (a.confidence ?? 1) >= 0.3)) {
      this.tactic = a.choice;
      this.confidence = a.confidence ?? 1;
    }
    if (a?.probabilities) this.probabilities = a.probabilities;
    if (ans.morale) this.morale = Number(ans.morale.score) || 0;
  }

  get moraleLabel() {
    return MORALE[this.morale] ?? this.morale;
  }

  /** Where a guard should "patrol" under the current tactic, or null to use its own route. */
  patrolTarget(guard, time) {
    const alive = this.game.guards.filter((g) => g.alive);
    const idx = alive.indexOf(guard);
    const ring = (center, r) => {
      // Slowly orbit the point so guards keep scanning instead of standing still.
      const a = idx * ((Math.PI * 2) / Math.max(alive.length, 1)) + time * 0.25;
      return new THREE.Vector3(center.x + Math.cos(a) * r, 0, center.z + Math.sin(a) * r);
    };
    switch (this.tactic) {
      case "hold_cores": {
        const cores = this.game.cores.filter((c) => c.visible);
        if (!cores.length) return null;
        return ring(cores[idx % cores.length].position, 3.5);
      }
      case "hunt":
        return this.memory ? ring(this.memory.pos, 4) : null;
      case "regroup": {
        const c = new THREE.Vector3();
        alive.forEach((g) => c.add(g.pos));
        return ring(c.divideScalar(alive.length || 1), 2.5);
      }
      default:
        return null;
    }
  }

  /** In a pincer, alternate guards take opposite flanks. */
  flankSide(guard) {
    if (this.tactic !== "pincer") return guard.flankSide;
    return this.game.guards.filter((g) => g.alive).indexOf(guard) % 2 ? 1 : -1;
  }
}
