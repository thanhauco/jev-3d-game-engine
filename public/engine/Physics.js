import * as THREE from "three";

/**
 * Tiny kinematic physics: gravity, a ground plane at y=0, vertical-cylinder
 * bodies vs. static axis-aligned boxes, and body-vs-body separation.
 * Good enough for character games; swap for Rapier/cannon-es if you need more.
 */
export class Physics {
  constructor({ gravity = -24 } = {}) {
    this.gravity = gravity;
    this.bodies = new Set();
    this.statics = []; // THREE.Box3
  }

  addBody(b) {
    b.velocity ??= new THREE.Vector3();
    b.radius ??= 0.5;
    b.height ??= 1.8;
    b.grounded = false;
    this.bodies.add(b);
  }

  removeBody(b) {
    this.bodies.delete(b);
  }

  addStaticBox(box3) {
    this.statics.push(box3);
  }

  step(dt) {
    for (const b of this.bodies) {
      const p = b.position;
      b.velocity.y += this.gravity * dt;
      p.addScaledVector(b.velocity, dt);

      b.grounded = false;
      if (p.y <= 0) {
        p.y = 0;
        b.velocity.y = Math.max(0, b.velocity.y);
        b.grounded = true;
      }
      for (const box of this.statics) this._resolveBox(b, box);
    }
    this._separateBodies();
  }

  _resolveBox(b, box) {
    const p = b.position;
    // Vertical overlap?
    if (p.y >= box.max.y || p.y + b.height <= box.min.y) return;
    const cx = THREE.MathUtils.clamp(p.x, box.min.x, box.max.x);
    const cz = THREE.MathUtils.clamp(p.z, box.min.z, box.max.z);
    let dx = p.x - cx;
    let dz = p.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= b.radius * b.radius) return;

    // Landing on top of a box.
    if (b.velocity.y <= 0 && p.y > box.max.y - 0.35) {
      p.y = box.max.y;
      b.velocity.y = 0;
      b.grounded = true;
      return;
    }
    if (d2 > 1e-8) {
      const d = Math.sqrt(d2);
      const push = b.radius - d;
      p.x += (dx / d) * push;
      p.z += (dz / d) * push;
    } else {
      // Center is inside the box: push out along the shallowest axis.
      const opts = [
        [box.min.x - b.radius - p.x, 0],
        [box.max.x + b.radius - p.x, 0],
        [0, box.min.z - b.radius - p.z],
        [0, box.max.z + b.radius - p.z],
      ].sort((a, c) => Math.abs(a[0] + a[1]) - Math.abs(c[0] + c[1]));
      p.x += opts[0][0];
      p.z += opts[0][1];
    }
  }

  _separateBodies() {
    const list = [...this.bodies];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i].position;
        const b = list[j].position;
        const r = list[i].radius + list[j].radius;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const push = (r - d) / 2;
        a.x -= (dx / d) * push;
        a.z -= (dz / d) * push;
        b.x += (dx / d) * push;
        b.z += (dz / d) * push;
      }
    }
  }

  /** Line-of-sight test against static boxes (segment vs. AABB). */
  lineOfSight(from, to) {
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = dir.length();
    if (len < 1e-6) return true;
    const ray = new THREE.Ray(from, dir.divideScalar(len));
    const hit = new THREE.Vector3();
    for (const box of this.statics) {
      if (ray.intersectBox(box, hit) && hit.distanceTo(from) < len) return false;
    }
    return true;
  }
}
