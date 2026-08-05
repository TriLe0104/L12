/** Turns an uploaded model file into a three.js object, one format at a time.
 *
 *  Nothing in here is reachable from a page's own bundle: `ModelCanvas` is the
 *  only importer and it is pulled in with `next/dynamic`, and each format's
 *  loader is behind its own `await import()` inside the switch below. Opening an
 *  OBJ therefore downloads three.js plus OBJLoader and nothing else — the 7.4 MB
 *  OpenCascade payload only moves when someone opens a STEP file.
 *
 *  The server stores what was uploaded byte for byte, so every bit of CAD
 *  translation happens right here in the browser. */

import * as THREE from "three";

import type { ModelFormat } from "./model-format";

/** Neutral shop-grey, used wherever a file gives us no usable colour. */
const DEFAULT_COLOR = 0xb9c2cb;

export type LoadPhase = "downloading" | "translating" | "building";

export interface LoadProgress {
  phase: LoadPhase;
  /** 0..1 while the bytes are coming down; undefined once we're parsing */
  ratio?: number;
}

export interface LoadedModel {
  object: THREE.Object3D;
  triangles: number;
  vertices: number;
  /** external texture references the upload did not include */
  missingTextures: number;
}

/* ------------------------------------------------------------------ fetch -- */

async function fetchBytes(
  url: string,
  onProgress: (p: LoadProgress) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the model (HTTP ${res.status})`);

  const total = Number(res.headers.get("content-length") ?? 0);
  if (!res.body || !total) {
    onProgress({ phase: "downloading" });
    return res.arrayBuffer();
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress({ phase: "downloading", ratio: Math.min(1, received / total) });
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}

/* ------------------------------------------------- external texture stand-in */

let placeholderUrl: string | null = null;

/** A 1x1 white pixel. Standing every unresolvable texture reference on this is
 *  what keeps an FBX whose .tga files were never uploaded from either throwing
 *  or rendering as a black silhouette: white multiplies out of the base colour,
 *  and the map is stripped again in `tidyMaterial` once we know it was a stub. */
function texturePlaceholder(): string {
  if (placeholderUrl) return placeholderUrl;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 1, 1);
  }
  placeholderUrl = canvas.toDataURL("image/png");
  return placeholderUrl;
}

/** A manager that answers every external file request with the stub above, and
 *  counts how many there were so the viewer can say so out loud. */
function stubbingManager(): { manager: THREE.LoadingManager; missing: () => number } {
  const stub = texturePlaceholder();
  let missing = 0;
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    // embedded FBX textures arrive already inlined as data: URIs — leave those be
    if (url.startsWith("data:") || url.startsWith("blob:")) return url;
    missing += 1;
    return stub;
  });
  return { manager, missing: () => missing };
}

const MAP_SLOTS = [
  "map",
  "normalMap",
  "bumpMap",
  "specularMap",
  "roughnessMap",
  "metalnessMap",
  "emissiveMap",
  "aoMap",
] as const;

type MaterialLike = THREE.Material & Record<string, unknown>;

/** Make one material presentable: drop stub textures, rescue a black diffuse,
 *  and render both faces (CAD tessellation and hand-made OBJ alike ship
 *  inconsistent winding, which otherwise punches holes through a closed part). */
function tidyMaterial(material: THREE.Material, stub: string): void {
  const m = material as MaterialLike;
  m.side = THREE.DoubleSide;

  for (const slot of MAP_SLOTS) {
    const texture = m[slot] as THREE.Texture | null | undefined;
    const source = texture?.image as { src?: string } | undefined;
    if (texture && source?.src === stub) {
      texture.dispose();
      m[slot] = null;
    }
  }

  /* Two ways a file says "I have no material information", both of which read
     badly: a black diffuse renders as a silhouette, and the loaders' own default
     pure white blows out to a featureless blob. Either becomes shop grey, which
     shows shading. A file that actually specifies a colour keeps it. */
  const color = m.color as THREE.Color | undefined;
  if (color && !m.map) {
    const luminance = color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
    const isPureWhite = color.r === 1 && color.g === 1 && color.b === 1;
    if (luminance < 0.02 || isPureWhite) color.setHex(DEFAULT_COLOR);
  }
  m.needsUpdate = true;
}

/** Walk the loaded tree: tidy every material, fill in missing normals so lighting
 *  has something to work with, and tally the geometry actually present. */
function finalise(object: THREE.Object3D, missingTextures: number): LoadedModel {
  const stub = placeholderUrl ?? "";
  let triangles = 0;
  let vertices = 0;

  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;

    const geometry = mesh.geometry as THREE.BufferGeometry;
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();

    const position = geometry.getAttribute("position");
    if (position) {
      vertices += position.count;
      triangles += (geometry.getIndex()?.count ?? position.count) / 3;
    }

    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (material) tidyMaterial(material, stub);
    }
  });

  return { object, triangles: Math.round(triangles), vertices, missingTextures };
}

/* -------------------------------------------------------------- OpenCascade */

interface OcctMesh {
  name?: string;
  color?: [number, number, number];
  attributes: {
    position: { array: ArrayLike<number> };
    normal?: { array: ArrayLike<number> };
  };
  index?: { array: ArrayLike<number> };
}

interface OcctModule {
  ReadStepFile(content: Uint8Array, params: unknown): { success: boolean; meshes: OcctMesh[] };
}

type OcctFactory = (config?: Record<string, unknown>) => Promise<OcctModule>;

const OCCT_BASE = "/wasm/occt/";
let occtPending: Promise<OcctModule> | null = null;

/** The emscripten glue is injected as a plain <script> rather than imported.
 *  That keeps it (and the .wasm it then fetches from alongside itself) entirely
 *  outside webpack's graph, so no build configuration can accidentally pull
 *  OpenCascade into a chunk someone downloads without asking for a STEP file. */
function loadOcct(): Promise<OcctModule> {
  if (occtPending) return occtPending;

  occtPending = new Promise<OcctFactory>((resolve, reject) => {
    const existing = (window as unknown as { occtimportjs?: OcctFactory }).occtimportjs;
    if (existing) {
      resolve(existing);
      return;
    }
    const script = document.createElement("script");
    script.src = `${OCCT_BASE}occt-import-js.js`;
    script.async = true;
    script.onload = () => {
      const factory = (window as unknown as { occtimportjs?: OcctFactory }).occtimportjs;
      if (factory) resolve(factory);
      else reject(new Error("The STEP translator loaded but did not register itself"));
    };
    script.onerror = () => reject(new Error("Could not load the STEP translator"));
    document.head.appendChild(script);
  })
    .then((factory) => factory({ locateFile: (file: string) => `${OCCT_BASE}${file}` }))
    .catch((err) => {
      occtPending = null; // let a later attempt retry rather than cache the failure
      throw err;
    });

  return occtPending;
}

function buildStepScene(meshes: OcctMesh[]): THREE.Object3D {
  const group = new THREE.Group();
  group.name = "STEP";

  for (const mesh of meshes) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(Float32Array.from(mesh.attributes.position.array), 3),
    );
    if (mesh.attributes.normal) {
      geometry.setAttribute(
        "normal",
        new THREE.Float32BufferAttribute(Float32Array.from(mesh.attributes.normal.array), 3),
      );
    }
    if (mesh.index) {
      geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(mesh.index.array), 1));
    }

    /* OpenCascade reports STEP colours as sRGB triples. three's Color constructor
       reads three numbers as *linear*, which turns a mid tone into a fluorescent
       one, so the colour space has to be named explicitly. */
    const color = new THREE.Color(DEFAULT_COLOR);
    if (mesh.color) {
      color.setRGB(mesh.color[0], mesh.color[1], mesh.color[2], THREE.SRGBColorSpace);
    }

    group.add(
      new THREE.Mesh(
        geometry,
        new THREE.MeshPhongMaterial({ color, shininess: 24, specular: 0x2a3138 }),
      ),
    );
  }
  return group;
}

/* --------------------------------------------------------------- the switch */

export async function loadModel(
  url: string,
  format: ModelFormat,
  onProgress: (p: LoadProgress) => void,
): Promise<LoadedModel> {
  try {
    return await translate(url, format, onProgress);
  } catch (err) {
    /* Loader failures surface as raw library text ("Unknown property type A").
       Keep it — it is the only clue to what is wrong with the file — but say
       which file it is about, so the overlay reads as a sentence. */
    const because = err instanceof Error ? err.message : String(err);
    throw new Error(`This ${format.toUpperCase()} file could not be read. ${because}`);
  }
}

async function translate(
  url: string,
  format: ModelFormat,
  onProgress: (p: LoadProgress) => void,
): Promise<LoadedModel> {
  switch (format) {
    case "obj": {
      const buffer = await fetchBytes(url, onProgress);
      onProgress({ phase: "translating" });
      const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
      // No .mtl travels with the upload, so OBJLoader falls back to its own
      // default material for every group — which is exactly what we want.
      const text = new TextDecoder().decode(buffer);
      return finalise(new OBJLoader().parse(text), 0);
    }

    case "fbx": {
      const buffer = await fetchBytes(url, onProgress);
      onProgress({ phase: "translating" });
      const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
      const { manager, missing } = stubbingManager();
      const object = new FBXLoader(manager).parse(buffer, "");
      return finalise(object, missing());
    }

    case "step": {
      const [buffer, occt] = await Promise.all([
        fetchBytes(url, onProgress),
        loadOcct(),
      ]);
      onProgress({ phase: "translating" });
      // Yield a frame so the "Translating" label actually paints before the
      // synchronous OpenCascade tessellation takes over the main thread.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = occt.ReadStepFile(new Uint8Array(buffer), null);
      if (!result.success) throw new Error("OpenCascade could not read this STEP file");
      if (!result.meshes.length) throw new Error("This STEP file contains no solid geometry");
      onProgress({ phase: "building" });
      return finalise(buildStepScene(result.meshes), 0);
    }

    case "3dm": {
      onProgress({ phase: "downloading" });
      const { Rhino3dmLoader } = await import("three/examples/jsm/loaders/3DMLoader.js");
      const loader = new Rhino3dmLoader();
      // rhino3dm.js + rhino3dm.wasm are fetched from here at this moment, not
      // bundled; the loader assembles its own worker out of them.
      loader.setLibraryPath("/wasm/rhino3dm/");
      try {
        const object = await loader.loadAsync(url, (event) => {
          onProgress({
            phase: "downloading",
            ratio: event.total ? Math.min(1, event.loaded / event.total) : undefined,
          });
        });
        onProgress({ phase: "building" });
        return finalise(object, 0);
      } finally {
        loader.dispose();
      }
    }
  }
}

/** Release every geometry, material and texture hanging off a loaded model.
 *  Without this, opening and closing a few high-poly parts walks the GPU into
 *  dropping the context. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      const m = material as MaterialLike;
      for (const slot of MAP_SLOTS) {
        (m[slot] as THREE.Texture | null | undefined)?.dispose?.();
      }
      material.dispose();
    }
  });
  root.clear();
}
