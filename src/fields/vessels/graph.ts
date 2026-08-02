import type { LoadedField } from '../loader';
import { TERRITORY, territoryOf, type TerritoryId } from '../../disease/territories';

/**
 * Cerebral arterial tree, grown by space colonization (Runions et al. 2007).
 *
 * The algorithm: scatter attractor points through the tissue an artery is meant
 * to supply, then repeatedly let each attractor pull the nearest branch tip
 * toward it, adding a short segment in the average direction of the attractors
 * influencing that tip. Attractors are consumed once a branch gets close
 * enough. The result is a branching tree that fills its target volume without
 * any of the branching being authored.
 *
 * Run on the CPU: it is inherently iterative and pointer-chasing, awkward on a
 * GPU, and ~20k segments costs a couple of hundred milliseconds in TypeScript.
 *
 * **Attractors are partitioned by territory.** Each root only competes for
 * points in the territory it supplies, so the tree that grows is consistent
 * with the perfusion map by construction — occluding the M1 trunk starves
 * exactly the branches that feed the MCA territory, rather than approximately.
 *
 * The seed geometry (a Circle of Willis and the proximal trunks) IS authored:
 * about fifty coordinates. It is not a mesh, texture, HDRI or animation, and it
 * is the one place in this project where anatomy is hand-placed rather than
 * derived — flagged here rather than buried.
 */

export interface VesselNode {
  x: number;
  y: number;
  z: number;
  parent: number;
  territory: TerritoryId;
  /** Radius in mm, assigned after growth by Murray's law. */
  radius: number;
  /** Root trunk this node descends from, for occlusion highlighting. */
  root: number;
}

export interface VesselTree {
  nodes: VesselNode[];
  /** Root node index per trunk, in the order of TRUNKS. */
  rootNodes: number[];
  trunks: typeof TRUNKS;
  buildMs: number;
  attractorsUsed: number;
}

interface Trunk {
  name: string;
  territory: TerritoryId;
  /** Authored proximal course, world mm (X = right, Y = superior, Z = anterior). */
  path: Array<[number, number, number]>;
}

/**
 * Circle of Willis and proximal trunks, hand-placed in the subject's world
 * frame. Mirrored left/right from a single side.
 */
const HALF_TRUNKS: Trunk[] = [
  {
    name: 'ICA → MCA M1',
    territory: TERRITORY.mcaSuperior,
    path: [
      [14, -34, 14],
      [18, -28, 10],
      [26, -24, 6],
      [34, -20, 2],
    ],
  },
  {
    name: 'MCA inferior division',
    territory: TERRITORY.mcaInferior,
    path: [
      [26, -24, 6],
      [36, -24, -2],
      [44, -22, -8],
    ],
  },
  {
    name: 'Lenticulostriates',
    territory: TERRITORY.mcaDeep,
    path: [
      [26, -24, 6],
      [24, -16, 6],
      [22, -8, 5],
    ],
  },
  {
    name: 'ACA A1 → A2',
    territory: TERRITORY.aca,
    path: [
      [14, -34, 14],
      [8, -30, 20],
      [4, -22, 30],
      [3, -8, 36],
    ],
  },
  {
    name: 'PCA P1 → P2',
    territory: TERRITORY.pcaCortical,
    path: [
      [4, -34, -14],
      [12, -30, -22],
      [20, -26, -32],
    ],
  },
  {
    name: 'Thalamoperforators',
    territory: TERRITORY.pcaPerforating,
    path: [
      [4, -34, -14],
      [7, -26, -12],
      [9, -18, -10],
    ],
  },
  {
    name: 'Anterior choroidal',
    territory: TERRITORY.anteriorChoroidal,
    path: [
      [18, -28, 10],
      [24, -26, -2],
      [28, -24, -12],
    ],
  },
  {
    name: 'Cerebellar (SCA/AICA/PICA)',
    territory: TERRITORY.cerebellar,
    path: [
      [2, -40, -22],
      [12, -44, -34],
      [22, -48, -44],
    ],
  },
];

