import * as THREE from "three";
import { Choice, Score, Noul } from "../engine/Jev.js";
import { ARENA } from "./world.js";

export const ACTIONS = {
  patrol: "Walk the assigned patrol route. Right when the intruder's whereabouts are unknown and nothing happened recently.",
  investigate: "Go to the intruder's last known position and search. Right when the intruder was seen or heard recently but is not visible now.",
  chase: "Advance straight at the intruder and fire when in sight. Right when the intruder is visible and this guard is healthy.",
  take_cover: "Move behind the nearest cover relative to the intruder and shoot from there. Right when under fire or engaging at long range.",
  flank: "Circle to the intruder's side while allies keep pressure. Right when at least one ally is already engaging.",
  retreat: "Fall back away from the intruder. Right when badly hurt and exposed.",
};

export const ACTION_COLOR = {
  patrol: 0x6ee7b7,
  investigate: 0xfacc15,
  chase: 0xf87171,
  take_cover: 0x60a5fa,
  flank: 0xc084fc,
  retreat: 0x9ca3af,
};

const THREAT_LEVELS = [
  "None: no sign of the intruder",
  "Low: stale or indirect evidence",
  "Moderate: intruder known nearby but not engaging",
  "High: intruder visible or recently fired",
  "Critical: intruder close, visible, and this guard is being hit",
];

const SPEED = { patrol: 2.6, investigate: 4, chase: 5.2, take_cover: 5.6, flank: 5, retreat: 5.4 };
const MAX_HP = 3;
const _v = new THREE.Vector3();

