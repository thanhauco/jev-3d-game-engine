import * as THREE from "three";
import { ACTIONS, ACTION_COLOR } from "./Guard.js";
import { TACTICS, TACTIC_COLOR } from "./Squad.js";
import { ARENA } from "./world.js";

const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;
const THREAT = ["none", "low", "moderate", "high", "critical"];
const $ = (id) => document.getElementById(id);

/** DOM overlay: player status, Jev decision inspector, floating guard tags. */
export class Hud {
  constructor(game) {
    this.game = game;
    this.tags = {};
    this.logLines = [];
    this.lastRes = null;
    this._t = 0;

    const live = game.jev.live;
    $("jev-mode").textContent = live ? "LIVE" : "MOCK";
    $("jev-mode").className = `badge ${live ? "live" : "mock"}`;
    $("jev-model").textContent = live ? game.jev.model : "local heuristic (no API key)";

    $("squad-bars").innerHTML = Object.keys(TACTICS)
      .map((t) => `<div class="bar" title="${t}"><i style="background:${hex(TACTIC_COLOR[t])}"></i><span>${t.replace("_", " ")}</span></div>`)
      .join("");

    this.map = $("minimap").getContext("2d");

    const cards = $("guards");
    for (const g of game.guards) {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="row"><b>${g.id}</b><span class="act"></span><span class="conf"></span></div>
        <div class="bars">${Object.keys(ACTIONS)
          .map((a) => `<div class="bar" title="${a}"><i style="background:${hex(ACTION_COLOR[a])}"></i><span>${a.replace("_", " ")}</span></div>`)
          .join("")}</div>
        <div class="row small"><span class="threat"></span><span class="alarm"></span></div>`;
      cards.appendChild(card);
      g.card = card;

      const tag = document.createElement("div");
      tag.className = "tag";
      $("tags").appendChild(tag);
      this.tags[g.id] = tag;
    }

    document.getElementById("view").addEventListener("click", () => $("intro").classList.add("hidden"));
  }

  onDecision(res) {
    this.lastRes = res;
  }

  log(html) {
    this.logLines.unshift(`<div><span>${this.game.engine.time.toFixed(1)}s</span> ${html}</div>`);
    this.logLines.length = Math.min(this.logLines.length, 8);
    $("log").innerHTML = this.logLines.join("");
  }

  flash() {
    const f = $("hurt");
    f.style.opacity = 0.45;
    setTimeout(() => (f.style.opacity = 0), 90);
  }

  drawMinimap() {
    const { game, map: c } = this;
    const S = c.canvas.width;
    const k = S / (ARENA * 2);
    const X = (x) => (x + ARENA) * k;
    const Z = (z) => (z + ARENA) * k;
    c.clearRect(0, 0, S, S);
    c.fillStyle = "rgba(14,17,22,.85)";
    c.fillRect(0, 0, S, S);
    c.fillStyle = "#3a4459";
    for (const b of game.engine.physics.statics) c.fillRect(X(b.min.x), Z(b.min.z), (b.max.x - b.min.x) * k, (b.max.z - b.min.z) * k);
    c.fillStyle = "#7dd3fc";
    for (const core of game.cores) if (core.visible) c.fillRect(X(core.position.x) - 2.5, Z(core.position.z) - 2.5, 5, 5);
    if (game.squad.memory) {
      const m = game.squad.memory.pos;
      c.strokeStyle = "#facc15";
      c.beginPath();
      c.arc(X(m.x), Z(m.z), 5, 0, Math.PI * 2);
      c.stroke();
    }
    for (const g of game.guards) {
      if (!g.alive) continue;
      const x = X(g.pos.x);
      const z = Z(g.pos.z);
      const ang = Math.atan2(g.facing.z, g.facing.x);
      c.fillStyle = hex(ACTION_COLOR[g.action]) + (g.sees ? "66" : "26");
      c.beginPath();
      c.moveTo(x, z);
      c.arc(x, z, 32 * k * (1 / 1.6), ang - Math.PI / 3, ang + Math.PI / 3);
      c.fill();
      c.fillStyle = hex(ACTION_COLOR[g.action]);
      c.beginPath();
      c.arc(x, z, 3, 0, Math.PI * 2);
      c.fill();
    }
    const p = game.player;
    const pp = p.object3d.position;
    c.save();
    c.translate(X(pp.x), Z(pp.z));
    c.rotate(-p.yaw);
    c.fillStyle = "#4fc3f7";
    c.beginPath();
    c.moveTo(0, -6);
    c.lineTo(4, 4);
    c.lineTo(-4, 4);
    c.fill();
    if (p.noiseRadius) {
      c.strokeStyle = "rgba(79,195,247,.35)";
      c.beginPath();
      c.arc(0, 0, p.noiseRadius * k, 0, Math.PI * 2);
      c.stroke();
    }
    c.restore();
  }

  gameOver(won, why) {
    $("over").classList.remove("hidden");
    $("over-title").textContent = won ? "Mission complete" : "Caught";
    $("over-title").style.color = won ? "#6ee7b7" : "#f87171";
    $("over-why").textContent = `${why}. Press R to play again.`;
  }

  frame() {
    const { game } = this;
    const cam = game.engine.camera;
    const w = innerWidth;
    const h = innerHeight;

    // Floating tags every frame (cheap)
    const v = new THREE.Vector3();
    for (const g of game.guards) {
      const tag = this.tags[g.id];
      v.copy(g.pos).setY(g.pos.y + 2.3).project(cam);
      const onScreen = g.alive && v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      tag.style.display = onScreen ? "block" : "none";
      if (!onScreen) continue;
      tag.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
      const sus = g.sees ? "!" : g.suspicion > 0.05 ? "?" : "";
      const susColor = g.sees ? "#f87171" : "#facc15";
      tag.innerHTML =
        `${g.id} · <b style="color:${hex(ACTION_COLOR[g.action])}">${g.action.replace("_", " ")}</b>` +
        (sus ? ` <b style="color:${susColor}">${sus}</b>` : "") +
        `<div class="sus"><i style="width:${Math.round(g.suspicion * 100)}%;background:${susColor}"></i></div>`;
    }

    this._t += 1;
    if (this._t % 2 === 0) this.drawMinimap();

    // Panel ~10x per second
    if (this._t % 6) return;
    const p = game.player;
    $("hp").style.width = `${p.hp}%`;
    $("hp-num").textContent = p.hp;
    $("cores").textContent = `${game.coresTaken}/${game.cores.length}`;
    $("alarm").classList.toggle("on", game.engine.time < game.alarmUntil);

    const b = game.brains;
    $("jev-calls").textContent = b.calls;
    $("jev-p95").textContent = `${Math.round(b.p95)} ms`;
    $("jev-int").textContent = `${b.interval.toFixed(2)} s`;
    $("jev-q").textContent = this.lastRes ? Object.keys(this.lastRes.answers).length : 0;
    $("jev-skip").textContent = b.skipped;
    $("jev-rec").textContent = b.recording.length;

    const sq = game.squad;
    $("squad-tactic").innerHTML = `<b style="color:${hex(TACTIC_COLOR[sq.tactic])}">${sq.tactic.replace("_", " ")}</b>`;
    $("squad-conf").textContent = `${Math.round(sq.confidence * 100)}%`;
    $("squad-morale").textContent = `morale: ${sq.moraleLabel}`;
    const sbars = document.querySelectorAll("#squad-bars .bar i");
    Object.keys(TACTICS).forEach((t, i) => (sbars[i].style.width = `${Math.round((sq.probabilities[t] ?? 0) * 100)}%`));
    $("stealth").textContent = p.crouching ? "crouched · silent" : p.sprinting ? "sprinting · loud" : p.moving ? "walking · quiet" : "still · silent";
    $("jev-err").textContent = game.jev.lastError ? `fallback: ${game.jev.lastError.slice(0, 80)}` : "";

    for (const g of game.guards) {
      const c = g.card;
      c.classList.toggle("dead", !g.alive);
      c.querySelector(".act").innerHTML = g.alive ? `<b style="color:${hex(ACTION_COLOR[g.action])}">${g.action.replace("_", " ")}</b>` : "down";
      c.querySelector(".conf").textContent = g.alive ? `${Math.round(g.confidence * 100)}%` : "";
      const bars = c.querySelectorAll(".bar i");
      Object.keys(ACTIONS).forEach((a, i) => (bars[i].style.width = `${Math.round((g.probabilities[a] ?? 0) * 100)}%`));
      c.querySelector(".threat").textContent = `threat: ${THREAT[g.threat] ?? g.threat}`;
      c.querySelector(".alarm").textContent = `alarm p=${g.alarmP.toFixed(2)}`;
    }
  }
}
