import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { Input } from "./Input.js";
import { Physics } from "./Physics.js";

/**
 * Minimal entity/system engine on top of Three.js.
 *  - Fixed-timestep simulation (default 60 Hz) decoupled from render rate.
 *  - Entities are plain objects with an optional `object3d`, `body`, and any
 *    components you attach. Systems are { update(dt, engine), lateUpdate?() }.
 *  - Optional bloom post-processing (`bloom: { strength, radius, threshold }`).
 */
export class Engine {
  constructor({ canvas, fixedHz = 60, background = 0x0e1116, bloom } = {}) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(background);
    this.scene.fog = new THREE.Fog(background, 40, 90);
    this.camera = new THREE.PerspectiveCamera(65, 1, 0.1, 200);

    if (bloom) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      const { strength = 0.7, radius = 0.4, threshold = 0.85 } = bloom;
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), strength, radius, threshold);
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new OutputPass());
    }

    this.input = new Input(canvas);
    this.physics = new Physics();
    this.entities = new Set();
    this.systems = [];
    this.time = 0;
    this.paused = false;

    this.fixedDt = 1 / fixedHz;
    this._acc = 0;
    this._last = 0;
    this._raf = 0;

    this._onResize = () => this.resize();
    addEventListener("resize", this._onResize);
    this.resize();
  }

  add(entity) {
    this.entities.add(entity);
    if (entity.object3d) this.scene.add(entity.object3d);
    if (entity.body) this.physics.addBody(entity.body);
    entity.onAdd?.(this);
    return entity;
  }

  remove(entity) {
    if (!this.entities.delete(entity)) return;
    if (entity.object3d) this.scene.remove(entity.object3d);
    if (entity.body) this.physics.removeBody(entity.body);
    entity.onRemove?.(this);
  }

  /** All entities that have every listed component key. */
  query(...keys) {
    const out = [];
    for (const e of this.entities) if (keys.every((k) => e[k] !== undefined)) out.push(e);
    return out;
  }

  addSystem(system) {
    this.systems.push(system);
    system.init?.(this);
    return system;
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.renderer.domElement;
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
  }

  start() {
    this._last = performance.now();
    const frame = (now) => {
      this._raf = requestAnimationFrame(frame);
      const elapsed = Math.min((now - this._last) / 1000, 0.25); // clamp after tab switch
      this._last = now;
      if (!this.paused) {
        this._acc += elapsed;
        while (this._acc >= this.fixedDt) {
          this.step(this.fixedDt);
          this._acc -= this.fixedDt;
        }
      }
      const alpha = this._acc / this.fixedDt;
      for (const s of this.systems) s.lateUpdate?.(elapsed, this, alpha);
      if (this.composer) this.composer.render(elapsed);
      else this.renderer.render(this.scene, this.camera);
      this.input.endFrame();
    };
    this._raf = requestAnimationFrame(frame);
  }

  step(dt) {
    this.time += dt;
    for (const s of this.systems) s.update?.(dt, this);
    this.physics.step(dt);
    for (const e of this.entities) e.update?.(dt, this);
  }

  stop() {
    cancelAnimationFrame(this._raf);
    removeEventListener("resize", this._onResize);
  }
}
