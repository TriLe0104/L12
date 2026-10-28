"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { ClusterRack, PowerRack, Telemetry } from "@/lib/cluster";

const TILE = 1.15;
const RACK_W = 0.72;
const RACK_D = 1.08;
const RACK_H = 2.42;
const STENCIL_URL = "/racks/gb300-stencil-cutout.png?v=1";

export type ZoomLevel = "rack" | "hall" | "cluster";

export type CampusHall = {
  id: string;
  name: string;
  width_tiles: number;
  depth_tiles: number;
  racks: ClusterRack[];
  telemetry?: Telemetry;
};

type Props = {
  halls: CampusHall[];
  clusterName?: string;
  selectedIds: string[];
  focusHallId: string | null;
  placeMode: boolean;
  canEdit: boolean;
  powerByRack?: Record<string, PowerRack>;
  onSelect: (id: string | null, opts?: { additive?: boolean }) => void;
  onMove: (id: string, x: number, y: number) => void;
  onPlace: (hallId: string, x: number, y: number) => void;
  onViewChange: (view: { level: ZoomLevel; hallId: string | null; distance: number }) => void;
  onFocusHall: (hallId: string) => void;
  onSelectNet?: (sel: { id: string; role: string; hallId?: string }) => void;
};

const nameTexCache = new Map<string, THREE.CanvasTexture>();

type FloorTheme = "meow" | "scc";

const PALETTE = {
  meow: {
    bg: 0x070707,
    fog: 0x070707,
    fogNear: 70,
    fogFar: 220,
    hemiSky: 0x6a6a70,
    hemiGround: 0x101010,
    hemiInt: 1.05,
    keyInt: 1.45,
    fill: 0xe10600,
    fillInt: 0.22,
    exposure: 1.08,
    label: "#f5f5f5",
    floor: 0x0c0c0c,
    gridMajor: 0x2a2a2a,
    gridMinor: 0x161616,
    hallEdge: 0xe10600,
    accent: 0xe10600,
    capEmissive: 0xe10600,
    used: 0x2f9e4a,
    usedEmissive: 0x145c28,
    spare: 0x6a7074,
    leaf: 0x2a2a2a,
    spine: 0x1a1a1a,
    down: 0x5a5a5a,
    up: 0xe10600,
    core: 0x140808,
    leafEdge: 0x8a8a8a,
    ring: 0xe10600,
    ghost: 0xe10600,
    usedHot: 0xe10600,
    usedExtra: 0x4ade80,
    usedOk: 0x2f9e4a,
    capOff: 0x3a3a3a,
    capHot: 0xe10600,
    capExtra: 0x2f9e4a,
    capSel: 0xff3b30,
    capRun: 0xe10600,
    capIdle: 0x9a1a14,
    bodyOff: 0x121212,
    bodyDeny: 0x141414,
    bodySel: 0x333333,
    body: 0x1c1c1c,
  },
  scc: {
    bg: 0xeef2f7,
    fog: 0xe8eef6,
    fogNear: 90,
    fogFar: 260,
    hemiSky: 0xf8fafc,
    hemiGround: 0xcbd5e1,
    hemiInt: 1.22,
    keyInt: 1.12,
    fill: 0x1d4ed8,
    fillInt: 0.32,
    exposure: 1.0,
    label: "#1e293b",
    floor: 0xffffff,
    gridMajor: 0x93c5fd,
    gridMinor: 0xdbe3ee,
    hallEdge: 0x1d4ed8,
    accent: 0x1d4ed8,
    capEmissive: 0x1d4ed8,
    used: 0x16a34a,
    usedEmissive: 0x166534,
    spare: 0xcbd5e1,
    leaf: 0x64748b,
    spine: 0x1e3a8a,
    down: 0x64748b,
    up: 0x1d4ed8,
    core: 0xdbeafe,
    leafEdge: 0x94a3b8,
    ring: 0x1d4ed8,
    ghost: 0x1d4ed8,
    usedHot: 0xdc2626,
    usedExtra: 0x22c55e,
    usedOk: 0x16a34a,
    capOff: 0x94a3b8,
    capHot: 0xdc2626,
    capExtra: 0x16a34a,
    capSel: 0x2563eb,
    capRun: 0x1d4ed8,
    capIdle: 0x3b82f6,
    bodyOff: 0xcbd5e1,
    bodyDeny: 0xe2e8f0,
    bodySel: 0x1e3a8a,
    body: 0x1e293b,
  },
} as const;

