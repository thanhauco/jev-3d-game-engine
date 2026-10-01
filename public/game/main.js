import * as THREE from "three";
import { Engine } from "../engine/Engine.js";
import { NavGrid } from "../engine/NavGrid.js";
import { JevClient, JevBrainSystem } from "../engine/Jev.js";
import { buildWorld } from "./world.js";
import { Player } from "./Player.js";
import { Guard, ACTION_COLOR } from "./Guard.js";
import { Squad, TACTIC_COLOR } from "./Squad.js";
import { Hud } from "./hud.js";

const CORE_SPOTS = [[-24, -24], [24, -24], [-24, 12], [22, 24], [0, -26]];

class Game {
  async init() {
    const canvas = document.getElementById("view");
    this.engine = new Engine({ canvas, bloom: { strength: 0.8, radius: 0.5, threshold: 0.8 } });
    const e = this.engine;

    this.world = buildWorld(e);
    this.nav = new NavGrid(e.physics, { half: 30, cell: 1, agentRadius: 0.5 });
    this.debug = false;
    this.squad = e.add(new Squad(this));
    this.player = e.add(new Player(this));

    const V = (x, z) => new THREE.Vector3(x, 0, z);
    this.guards = [
      new Guard(this, "g1", V(-22, -12), [V(-22, -12), V(-22, -24), V(-4, -24), V(-4, -12)], 1),
      new Guard(this, "g2", V(22, -12), [V(22, -12), V(22, -25), V(6, -24), V(6, -12)], -1),
      new Guard(this, "g3", V(-22, 10), [V(-22, 10), V(-24, 24), V(-10, 24), V(-8, 12)], -1),
      new Guard(this, "g4", V(20, 10), [V(20, 10), V(24, 24), V(10, 24), V(4, 12)], 1),
    ];
    this.guards.forEach((g) => e.add(g));

    this.cores = CORE_SPOTS.map(([x, z]) => {
      const m = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.45),
        new THREE.MeshStandardMaterial({ color: 0x7dd3fc, emissive: 0x38bdf8, emissiveIntensity: 1.6 })
      );
      m.position.set(x, 1, z);
      const light = new THREE.PointLight(0x38bdf8, 6, 6);
      m.add(light);
      e.scene.add(m);
      return m;
    });
    this.coresTaken = 0;
    this.alarmUntil = -Infinity;
    this.tracers = [];
    this.over = false;

    this.jev = await new JevClient().init();
    this.hud = new Hud(this);

    this.prevActions = {};
    this.prevTactic = this.squad.tactic;
    this.brains = e.addSystem(
      new JevBrainSystem(this.jev, {
        stateFn: (eng) => this.jevState(eng.time),
        signatureFn: (s) => this.signature(s),
        onDecision: (res) => {
          for (const g of this.guards) {
            if (g.alive && this.prevActions[g.id] !== g.action) {
              this.hud.log(`${g.id} → <b style="color:#${ACTION_COLOR[g.action].toString(16)}">${g.action}</b> (${Math.round(g.confidence * 100)}%)`);
              this.prevActions[g.id] = g.action;
            }
          }
          if (this.prevTactic !== this.squad.tactic) {
            this.hud.log(`squad tactic → <b style="color:#${TACTIC_COLOR[this.squad.tactic].toString(16)}">${this.squad.tactic.replace("_", " ")}</b> (${Math.round(this.squad.confidence * 100)}%)`);
            this.prevTactic = this.squad.tactic;
          }
          this.hud.onDecision(res);
        },
      })
    );

    // Frame-rate visuals: cores spin, tracers fade, HUD refresh.
    e.addSystem({
      update: (dt) => this.tick(dt),
      lateUpdate: (dt) => {
        for (const c of this.cores) if (c.visible) c.rotation.y += dt * 2;
        this.tracers = this.tracers.filter((t) => {
          t.life -= dt;
          t.line.material.opacity = Math.max(0, t.life / 0.12);
          if (t.life <= 0) e.scene.remove(t.line);
          return t.life > 0;
        });
        this.hud.frame();
      },
    });

    addEventListener("keydown", (ev) => {
      if (ev.code === "KeyR") location.reload();
      if (ev.code === "KeyG") this.debug = !this.debug;
      if (ev.code === "KeyP") this.exportRecording();
    });
    e.start();
  }

  /** The shared world state every guard's questions are asked against. */
  jevState(time) {
    const p = this.player;
    return {
      scenario: "Stealth game. An intruder is stealing data cores from a walled 60x60 m compound; guards defend it.",
      time_s: +time.toFixed(1),
      alarm_raised: time < this.alarmUntil,
      intruder: {
        hp: p.hp,
        sprinting: p.sprinting,
        fired_recently: time - p.lastShotAt < 2,
        cores_stolen: `${this.coresTaken}/${this.cores.length}`,
      },
      squad: this.squad.snapshot(time),
      guards: Object.fromEntries(this.guards.filter((g) => g.alive).map((g) => [g.id, g.snapshot(time)])),
    };
  }

  /**
   * Coarse fingerprint of the decision-relevant state. If it hasn't changed,
   * JevBrainSystem skips the call: same inputs, same answer, zero cost.
   */
  signature(s) {
    const b = (v, step) => (v === null ? "n" : Math.min(9, Math.floor(v / step)));
    return JSON.stringify([
      s.alarm_raised,
      s.intruder.cores_stolen,
      s.intruder.fired_recently,
      s.squad.current_tactic,
      s.squad.guards_alive,
      b(s.squad.last_known_s_ago, 8),
      Object.entries(s.guards).map(([id, g]) => [
        id, g.current_action, g.sees_intruder, g.hp_value, g.under_fire,
        b(g.distance_to_intruder_m, 6), b(g.suspicion, 0.34), b(g.last_seen_intruder_s_ago, 5), b(g.heard_noise_s_ago, 5),
      ]),
    ]);
  }

  exportRecording() {
    const blob = new Blob([this.brains.exportRecording()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `jev-decisions-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    this.hud.log(`Exported ${this.brains.recording.length} decisions`);
  }

  tick() {
    if (this.over) return;
    const pp = this.player.object3d.position;
    for (const c of this.cores) {
      if (c.visible && c.position.distanceTo(pp.clone().setY(1)) < 1.4) {
        c.visible = false;
        this.coresTaken++;
        this.hud.log(`Core stolen (${this.coresTaken}/${this.cores.length})`);
      }
    }
    if (this.coresTaken === this.cores.length) this.end(true);
    else if (!this.player.alive) this.end(false);
    else if (this.guards.every((g) => !g.alive)) this.end(true, "All guards down");
  }

  end(won, why) {
    this.over = true;
    document.exitPointerLock?.();
    this.hud.gameOver(won, why ?? (won ? "All cores extracted" : "You were caught"));
  }

  raiseAlarm(guard) {
    const t = this.engine.time;
    if (t < this.alarmUntil) return;
    this.alarmUntil = t + 12;
    const pos = this.player.object3d.position.clone();
    this.squad.remember(pos, t);
    for (const g of this.guards) {
      g.lastSeenPos = pos.clone();
      g.lastSeenAt = t;
      g.suspicion = Math.max(g.suspicion, 0.7);
    }
    this.hud.log(`<b style="color:#f87171">ALARM</b> raised by ${guard.id} (p=${guard.alarmP.toFixed(2)})`);
  }

  guardFire(guard, dist) {
    const p = this.player;
    let chance = THREE.MathUtils.clamp(1 - dist / 28, 0.15, 0.8);
    if (p.sprinting) chance *= 0.6;
    if (guard.action === "take_cover") chance *= 0.85;
    const hit = Math.random() < chance;
    const to = p.eye.add(new THREE.Vector3((Math.random() - 0.5) * (hit ? 0.2 : 2), -0.3, (Math.random() - 0.5) * (hit ? 0.2 : 2)));
    this.tracer(guard.eye, to, 0xff6b6b);
    if (hit) {
      p.damage(8);
      this.hud.flash();
    }
  }

  playerFire() {
    const cam = this.engine.camera;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(0, 0), cam);
    ray.far = 80;
    const targets = [...this.world.meshes, ...this.guards.filter((g) => g.alive).map((g) => g.object3d)];
    const hits = ray.intersectObjects(targets, true).filter((h) => h.distance > 2); // skip our own shoulder
    const first = hits[0];
    const end = first ? first.point : ray.ray.at(80, new THREE.Vector3());
    this.tracer(this.player.eye.add(new THREE.Vector3(0, -0.2, 0)), end, 0x7dd3fc);
    let o = first?.object;
    while (o && !o.userData.guard) o = o.parent;
    if (o) o.userData.guard.hit(this.engine);
  }

  tracer(from, to, color) {
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true }));
    this.engine.scene.add(line);
    this.tracers.push({ line, life: 0.12 });
  }
}

window.jev3d = new Game(); // exposed for console debugging
window.jev3d.init();
