import * as THREE from "three";

/**
 * Uniform navigation grid built from the physics' static boxes, inflated by an
 * agent radius. A* with 8-way moves (no corner cutting) plus line-of-sight
 * string pulling, so paths hug corners instead of zig-zagging cell to cell.
 */
export class NavGrid {
  constructor(physics, { half = 30, cell = 1, agentRadius = 0.5 } = {}) {
    this.half = half;
    this.cell = cell;
    this.n = Math.round((half * 2) / cell);
    this.blocked = new Uint8Array(this.n * this.n);
    const pad = agentRadius + 0.05;
    for (let z = 0; z < this.n; z++) {
      for (let x = 0; x < this.n; x++) {
        const wx = this.toWorldX(x);
        const wz = this.toWorldZ(z);
        for (const b of physics.statics) {
          if (b.min.y > 1.5) continue; // overhead geometry doesn't block walking
          if (wx > b.min.x - pad && wx < b.max.x + pad && wz > b.min.z - pad && wz < b.max.z + pad) {
            this.blocked[z * this.n + x] = 1;
            break;
          }
        }
      }
    }
  }

  toWorldX(i) {
    return -this.half + (i + 0.5) * this.cell;
  }
  toWorldZ(i) {
    return -this.half + (i + 0.5) * this.cell;
  }
  toCell(v) {
    const c = (t) => Math.min(this.n - 1, Math.max(0, Math.floor((t + this.half) / this.cell)));
    return [c(v.x), c(v.z)];
  }
  walkable(x, z) {
    return x >= 0 && z >= 0 && x < this.n && z < this.n && !this.blocked[z * this.n + x];
  }

  /** Closest walkable cell to (x,z), searching outward in rings. */
  nearestWalkable(x, z) {
    if (this.walkable(x, z)) return [x, z];
    for (let r = 1; r < 8; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) === r && this.walkable(x + dx, z + dz)) return [x + dx, z + dz];
        }
      }
    }
    return [x, z];
  }

  /** True if a straight walk between two world points stays on walkable cells. */
  clearLine(a, b) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const steps = Math.ceil(Math.hypot(dx, dz) / (this.cell * 0.35));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const [cx, cz] = this.toCell({ x: a.x + dx * t, z: a.z + dz * t });
      if (!this.walkable(cx, cz)) return false;
    }
    return true;
  }

  /** @returns {THREE.Vector3[]} waypoints from start (exclusive) to goal, or [] if unreachable. */
  findPath(from, to) {
    const n = this.n;
    const [sx, sz] = this.nearestWalkable(...this.toCell(from));
    const [gx, gz] = this.nearestWalkable(...this.toCell(to));
    const start = sz * n + sx;
    const goal = gz * n + gx;
    if (start === goal) return [to.clone().setY(0)];

    const g = new Float32Array(n * n).fill(Infinity);
    const came = new Int32Array(n * n).fill(-1);
    const closed = new Uint8Array(n * n);
    const heap = new MinHeap();
    const h = (i) => {
      const dx = Math.abs((i % n) - gx);
      const dz = Math.abs(((i / n) | 0) - gz);
      return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz); // octile
    };
    g[start] = 0;
    heap.push(start, h(start));

    let found = false;
    while (heap.size) {
      const cur = heap.pop();
      if (cur === goal) {
        found = true;
        break;
      }
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cx = cur % n;
      const cz = (cur / n) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const nx = cx + dx;
          const nz = cz + dz;
          if (!this.walkable(nx, nz)) continue;
          if (dx && dz && (!this.walkable(cx + dx, cz) || !this.walkable(cx, cz + dz))) continue;
          const ni = nz * n + nx;
          const cost = g[cur] + (dx && dz ? Math.SQRT2 : 1);
          if (cost < g[ni]) {
            g[ni] = cost;
            came[ni] = cur;
            heap.push(ni, cost + h(ni));
          }
        }
      }
    }
    if (!found) return [];

    const cells = [];
    for (let i = goal; i !== -1; i = came[i]) cells.push(i);
    cells.reverse();
    const pts = cells.map((i) => new THREE.Vector3(this.toWorldX(i % n), 0, this.toWorldZ((i / n) | 0)));
    pts[pts.length - 1] = to.clone().setY(0);

    // String pulling: skip any waypoint we can walk past in a straight line.
    const out = [];
    let anchor = from.clone().setY(0);
    let i = 0;
    while (i < pts.length) {
      let j = pts.length - 1;
      while (j > i && !this.clearLine(anchor, pts[j])) j--;
      out.push(pts[j]);
      anchor = pts[j];
      i = j + 1;
    }
    return out;
  }
}

class MinHeap {
  constructor() {
    this.k = [];
    this.p = [];
  }
  get size() {
    return this.k.length;
  }
  push(key, pri) {
    const { k, p } = this;
    let i = k.length;
    k.push(key);
    p.push(pri);
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (p[par] <= p[i]) break;
      [k[i], k[par]] = [k[par], k[i]];
      [p[i], p[par]] = [p[par], p[i]];
      i = par;
    }
  }
  pop() {
    const { k, p } = this;
    const top = k[0];
    const lk = k.pop();
    const lp = p.pop();
    if (k.length) {
      k[0] = lk;
      p[0] = lp;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && p[l] < p[m]) m = l;
        if (r < k.length && p[r] < p[m]) m = r;
        if (m === i) break;
        [k[i], k[m]] = [k[m], k[i]];
        [p[i], p[m]] = [p[m], p[i]];
        i = m;
      }
    }
    return top;
  }
}