type Palette = (typeof PALETTE)[FloorTheme];

function readFloorTheme(): FloorTheme {
  return document.documentElement.getAttribute("data-theme") === "scc" ? "scc" : "meow";
}

function shortRackName(name: string) {
  const m = name.match(/R\d+C\d+$/i);
  if (m) return m[0].toUpperCase();
  return name;
}

function tileToWorld(x: number, y: number, width: number, depth: number) {
  return {
    x: (x - (width - 1) / 2) * TILE,
    z: (y - (depth - 1) / 2) * TILE,
  };
}

function worldToTile(wx: number, wz: number, width: number, depth: number) {
  const x = Math.round(wx / TILE + (width - 1) / 2);
  const y = Math.round(wz / TILE + (depth - 1) / 2);
  return { x, y };
}

function campusPitch(halls: CampusHall[]) {
  const maxW = Math.max(8, ...halls.map((h) => h.width_tiles));
  const maxD = Math.max(8, ...halls.map((h) => h.depth_tiles));
  return Math.max(maxW, maxD) * TILE + 14;
}

function hallOrigin(index: number, pitch: number, count = 2) {
  if (count <= 1) return { x: 0, z: 0 };
  const col = index % 2;
  const row = Math.floor(index / 2);
  return { x: (col - 0.5) * pitch, z: (row - 0.5) * pitch };
}

function classify(distance: number, pitch: number): ZoomLevel {
  if (distance > pitch * 1.25) return "cluster";
  if (distance > 20) return "hall";
  return "rack";
}

