import * as THREE from "three";

export const ARENA = 30; // half-size

/** Builds lights, floor, walls, and cover crates. Returns obstacle info for AI + raycasts. */
export function buildWorld(engine) {
  const { scene, physics } = engine;

  scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x20242c, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(18, 30, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, far: 90 });
  scene.add(sun);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA * 2, ARENA * 2),
    new THREE.MeshStandardMaterial({ color: 0x1b2230, roughness: 0.95 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(ARENA * 2, 30, 0x2f3b52, 0x252e40);
  grid.position.y = 0.01;
  scene.add(grid);

  const meshes = [];
  const covers = [];
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a4459, roughness: 0.8 });
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x8a6a3d, roughness: 0.7 });
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x55607a, roughness: 0.6, metalness: 0.2 });

  const addBox = (x, z, w, h, d, mat, isCover) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, h / 2, z);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    const box = new THREE.Box3().setFromObject(m);
    physics.addStaticBox(box);
    meshes.push(m);
    if (isCover) covers.push({ center: new THREE.Vector3(x, 0, z), half: Math.max(w, d) / 2, box });
    return m;
  };

  // Perimeter
  const t = 1;
  addBox(0, -ARENA - t / 2, ARENA * 2 + 2 * t, 3, t, wallMat);
  addBox(0, ARENA + t / 2, ARENA * 2 + 2 * t, 3, t, wallMat);
  addBox(-ARENA - t / 2, 0, t, 3, ARENA * 2, wallMat);
  addBox(ARENA + t / 2, 0, t, 3, ARENA * 2, wallMat);

  // Cover crates (hand-placed so the map is readable)
  const crates = [
    [-18, -18, 3, 1.4, 3], [-8, -20, 2, 1.2, 4], [6, -17, 4, 1.4, 2], [18, -19, 3, 1.4, 3],
    [-20, -4, 2, 1.2, 5], [-10, -6, 3, 1.4, 3], [0, -8, 6, 1.2, 1.5], [11, -5, 3, 1.4, 3],
    [21, 2, 2, 1.2, 5], [-14, 7, 4, 1.4, 2], [-3, 5, 3, 1.4, 3], [8, 8, 2, 1.2, 4],
    [-20, 18, 3, 1.4, 3], [-7, 19, 4, 1.2, 2], [5, 20, 3, 1.4, 3], [17, 16, 3, 1.4, 3],
  ];
  for (const [x, z, w, h, d] of crates) addBox(x, z, w, h, d, crateMat, true);

  // Tall pillars break long sightlines
  for (const [x, z] of [[-13, -13], [13, -12], [-12, 13], [13, 12], [0, 0]]) addBox(x, z, 1.6, 6, 1.6, pillarMat, true);

  return { meshes, covers };
}