/** Basilar perforators are midline and not mirrored. */
const MIDLINE_TRUNKS: Trunk[] = [
  {
    name: 'Basilar perforators',
    territory: TERRITORY.basilarPerforators,
    path: [
      [0, -46, -18],
      [0, -38, -16],
      [0, -30, -14],
    ],
  },
];

export const TRUNKS: Trunk[] = [
  ...HALF_TRUNKS.map((t) => ({
    ...t,
    name: `Left ${t.name}`,
    path: t.path.map(([x, y, z]) => [-x, y, z] as [number, number, number]),
  })),
  ...HALF_TRUNKS.map((t) => ({ ...t, name: `Right ${t.name}` })),
  ...MIDLINE_TRUNKS,
];

interface Attractor {
  x: number;
  y: number;
  z: number;
  territory: number;
  dead: boolean;
}

/** Deterministic PRNG so the tree is identical on every load. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GrowOptions {
  attractorCount?: number;
  influenceMm?: number;
  killMm?: number;
  stepMm?: number;
  maxIterations?: number;
  seed?: number;
}

export function growVessels(field: LoadedField, opts: GrowOptions = {}): VesselTree {
  const t0 = performance.now();
  const {
    attractorCount = 9000,
    influenceMm = 34,
    killMm = 5,
    stepMm = 3,
    maxIterations = 220,
    seed = 20260801,
  } = opts;

  const dim = field.manifest.grid.dim;
  const half = field.manifest.grid.halfExtentMm;
  const range = field.manifest.sdf.rangeMm;
  const rnd = mulberry32(seed);

  // Payload byte order is x-fastest (WebGPU texture order), so the linear index
  // is x + y*dim + z*dim*dim — NOT the numpy [x][y][z] convention.
  const idxOf = (ix: number, iy: number, iz: number) => ix + iy * dim + iz * dim * dim;
  const distAt = (ix: number, iy: number, iz: number) => {
    const b = field.sdfBytes[idxOf(ix, iy, iz)];
    // int8 stored as unorm byte: value = (b - 128) / 127 * range
    return (((b << 24) >> 24) / 127) * range;
  };

  const territoryByIndex = new Float32Array(256);
  for (const r of field.regions) {
    if (r.index < 256) territoryByIndex[r.index] = territoryOf(r.fsLabel);
  }

  // ---- attractors ---------------------------------------------------------
  // Scattered through the cortical band: just inside the pial surface, where
  // the leptomeningeal arteries actually run before diving in.
  const attractors: Attractor[] = [];
  let guard = 0;
  while (attractors.length < attractorCount && guard < attractorCount * 60) {
    guard++;
    const ix = (rnd() * dim) | 0;
    const iy = (rnd() * dim) | 0;
    const iz = (rnd() * dim) | 0;
    const d = distAt(ix, iy, iz);
    if (d > -1.5 || d < -12) continue;
    const terr = territoryByIndex[field.labelBytes[idxOf(ix, iy, iz)]];
    if (!terr) continue;
    attractors.push({
      x: ix - half,
      y: iy - half,
      z: iz - half,
      territory: terr,
      dead: false,
    });
  }

  // ---- seed the trunks ----------------------------------------------------
  //
  // The authored paths stop at the skull base, which is where these arteries
  // really are — but that leaves every tip tens of millimetres from the cortex
  // it supplies, outside the influence radius, so nothing grows at all. Rather
  // than author more coordinates (or inflate the influence radius until the
  // trees interpenetrate), each trunk is extended toward the CENTROID OF ITS
  // OWN ATTRACTORS. The proximal course stays hand-placed; the reach into the
  // territory is derived from where that territory actually is.
  const centroids = new Map<number, { x: number; y: number; z: number; n: number }>();
  for (const a of attractors) {
    const c = centroids.get(a.territory);
    if (c) {
      c.x += a.x;
      c.y += a.y;
      c.z += a.z;
      c.n++;
    } else {
      centroids.set(a.territory, { x: a.x, y: a.y, z: a.z, n: 1 });
    }
  }

  const nodes: VesselNode[] = [];
  const rootNodes: number[] = [];

  TRUNKS.forEach((trunk, ti) => {
    let parent = -1;
    for (const [x, y, z] of trunk.path) {
      nodes.push({ x, y, z, parent, territory: trunk.territory, radius: 0, root: ti });
      parent = nodes.length - 1;
    }
    rootNodes.push(nodes.length - trunk.path.length);

    // Approach the territory, staying on the correct side of the midline so a
    // left trunk never reaches across to right-hemisphere attractors.
    const c = centroids.get(trunk.territory);
    const last = nodes[parent];
    if (c && c.n > 0) {
      const side = Math.sign(last.x) || 1;
      const tx = (Math.abs(c.x / c.n) || 0) * side;
      const ty = c.y / c.n;
      const tz = c.z / c.n;
      const steps = 4;
      for (let s = 1; s <= steps; s++) {
        const f = (s / (steps + 1)) * 0.85;
        nodes.push({
          x: last.x + (tx - last.x) * f,
          y: last.y + (ty - last.y) * f,
          z: last.z + (tz - last.z) * f,
          parent,
          territory: trunk.territory,
          radius: 0,
          root: ti,
        });
        parent = nodes.length - 1;
      }
    }
  });

  // ---- grow ---------------------------------------------------------------
  //
  // Attractors are bucketed by (territory, side) once, and each trunk only ever
  // scans its own bucket. Scanning all attractors for every trunk made the
  // build take four seconds; this makes the inner loop proportional to the
  // territory a trunk actually supplies.
  const bucketKey = (terr: number, side: number) => terr * 4 + (side + 1);
  const buckets = new Map<number, Attractor[]>();
  for (const a of attractors) {
    const k = bucketKey(a.territory, Math.sign(a.x) || 1);
    const b = buckets.get(k);
    if (b) b.push(a);
    else buckets.set(k, [a]);
  }
  const trunkBucket = TRUNKS.map((t, ti) => {
    const side = Math.sign(nodes[rootNodes[ti]].x) || 1;
    // Midline trunks (basilar) take both sides.
    if (Math.abs(nodes[rootNodes[ti]].x) < 1) {
      return [
        ...(buckets.get(bucketKey(t.territory, 1)) ?? []),
        ...(buckets.get(bucketKey(t.territory, -1)) ?? []),
      ];
    }
    return buckets.get(bucketKey(t.territory, side)) ?? [];
  });

  const inf2 = influenceMm * influenceMm;
  const kill2 = killMm * killMm;
  let alive = attractors.length;

  // Coarse spatial hash of every node in the tree.
  //
  // Attractors must attach to the nearest node ANYWHERE in the tree, not just
  // to the current tips. Restricting the search to tips gives each trunk
  // exactly one growing end forever, so it extrudes a single strand and never
  // branches — which is precisely what the first version produced. Branching is
  // an emergent consequence of different attractors claiming different interior
  // nodes.
  //
  // The tree only ever gains nodes, so the hash is built once and appended to.
  // Rebuilding it each iteration was ~5 s of the build for no benefit.
  // The key folds in the trunk index, because an attractor may only ever attach
  // to the tree that supplies its own territory — sharing cells between trunks
  // just means scanning nodes that are then rejected.
  const cell = influenceMm;
  const grid = new Map<number, number[]>();
  const cellKey = (x: number, y: number, z: number, root: number) =>
    (((Math.floor(x / cell) + 512) * 1024 + (Math.floor(y / cell) + 512)) * 1024 +
      (Math.floor(z / cell) + 512)) *
      32 +
    root;
  const index = (i: number) => {
    const n = nodes[i];
    const k = cellKey(n.x, n.y, n.z, n.root);
    const b = grid.get(k);
    if (b) b.push(i);
    else grid.set(k, [i]);
  };
  for (let i = 0; i < nodes.length; i++) index(i);

  // An artery bifurcates; it does not fan. Without a cap the trunk root stays
  // the nearest node for attractors on every side of it and accumulates
  // hundreds of children — measured 211 — which draws as a star of straight
  // strands rather than a tree. Closing a node at two children forces the next
  // attractor to attach further out, which is what makes the tree recursive.
  // Murray's law is stated for bifurcations, so this also makes the radii mean
  // what they claim to.
  const MAX_CHILDREN = 2;
  const childCount = new Uint8Array(nodes.length + maxIterations * 64);
  const close = (i: number) => {
    const n = nodes[i];
    const b = grid.get(cellKey(n.x, n.y, n.z, n.root));
    if (!b) return;
    const at = b.indexOf(i);
    if (at >= 0) b.splice(at, 1);
  };

  for (let iter = 0; iter < maxIterations && alive > 0; iter++) {
    // Per-node accumulated pull direction.
    const pull = new Map<number, { x: number; y: number; z: number; n: number }>();

    for (let ti = 0; ti < TRUNKS.length; ti++) {
      // Compact dead attractors out rather than skipping them: by the end of
      // the run most of the bucket is dead and re-walking it dominates.
      const bucket = trunkBucket[ti];
      let write = 0;
      for (let ri = 0; ri < bucket.length; ri++) {
        if (!bucket[ri].dead) bucket[write++] = bucket[ri];
      }
      bucket.length = write;

      for (const a of bucket) {
        let best = -1;
        let bestD = inf2;
        const cx = Math.floor(a.x / cell);
        const cy = Math.floor(a.y / cell);
        const cz = Math.floor(a.z / cell);
        for (let dz = -1; dz <= 1; dz++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const b = grid.get(
                ((((cx + dx + 512) * 1024 + (cy + dy + 512)) * 1024 + (cz + dz + 512)) *
                  32 +
                  ti)
              );
              if (!b) continue;
              for (const t of b) {
                const n = nodes[t];
                const ex = a.x - n.x;
                const ey = a.y - n.y;
                const ez = a.z - n.z;
                const d2 = ex * ex + ey * ey + ez * ez;
                if (d2 < bestD) {
                  bestD = d2;
                  best = t;
                }
              }
            }
          }
        }
        if (best < 0) continue;
        if (bestD < kill2) {
          a.dead = true;
          alive--;
          continue;
        }
        const n = nodes[best];
        let dx = a.x - n.x;
        let dy = a.y - n.y;
        let dz = a.z - n.z;
        const len = Math.hypot(dx, dy, dz) || 1;
        dx /= len;
        dy /= len;
        dz /= len;
        const p = pull.get(best);
        if (p) {
          p.x += dx;
          p.y += dy;
          p.z += dz;
          p.n++;
        } else {
          pull.set(best, { x: dx, y: dy, z: dz, n: 1 });
        }
      }
    }

    if (pull.size === 0) break;

    for (const [nodeIdx, p] of pull) {
      const n = nodes[nodeIdx];
      const len = Math.hypot(p.x, p.y, p.z) || 1;
      nodes.push({
        x: n.x + (p.x / len) * stepMm,
        y: n.y + (p.y / len) * stepMm,
        z: n.z + (p.z / len) * stepMm,
        parent: nodeIdx,
        territory: n.territory,
        radius: 0,
        root: n.root,
      });
      index(nodes.length - 1);
      if (++childCount[nodeIdx] >= MAX_CHILDREN) close(nodeIdx);
    }
  }

  // ---- radii, by Murray's law --------------------------------------------
  // r_parent^3 = sum(r_child^3): the relation that minimises the combined cost
  // of pumping blood and maintaining it. Applying it bottom-up gives trunks
  // that thicken realistically toward the Circle of Willis rather than by an
  // arbitrary depth ramp.
  const cube = new Float64Array(nodes.length);
  const leafR = 0.22;
  const children = new Int32Array(nodes.length);
  for (const n of nodes) if (n.parent >= 0) children[n.parent]++;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (children[i] === 0) cube[i] += leafR ** 3;
    const p = nodes[i].parent;
    if (p >= 0) cube[p] += cube[i];
  }
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].radius = Math.min(Math.cbrt(cube[i]), 2.6);
  }

  return {
    nodes,
    rootNodes,
    trunks: TRUNKS,
    buildMs: performance.now() - t0,
    attractorsUsed: attractors.length - alive,
  };
}