function labelTexture(text: string, size = 42, fill = "#f5f5f5") {
  const key = `${fill}|${size}|${text}`;
  const hit = nameTexCache.get(key);
  if (hit) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 1024, 256);
  ctx.fillStyle = fill;
  ctx.font = `700 ${size}px Archivo, Segoe UI, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 512, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  nameTexCache.set(key, tex);
  return tex;
}

type Entry = {
  rack: ClusterRack;
  hallId: string;
  hallIndex: number;
  width: number;
  depth: number;
  barUsed: number;
  barSpare: number;
};

export function ClusterCanvas({
  halls,
  clusterName = "Firmus",
  selectedIds,
  focusHallId,
  placeMode,
  canEdit,
  powerByRack,
  onSelect,
  onMove,
  onPlace,
  onViewChange,
  onFocusHall,
  onSelectNet,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const clusterSpriteRef = useRef<THREE.Sprite | null>(null);
  const clusterNameRef = useRef(clusterName);
  clusterNameRef.current = clusterName;
  const hallsRef = useRef(halls);
  const selectedRef = useRef(selectedIds);
  const placeRef = useRef(placeMode);
  const editRef = useRef(canEdit);
  const focusRef = useRef(focusHallId);
  const powerRef = useRef(powerByRack);
  const onSelectRef = useRef(onSelect);
  const onMoveRef = useRef(onMove);
  const onPlaceRef = useRef(onPlace);
  const onViewRef = useRef(onViewChange);
  const onFocusHallRef = useRef(onFocusHall);
  const onSelectNetRef = useRef(onSelectNet);
  hallsRef.current = halls;
  selectedRef.current = selectedIds;
  placeRef.current = placeMode;
  editRef.current = canEdit;
  focusRef.current = focusHallId;
  powerRef.current = powerByRack;
  onSelectRef.current = onSelect;
  onMoveRef.current = onMove;
  onPlaceRef.current = onPlace;
  onViewRef.current = onViewChange;
  onFocusHallRef.current = onFocusHall;
  onSelectNetRef.current = onSelectNet;

  const rebuildRef = useRef<(() => void) | null>(null);
  const paintRef = useRef<(() => void) | null>(null);
  const flyToHallRef = useRef<((id: string) => void) | null>(null);
  const flyToClusterRef = useRef<(() => void) | null>(null);
  const skipFly = useRef(true);

  useEffect(() => {
    const sprite = clusterSpriteRef.current;
    if (!sprite) return;
    const pal = PALETTE[readFloorTheme()];
    const map = labelTexture((clusterName || "Cluster").toUpperCase(), 72, pal.label);
    sprite.material.map = map;
    sprite.material.needsUpdate = true;
  }, [clusterName]);

  useEffect(() => {
    rebuildRef.current?.();
  }, [halls]);

  useEffect(() => {
    paintRef.current?.();
  }, [selectedIds, powerByRack]);

  useEffect(() => {
    if (skipFly.current) {
      skipFly.current = false;
      return;
    }
    if (focusHallId) flyToHallRef.current?.(focusHallId);
    else flyToClusterRef.current?.();
  }, [focusHallId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let pal: Palette = PALETTE[readFloorTheme()];
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(pal.bg);
    scene.fog = new THREE.Fog(pal.fog, pal.fogNear, pal.fogFar);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    camera.position.set(2.4, 3.6, 5.8);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = pal.exposure;
    renderer.setClearColor(pal.bg);
    host.appendChild(renderer.domElement);

    const hemi = new THREE.HemisphereLight(pal.hemiSky, pal.hemiGround, pal.hemiInt);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, pal.keyInt);
    key.position.set(18, 30, 16);
    scene.add(key);
    const fill = new THREE.DirectionalLight(pal.fill, pal.fillInt);
    fill.position.set(-20, 8, 0);
    scene.add(fill);
    const face = new THREE.DirectionalLight(0xffffff, 0.95);
    face.position.set(2.2, 4.4, 7.5);
    scene.add(face);

    const floors = new THREE.Group();
    const labels = new THREE.Group();
    const rackNames = new THREE.Group();
    const racks = new THREE.Group();
    const net = new THREE.Group();
    scene.add(floors);
    scene.add(labels);
    scene.add(rackNames);
    scene.add(racks);
    scene.add(net);

    const chassisMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0a,
      metalness: 0.06,
      roughness: 0.86,
    });
    const frontMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      alphaTest: 0.15,
      depthWrite: true,
    });
    const bodyGeo = new THREE.BoxGeometry(RACK_W * 0.9, RACK_H * 0.94, RACK_D);
    const faceGeo = new THREE.PlaneGeometry(RACK_W, RACK_H);
    new THREE.TextureLoader().load(STENCIL_URL, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      tex.premultiplyAlpha = false;
      frontMat.map = tex;
      frontMat.needsUpdate = true;
    });

    let entries: Entry[] = [];
    let pitch = 28;
    let framed = false;

    const ring = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(RACK_W + 0.08, RACK_H + 0.08, RACK_D + 0.08)),
      new THREE.LineBasicMaterial({ color: pal.ring }),
    );
    ring.visible = false;
    scene.add(ring);

    const clusterSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: labelTexture((clusterNameRef.current || "Cluster").toUpperCase(), 72, pal.label),
        transparent: true,
        depthTest: false,
      }),
    );
    clusterSprite.scale.set(22, 5.5, 1);
    clusterSprite.position.set(0, 18.5, 0);
    clusterSpriteRef.current = clusterSprite;
    scene.add(clusterSprite);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.06;
    controls.minDistance = 2.4;
    controls.maxDistance = 80;
    controls.target.set(0, 1.0, 0);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    type Fly = { t: number; dur: number; fromP: THREE.Vector3; toP: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3 };
    let fly: Fly | null = null;

    const worldOf = (entry: Entry) => {
      const origin = hallOrigin(entry.hallIndex, pitch, hallsRef.current.length);
      const local = tileToWorld(entry.rack.x, entry.rack.y, entry.width, entry.depth);
      return { x: origin.x + local.x, z: origin.z + local.z };
    };

    const disposeRacks = () => {
      while (racks.children.length) {
        racks.remove(racks.children[0]);
      }
    };

    const frameRacks = () => {
      if (!entries.length) {
        camera.position.set(2.4, 3.6, 5.8);
        controls.target.set(0, 1.0, 0);
        return;
      }
      const p = worldOf(entries[0]);
      if (entries.length === 1) {
        camera.position.set(p.x + 2.15, 3.35, p.z + 5.05);
        controls.target.set(p.x, RACK_H * 0.42, p.z);
      } else {
        camera.position.set(p.x + 1.4, 7.5, p.z + 11);
        controls.target.set(p.x, 0.7, p.z);
      }
    };

    const rebuild = () => {
      const hs = hallsRef.current;
      pitch = campusPitch(hs);
      entries = [];
      hs.forEach((hall, hallIndex) => {
        for (const rack of hall.racks) {
          entries.push({
            rack,
            hallId: hall.id,
            hallIndex,
            width: hall.width_tiles,
            depth: hall.depth_tiles,
            barUsed: 0,
            barSpare: 0,
          });
        }
      });

      floors.clear();
      labels.clear();
      hs.forEach((hall, hallIndex) => {
        const origin = hallOrigin(hallIndex, pitch, hs.length);
        const fw = hall.width_tiles * TILE;
        const fd = hall.depth_tiles * TILE;
        const floor = new THREE.Mesh(
          new THREE.PlaneGeometry(fw, fd),
          new THREE.MeshStandardMaterial({ color: pal.floor, metalness: 0.08, roughness: 0.9 }),
        );
        floor.rotation.x = -Math.PI / 2;
        floor.position.set(origin.x, 0, origin.z);
        floor.userData = { isFloor: true, hallId: hall.id };
        floors.add(floor);
        const grid = new THREE.GridHelper(Math.max(fw, fd), Math.max(hall.width_tiles, hall.depth_tiles), pal.gridMajor, pal.gridMinor);
        grid.position.set(origin.x, 0.01, origin.z);
        floors.add(grid);
        const edge = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(fw, 0.02, fd)),
          new THREE.LineBasicMaterial({ color: pal.hallEdge, transparent: true, opacity: 0.55 }),
        );
        edge.position.set(origin.x, 0.02, origin.z);
        floors.add(edge);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(hall.name, 48, pal.label), transparent: true, depthTest: false }));
        sprite.position.set(origin.x, 3.15, origin.z);
        sprite.scale.set(5.4, 1.35, 1);
        sprite.userData = { isHallLabel: true, hallId: hall.id };
        labels.add(sprite);
      });

      rackNames.clear();
      entries.forEach((entry) => {
        const tag = shortRackName(entry.rack.name);
        const tex = labelTexture(tag, 54, pal.label);
        const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
        const pos = worldOf(entry);
        spr.position.set(pos.x, RACK_H + 0.48, pos.z);
        const nameW = Math.min(5.2, Math.max(2.6, tag.length * 0.32));
        spr.scale.set(nameW, 0.7, 1);
        spr.userData = { isRackName: true, nameW };
        rackNames.add(spr);
      });

      disposeRacks();
      net.clear();
      entries.forEach((entry, i) => {
        const g = new THREE.Group();
        g.userData = { isRack: true, entryIndex: i, rackId: entry.rack.id };
        const body = new THREE.Mesh(bodyGeo, chassisMat);
        const face = new THREE.Mesh(faceGeo, frontMat);
        face.position.z = RACK_D / 2 + 0.004;
        g.add(body);
        g.add(face);
        racks.add(g);
      });
      paint();
      if (!framed) {
        frameRacks();
        framed = true;
      }
    };

    const paint = () => {
      const selected = new Set(selectedRef.current);
      let ringOn = false;
      entries.forEach((entry, i) => {
        const mesh = racks.children[i];
        if (!mesh) return;
        const pos = worldOf(entry);
        const yaw = THREE.MathUtils.degToRad(entry.rack.rotation);
        mesh.position.set(pos.x, RACK_H / 2, pos.z);
        mesh.rotation.set(0, yaw, 0);
        mesh.userData.entryIndex = i;
        const isSel = selected.has(entry.rack.id);
        if (isSel && selected.size === 1) {
          ring.position.set(pos.x, RACK_H / 2, pos.z);
          ring.rotation.y = yaw;
          ring.visible = true;
          ringOn = true;
        }
      });
      if (!ringOn) ring.visible = false;
    };

    const paintBars = () => {
      /* power fill lives on the stencil panel after a rack click */
    };

    const applyPalette = (next: Palette) => {
      pal = next;
      scene.background = new THREE.Color(pal.bg);
      scene.fog = new THREE.Fog(pal.fog, pal.fogNear, pal.fogFar);
      renderer.setClearColor(pal.bg);
      renderer.toneMappingExposure = pal.exposure;
      hemi.color.setHex(pal.hemiSky);
      hemi.groundColor.setHex(pal.hemiGround);
      hemi.intensity = pal.hemiInt;
      key.intensity = pal.keyInt;
      fill.color.setHex(pal.fill);
      fill.intensity = pal.fillInt;
      (ring.material as THREE.LineBasicMaterial).color.setHex(pal.ring);
      (ghost.material as THREE.MeshBasicMaterial).color.setHex(pal.ghost);
      const map = labelTexture((clusterNameRef.current || "Cluster").toUpperCase(), 72, pal.label);
      clusterSprite.material.map = map;
      clusterSprite.material.needsUpdate = true;
    };

    rebuildRef.current = rebuild;
    paintRef.current = paint;
    rebuild();

    const themeWatch = new MutationObserver(() => {
      const next = PALETTE[readFloorTheme()];
      if (next === pal) return;
      applyPalette(next);
      rebuild();
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const setPointer = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    };

    const netFrom = (obj: THREE.Object3D, point: THREE.Vector3) => {
      let o: THREE.Object3D | null = obj;
      while (o) {
        if (o.userData.netId) {
          return {
            kind: "net" as const,
            netId: o.userData.netId as string,
            netRole: (o.userData.netRole as string) || "switch",
            hallId: o.userData.hallId as string | undefined,
            point,
          };
        }
        o = o.parent;
      }
      return null;
    };

    const hit = (event: PointerEvent) => {
      setPointer(event);
      raycaster.setFromCamera(pointer, camera);
      const rackHits = raycaster.intersectObjects(racks.children, true);
      for (const h of rackHits) {
        let o: THREE.Object3D | null = h.object;
        while (o) {
          if (o.userData.isRack) {
            const idx = Number(o.userData.entryIndex);
            if (entries[idx]) return { kind: "rack" as const, entry: entries[idx], point: h.point };
          }
          o = o.parent;
        }
      }
      const netHits = raycaster.intersectObjects(net.children, true);
      for (const h of netHits) {
        const found = netFrom(h.object, h.point);
        if (found) return found;
      }
      const hits = raycaster.intersectObjects([...floors.children, ...labels.children], false);
      for (const h of hits) {
        if (h.object.userData.isHallLabel && h.object.userData.hallId) {
          return { kind: "hall" as const, hallId: h.object.userData.hallId as string, point: h.point };
        }
        if (h.object.userData.isFloor) {
          return { kind: "floor" as const, hallId: h.object.userData.hallId as string, point: h.point };
        }
      }
      return null;
    };

    const tileOnHall = (hallId: string, point: THREE.Vector3) => {
      const hs = hallsRef.current;
      const idx = hs.findIndex((h) => h.id === hallId);
      if (idx < 0) return null;
      const hall = hs[idx];
      const origin = hallOrigin(idx, pitch, hs.length);
      const tile = worldToTile(point.x - origin.x, point.z - origin.z, hall.width_tiles, hall.depth_tiles);
      if (tile.x < 0 || tile.y < 0 || tile.x >= hall.width_tiles || tile.y >= hall.depth_tiles) return null;
      return tile;
    };

    const occupied = (hallId: string) =>
      new Set(
        hallsRef.current.find((h) => h.id === hallId)?.racks.map((r) => `${r.x},${r.y}`) ?? [],
      );

    const flyToHall = (hallId: string) => {
      const hs = hallsRef.current;
      const idx = hs.findIndex((h) => h.id === hallId);
      if (idx < 0) return;
      const origin = hallOrigin(idx, pitch, hs.length);
      const hall = hs[idx];
      const close = hall.racks.length <= 2;
      fly = {
        t: 0,
        dur: 0.7,
        fromP: camera.position.clone(),
        toP: new THREE.Vector3(origin.x + (close ? 2.1 : 1.2), close ? 3.5 : 8, origin.z + (close ? 5.1 : 12)),
        fromT: controls.target.clone(),
        toT: new THREE.Vector3(origin.x, close ? RACK_H * 0.42 : 0.6, origin.z),
      };
    };
    flyToHallRef.current = flyToHall;
    flyToClusterRef.current = () => {
      frameRacks();
    };

    let dragIndex: number | null = null;
    let dragMoved = false;
    let startX = 0;
    let startY = 0;
    const ghost = new THREE.Mesh(
      new THREE.BoxGeometry(RACK_W, 0.04, RACK_D),
      new THREE.MeshBasicMaterial({ color: pal.ghost, transparent: true, opacity: 0.45 }),
    );
    ghost.visible = false;
    scene.add(ghost);

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      startX = event.clientX;
      startY = event.clientY;
      dragMoved = false;
      dragIndex = null;
      if (placeRef.current) return;
      const found = hit(event);
      if (found?.kind === "rack" && editRef.current && classify(controls.getDistance(), pitch) === "rack") {
        dragIndex = entries.findIndex((e) => e.rack.id === found.entry.rack.id);
        controls.enabled = false;
        host.setPointerCapture(event.pointerId);
      }
    };

    const onMove = (event: PointerEvent) => {
      if (placeRef.current) {
        host.style.cursor = "crosshair";
        const found = hit(event);
        if (found?.kind === "floor") {
          const tile = tileOnHall(found.hallId, found.point);
          if (tile && !occupied(found.hallId).has(`${tile.x},${tile.y}`)) {
            const hs = hallsRef.current;
            const idx = hs.findIndex((h) => h.id === found.hallId);
            const origin = hallOrigin(idx, pitch, hs.length);
            const local = tileToWorld(tile.x, tile.y, hs[idx].width_tiles, hs[idx].depth_tiles);
            ghost.visible = true;
            ghost.position.set(origin.x + local.x, 0.03, origin.z + local.z);
            return;
          }
        }
        ghost.visible = false;
        return;
      }
      ghost.visible = false;
      if (dragIndex == null) {
        const hovered = hit(event);
        host.style.cursor = hovered?.kind === "rack" || hovered?.kind === "net" ? "pointer" : "grab";
        return;
      }
      if (!dragMoved && Math.hypot(event.clientX - startX, event.clientY - startY) > 5) dragMoved = true;
      if (!dragMoved) return;
      const found = hit(event);
      const entry = entries[dragIndex];
      const mesh = racks.children[dragIndex];
      if (found?.kind === "floor" && found.hallId === entry.hallId && mesh) {
        const tile = tileOnHall(entry.hallId, found.point);
        if (!tile) return;
        const origin = hallOrigin(entry.hallIndex, pitch, hallsRef.current.length);
        const local = tileToWorld(tile.x, tile.y, entry.width, entry.depth);
        mesh.position.set(origin.x + local.x, RACK_H / 2, origin.z + local.z);
        mesh.rotation.set(0, THREE.MathUtils.degToRad(entry.rack.rotation), 0);
      }
    };

    const onUp = (event: PointerEvent) => {
      if (event.button !== 0 && event.type === "pointerup") return;
      controls.enabled = true;
      ghost.visible = false;
      const level = classify(controls.getDistance(), pitch);
      if (placeRef.current) {
        const found = hit(event);
        if (found?.kind === "floor") {
          const tile = tileOnHall(found.hallId, found.point);
          if (tile && !occupied(found.hallId).has(`${tile.x},${tile.y}`)) {
            onPlaceRef.current(found.hallId, tile.x, tile.y);
          }
        }
        dragIndex = null;
        dragMoved = false;
        return;
      }
      const found = hit(event);
      if (dragIndex != null && dragMoved) {
        const entry = entries[dragIndex];
        if (found?.kind === "floor" && found.hallId === entry.hallId) {
          const tile = tileOnHall(entry.hallId, found.point);
          if (tile) onMoveRef.current(entry.rack.id, tile.x, tile.y);
          else paint();
        } else paint();
      } else if (!dragMoved) {
        const additive = event.ctrlKey || event.metaKey || event.shiftKey;
        if (found?.kind === "rack") {
          onSelectRef.current(found.entry.rack.id, { additive });
        } else if (found?.kind === "hall") {
          onFocusHallRef.current(found.hallId);
        } else if (found?.kind === "net") {
          onSelectNetRef.current?.({ id: found.netId, role: found.netRole, hallId: found.hallId });
        } else if (found?.kind === "floor") {
          if (level === "rack" && !additive) onSelectRef.current(null);
          else onFocusHallRef.current(found.hallId);
        }
      }
      dragIndex = null;
      dragMoved = false;
    };

    const onLeave = () => {
      dragIndex = null;
      dragMoved = false;
      controls.enabled = true;
      ghost.visible = false;
    };

    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("pointerleave", onLeave);

    const resize = () => {
      const { clientWidth, clientHeight } = host;
      if (!clientWidth || !clientHeight) return;
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(clientWidth, clientHeight, false);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    let lastLevel: ZoomLevel | null = null;
    let lastHall: string | null = null;
    let raf = 0;
    const tick = () => {
      if (fly) {
        fly.t += 1 / 60;
        const k = Math.min(1, fly.t / fly.dur);
        const e = 1 - Math.pow(1 - k, 3);
        camera.position.lerpVectors(fly.fromP, fly.toP, e);
        controls.target.lerpVectors(fly.fromT, fly.toT, e);
        if (k >= 1) fly = null;
      }
      controls.update();
      const distance = controls.getDistance();
      const level = classify(distance, pitch);
      clusterSprite.visible = level === "cluster" && hallsRef.current.length > 1;
      labels.visible = level !== "rack";
      rackNames.visible = true;
      const nameScale = level === "rack" ? 1 : 0.78;
      rackNames.children.forEach((ch) => {
        const w = Number(ch.userData.nameW) || 3.2;
        ch.scale.set(w * nameScale, 0.7 * nameScale, 1);
      });
      net.visible = net.children.length > 0;
      const nearest = (() => {
        let bestId: string | null = null;
        let bestD = Infinity;
        const hallsNow = hallsRef.current;
        for (let i = 0; i < hallsNow.length; i++) {
          const o = hallOrigin(i, pitch, hallsNow.length);
          const d = Math.hypot(controls.target.x - o.x, controls.target.z - o.z);
          if (d < bestD) {
            bestD = d;
            bestId = hallsNow[i].id;
          }
        }
        return bestId;
      })();
      if (level !== lastLevel || nearest !== lastHall) {
        lastLevel = level;
        lastHall = nearest;
        onViewRef.current({ level, hallId: nearest, distance });
      }
      paintBars();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      themeWatch.disconnect();
      ro.disconnect();
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("pointerleave", onLeave);
      controls.dispose();
      disposeRacks();
      bodyGeo.dispose();
      faceGeo.dispose();
      chassisMat.dispose();
      frontMat.map?.dispose();
      frontMat.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      rebuildRef.current = null;
      paintRef.current = null;
      flyToHallRef.current = null;
      flyToClusterRef.current = null;
    };
  }, []);

  return <div ref={hostRef} className="cluster-canvas" data-place={placeMode} />;
}
