import * as THREE from "three";

const EYE = 1.55;

/** Third-person character: WASD, Shift sprint, C crouch, Space jump, mouse look, click to fire. */
export class Player {
  constructor(game) {
    this.game = game;
    this.hp = 100;
    this.alive = true;
    this.yaw = 0;
    this.pitch = -0.15;
    this.fireCooldown = 0;
    this.lastShotAt = -99;
    this.sprinting = false;
    this.crouching = false;
    this.moving = false;

    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x4fc3f7, roughness: 0.4, emissive: 0x0a2a3a });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1.0, 6, 12), mat);
    body.position.y = 0.9;
    body.castShadow = true;
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.14, 0.2),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x88e1ff, emissiveIntensity: 2 })
    );
    visor.position.set(0, 1.45, -0.32);
    g.add(body, visor);
    this.mesh = body;
    this.visor = visor;
    this.object3d = g;

    this.body = { position: g.position, radius: 0.45, height: 1.8 };
    g.position.set(0, 0, 24);
  }

  /** How far footsteps carry this frame (metres). Crouching is silent. */
  get noiseRadius() {
    if (!this.moving || !this.body.grounded || this.crouching) return 0;
    return this.sprinting ? 13 : 5;
  }

  /** Multiplier on how quickly guards notice the player. */
  get visibility() {
    return (this.crouching ? 0.45 : 1) * (this.sprinting ? 1.4 : 1);
  }

  /** Point guards try to see: head height standing, below crate tops (1.2-1.4m) when crouched. */
  get chest() {
    const p = this.object3d.position;
    return new THREE.Vector3(p.x, p.y + (this.crouching ? 0.8 : 1.55), p.z);
  }

  get eye() {
    return this.object3d.position.clone().setY(this.object3d.position.y + EYE);
  }

  update(dt, engine) {
    if (!this.alive) return;
    const { input, physics } = engine;

    const m = input.consumeMouse();
    this.yaw -= m.x * 0.0025;
    this.pitch = THREE.MathUtils.clamp(this.pitch - m.y * 0.0025, -1.1, 0.6);

    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const move = new THREE.Vector3();
    if (input.isDown("KeyW")) move.add(fwd);
    if (input.isDown("KeyS")) move.sub(fwd);
    if (input.isDown("KeyD")) move.add(right);
    if (input.isDown("KeyA")) move.sub(right);
    this.moving = move.lengthSq() > 0;
    this.crouching = input.isDown("KeyC") || input.isDown("ControlLeft");
    this.sprinting = input.isDown("ShiftLeft") && this.moving && !this.crouching;
    const speed = this.crouching ? 2.6 : this.sprinting ? 9 : 5.5;
    const s = this.crouching ? 0.65 : 1;
    this.mesh.scale.y += (s - this.mesh.scale.y) * 0.3;
    this.mesh.position.y = 0.9 * this.mesh.scale.y;
    this.visor.position.y = 1.45 * this.mesh.scale.y;
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed);

    const v = this.body.velocity;
    const k = this.body.grounded ? 1 - Math.exp(-14 * dt) : 1 - Math.exp(-3 * dt);
    v.x += (move.x - v.x) * k;
    v.z += (move.z - v.z) * k;
    if (input.wasPressed("Space") && this.body.grounded && !this.crouching) v.y = 8.5;

    this.object3d.rotation.y = this.yaw;

    this.fireCooldown -= dt;
    if (input.wasClicked(0) && input.locked && this.fireCooldown <= 0) {
      this.fireCooldown = 0.28;
      this.lastShotAt = engine.time;
      this.game.playerFire();
    }

    this._updateCamera(engine.camera, physics);
  }

  _updateCamera(camera, physics) {
    const pivot = this.eye.add(new THREE.Vector3(0, 0.25, 0));
    const dir = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      -Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch)
    );
    // Over-the-shoulder offset
    const shoulder = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).multiplyScalar(0.7);
    let dist = 4.2;
    const want = pivot.clone().add(shoulder).addScaledVector(dir, dist);
    // Pull camera in if a wall is between it and the player
    while (dist > 0.8 && !physics.lineOfSight(pivot, want)) {
      dist -= 0.3;
      want.copy(pivot).add(shoulder).addScaledVector(dir, dist);
    }
    camera.position.copy(want);
    camera.lookAt(pivot.clone().add(shoulder).addScaledVector(dir, -10));
  }

  damage(n) {
    if (!this.alive) return;
    this.hp = Math.max(0, this.hp - n);
    if (this.hp === 0) this.alive = false;
  }
}