export class Guard {
  constructor(game, id, spawn, route, flankSide) {
    this.game = game;
    this.id = id;
    this.hp = MAX_HP;
    this.alive = true;
    this.action = "patrol";
    this.confidence = 1;
    this.probabilities = {};
    this.threat = 0;
    this.alarmP = 0;
    this.route = route;
    this.routeIdx = 0;
    this.flankSide = flankSide;
    this.sees = false;
    this.lastSeenPos = null;
    this.lastSeenAt = -Infinity;
    this.lastHitAt = -Infinity;
    this.fireCooldown = 1;
    this.target = new THREE.Vector3();
    this.coverPoint = null;
    this.stuckTime = 0;
    this.jitter = new THREE.Vector3();

    const g = new THREE.Group();
    this.bodyMat = new THREE.MeshStandardMaterial({ color: 0xb4373f, roughness: 0.5 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 1.0, 6, 12), this.bodyMat);
    body.position.y = 0.9;
    body.castShadow = true;
    this.visorMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: ACTION_COLOR.patrol, emissiveIntensity: 2.5 });
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.16, 0.2), this.visorMat);
    visor.position.set(0, 1.45, -0.34);
    g.add(body, visor);
    g.position.copy(spawn);
    g.userData.guard = this;
    this.object3d = g;
    this.body = { position: g.position, radius: 0.45, height: 1.8 };

    // Vision cone indicator on the floor
    this.cone = new THREE.Mesh(
      new THREE.CircleGeometry(6, 24, Math.PI / 2 - Math.PI / 3, (Math.PI * 2) / 3),
      new THREE.MeshBasicMaterial({ color: ACTION_COLOR.patrol, transparent: true, opacity: 0.08, depthWrite: false })
    );
    this.cone.rotation.x = -Math.PI / 2;
    this.cone.position.y = 0.03;
    g.add(this.cone);

    this.brain = { id, questions: (s) => this.questions(s), apply: (a) => this.apply(a) };
  }

  get pos() {
    return this.object3d.position;
  }
  get eye() {
    return this.pos.clone().setY(this.pos.y + 1.5);
  }
  get facing() {
    const r = this.object3d.rotation.y;
    return new THREE.Vector3(-Math.sin(r), 0, -Math.cos(r));
  }

  // ---- Jev interface ------------------------------------------------------

  /** Compact, JSON-friendly view of this guard for the shared Jev state. */
  snapshot(time) {
    const p = this.game.player;
    const seenAgo = Number.isFinite(this.lastSeenAt) ? +(time - this.lastSeenAt).toFixed(1) : null;
    const allies = this.game.guards.filter((g) => g !== this && g.alive);
    return {
      hp: `${this.hp}/${MAX_HP}`,
      hp_value: this.hp,
      position: [+this.pos.x.toFixed(1), +this.pos.z.toFixed(1)],
      current_action: this.action,
      sees_intruder: this.sees,
      distance_to_intruder_m: this.sees || seenAgo !== null ? +this.pos.distanceTo(this.sees ? p.object3d.position : this.lastSeenPos).toFixed(1) : null,
      last_seen_intruder_s_ago: seenAgo,
      under_fire: time - this.lastHitAt < 3,
      allies_engaging: allies.filter((g) => g.sees && ["chase", "take_cover", "flank"].includes(g.action)).length,
      nearest_cover_m: +this.nearestCoverDist().toFixed(1),
    };
  }

  questions() {
    const id = this.id;
    const me = (s) => s.guards[id];
    return {
      action: Choice(
        `You command security guard "${id}" (see state.guards.${id}). Pick the guard's next tactical action for the next few seconds.`,
        ACTIONS,
        (s) => {
          const g = me(s);
          const knows = g.last_seen_intruder_s_ago !== null && g.last_seen_intruder_s_ago < 12;
          const d = g.distance_to_intruder_m ?? 99;
          return {
            patrol: knows || s.alarm_raised ? -1 : 2,
            investigate: (knows || s.alarm_raised) && !g.sees_intruder ? 2 : 0,
            chase: g.sees_intruder && g.hp_value >= 2 ? 2 + (d < 12 ? 0.6 : 0) : -1,
            take_cover: (g.under_fire ? 1.8 : 0) + (g.sees_intruder && d > 14 ? 1 : 0),
            flank: g.sees_intruder && g.allies_engaging >= 1 ? 1.9 : -1,
            retreat: g.hp_value <= 1 && g.sees_intruder ? 2.8 : -2,
          };
        }
      ),
      threat: Score(`How threatened is guard "${id}" right now?`, THREAT_LEVELS, (s) => {
        const g = me(s);
        let lvl = g.sees_intruder ? (g.distance_to_intruder_m < 8 ? 3.5 : 3) : g.last_seen_intruder_s_ago !== null ? 1.5 : 0;
        if (g.under_fire) lvl += 1;
        return Math.min(4, lvl);
      }),
      alarm: Noul(
        `Guard "${id}" should radio a base-wide alarm right now (only worth it if it has fresh eyes on the intruder and no alarm is active).`,
        (s) => {
          const g = me(s);
          return g.sees_intruder && !s.alarm_raised ? 2 : s.alarm_raised ? -2.5 : -3;
        }
      ),
    };
  }

  apply(ans) {
    const a = ans.action;
    if (a?.choice && ACTIONS[a.choice]) {
      this.probabilities = a.probabilities ?? {};
      // Calibrated confidence lets us add hysteresis: don't thrash on coin flips.
      if (a.choice === this.action || (a.confidence ?? 1) >= 0.3) {
        if (a.choice !== this.action) this.coverPoint = null;
        this.action = a.choice;
        this.confidence = a.confidence ?? 1;
      }
    }
    if (ans.threat) this.threat = Number(ans.threat.score) || 0;
    if (ans.alarm) {
      this.alarmP = ans.alarm.noul ?? 0;
      if (this.alarmP > 0.65 && this.sees) this.game.raiseAlarm(this);
    }
    const c = ACTION_COLOR[this.action];
    this.visorMat.emissive.setHex(c);
    this.cone.material.color.setHex(c);
  }

  // ---- Simulation (the engine executes; the model only chooses) ------------

  update(dt, engine) {
    if (!this.alive) return this._dying(dt);
    this._perceive(engine);
    this._steer(dt, engine);
    this._combat(dt, engine);
  }

  _perceive(engine) {
    const player = this.game.player;
    const pp = player.object3d.position;
    const toP = _v.subVectors(pp, this.pos).setY(0);
    const dist = toP.length();
    const inFov = dist < 4 || toP.normalize().dot(this.facing) > Math.cos(Math.PI / 3);
    const chest = pp.clone().setY(pp.y + 1.2);
    this.sees = player.alive && dist < 32 && inFov && engine.physics.lineOfSight(this.eye, chest);

    // Hearing: gunfire within 20m reveals the shooter's position.
    const heard = engine.time - player.lastShotAt < 0.1 && dist < 20;
    if (this.sees || heard) {
      this.lastSeenPos = pp.clone();
      this.lastSeenAt = engine.time;
    }
  }

  _pickTarget(engine) {
    const pp = this.game.player.object3d.position;
    switch (this.action) {
      case "patrol": {
        const wp = this.route[this.routeIdx];
        if (this.pos.distanceTo(wp) < 0.8) this.routeIdx = (this.routeIdx + 1) % this.route.length;
        return this.route[this.routeIdx];
      }
      case "investigate":
        return this.lastSeenPos ?? this.route[this.routeIdx];
      case "chase":
        return this.sees ? pp : this.lastSeenPos ?? pp;
      case "take_cover":
        if (!this.coverPoint || engine.time % 1 < engine.fixedDt) this.coverPoint = this.findCover(this.lastSeenPos ?? pp);
        return this.coverPoint;
      case "flank": {
        const ref = this.lastSeenPos ?? pp;
        const away = _v.subVectors(this.pos, ref).setY(0).normalize();
        const side = new THREE.Vector3(-away.z, 0, away.x).multiplyScalar(this.flankSide * 8);
        return clampArena(ref.clone().add(side).addScaledVector(away, 4));
      }
      case "retreat": {
        const away = _v.subVectors(this.pos, pp).setY(0).normalize();
        return clampArena(this.pos.clone().addScaledVector(away, 10));
      }
    }
    return this.pos;
  }

  _steer(dt, engine) {
    const target = this._pickTarget(engine);
    const to = new THREE.Vector3().subVectors(target, this.pos).setY(0);
    const d = to.length();
    const stopAt = this.action === "chase" && this.sees ? 6 : 0.6;
    const v = this.body.velocity;
    let desired = new THREE.Vector3();
    if (d > stopAt) desired = to.normalize().multiplyScalar(SPEED[this.action]).add(this.jitter);

    const k = 1 - Math.exp(-8 * dt);
    v.x += (desired.x - v.x) * k;
    v.z += (desired.z - v.z) * k;

    // Unstick: if we want to move but aren't, sidestep for a moment.
    const actual = Math.hypot(v.x, v.z);
    if (desired.lengthSq() > 1 && actual < 0.8) this.stuckTime += dt;
    else this.stuckTime = Math.max(0, this.stuckTime - dt);
    if (this.stuckTime > 0.5) {
      this.jitter.set(-desired.z, 0, desired.x).normalize().multiplyScalar(4 * (Math.random() < 0.5 ? -1 : 1));
      this.stuckTime = 0;
    }
    this.jitter.multiplyScalar(Math.exp(-2 * dt));

    // Face the intruder when we can see them, otherwise face where we're walking.
    const look = this.sees ? _v.subVectors(this.game.player.object3d.position, this.pos) : new THREE.Vector3(v.x, 0, v.z);
    if (look.lengthSq() > 0.01) {
      const want = Math.atan2(-look.x, -look.z);
      let diff = want - this.object3d.rotation.y;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.object3d.rotation.y += diff * (1 - Math.exp(-10 * dt));
    }
  }

  _combat(dt) {
    this.fireCooldown -= dt;
    if (!this.sees || this.fireCooldown > 0) return;
    const d = this.pos.distanceTo(this.game.player.object3d.position);
    const engaging = ["chase", "take_cover", "flank"].includes(this.action);
    const reflex = d < 5 && this.action !== "retreat"; // engine-side safety reflex
    if ((engaging && d < 26) || reflex) {
      this.fireCooldown = 0.9 + Math.random() * 0.5;
      this.game.guardFire(this, d);
    }
  }

  nearestCoverDist() {
    let best = Infinity;
    for (const c of this.game.world.covers) best = Math.min(best, c.center.distanceTo(this.pos) - c.half);
    return Math.max(0, best);
  }

  findCover(threatPos) {
    let best = null;
    let bestScore = Infinity;
    for (const c of this.game.world.covers) {
      const dir = _v.subVectors(c.center, threatPos).setY(0).normalize();
      const spot = clampArena(c.center.clone().addScaledVector(dir, c.half + 0.9));
      const score = spot.distanceTo(this.pos) + (spot.distanceTo(threatPos) < 6 ? 20 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = spot;
      }
    }
    return best ?? this.pos.clone();
  }

  hit(engine) {
    if (!this.alive) return;
    this.hp--;
    this.lastHitAt = engine.time;
    this.lastSeenPos = this.game.player.object3d.position.clone();
    this.lastSeenAt = engine.time;
    this.bodyMat.emissive.setHex(0xffffff);
    setTimeout(() => this.bodyMat.emissive.setHex(0x000000), 80);
    if (this.hp <= 0) {
      this.alive = false;
      this.dieT = 0;
      engine.physics.removeBody(this.body);
      this.cone.visible = false;
      this.visorMat.emissive.setHex(0x222222);
    }
  }

  _dying(dt) {
    if (this.dieT === undefined || this.dieT > 1) return;
    this.dieT += dt * 2.5;
    this.object3d.rotation.x = -Math.min(1, this.dieT) * (Math.PI / 2);
    this.object3d.position.y = 0.4 * Math.min(1, this.dieT);
  }
}

function clampArena(v) {
  const m = ARENA - 1.2;
  v.x = THREE.MathUtils.clamp(v.x, -m, m);
  v.z = THREE.MathUtils.clamp(v.z, -m, m);
  return v;
}
