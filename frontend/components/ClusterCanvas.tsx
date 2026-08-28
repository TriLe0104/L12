"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { ClusterRack, Telemetry } from "@/lib/cluster";

const TILE = 1.15;
const RACK_W = 0.62;
const RACK_D = 1.02;
const RACK_H = 2.05;

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
  selectedIds: string[];
  focusHallId: string | null;
  placeMode: boolean;
  canEdit: boolean;
  onSelect: (id: string | null, opts?: { additive?: boolean }) => void;
  onMove: (id: string, x: number, y: number) => void;
  onPlace: (hallId: string, x: number, y: number) => void;
  onViewChange: (view: { level: ZoomLevel; hallId: string | null; distance: number }) => void;
  onFocusHall: (hallId: string) => void;
  onSelectNet?: (sel: { id: string; role: string; hallId?: string }) => void;
};

const nameTexCache = new Map<string, THREE.CanvasTexture>();

function shortRackName(name: string) {
  const m = name.match(/R\d+C\d+$/i);
  if (m) return m[0].toUpperCase();
  const parts = name.split("-");
  return parts[parts.length - 1] ?? name;
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

function hallOrigin(index: number, pitch: number) {
  const col = index % 2;
  const row = Math.floor(index / 2);
  return { x: (col - 0.5) * pitch, z: (row - 0.5) * pitch };
}

function classify(distance: number, pitch: number): ZoomLevel {
  if (distance > pitch * 1.25) return "cluster";
  if (distance > 20) return "hall";
  return "rack";
}

function labelTexture(text: string, size = 42) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 1024, 256);
  ctx.fillStyle = "#f5f5f5";
  ctx.font = `700 ${size}px Archivo, Segoe UI, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 512, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

type Entry = {
  rack: ClusterRack;
  hallId: string;
  hallIndex: number;
  width: number;
  depth: number;
};

function capColor(rack: ClusterRack, selected: boolean) {
  if (rack.power_state === "off") return new THREE.Color(0x3a3a3a);
  if (selected) return new THREE.Color(0xff3b30);
  if (rack.run_status === "running") return new THREE.Color(0xe10600);
  return new THREE.Color(0x9a1a14);
}

function bodyColor(rack: ClusterRack, selected: boolean) {
  if (rack.power_state === "off") return new THREE.Color(0x121212);
  if (selected) return new THREE.Color(0x333333);
  return new THREE.Color(0x1c1c1c);
}

export function ClusterCanvas({
  halls,
  selectedIds,
  focusHallId,
  placeMode,
  canEdit,
  onSelect,
  onMove,
  onPlace,
  onViewChange,
  onFocusHall,
  onSelectNet,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const hallsRef = useRef(halls);
  const selectedRef = useRef(selectedIds);
  const placeRef = useRef(placeMode);
  const editRef = useRef(canEdit);
  const focusRef = useRef(focusHallId);
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
    rebuildRef.current?.();
  }, [halls]);

  useEffect(() => {
    paintRef.current?.();
  }, [selectedIds]);

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

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070707);
    scene.fog = new THREE.Fog(0x070707, 70, 220);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    camera.position.set(0, 58, 86);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    host.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0x6a6a70, 0x101010, 1.05));
    const key = new THREE.DirectionalLight(0xffffff, 1.45);
    key.position.set(18, 30, 16);
    scene.add(key);
    scene.add(new THREE.DirectionalLight(0xe10600, 0.22).translateX(-20).translateY(8));

    const floors = new THREE.Group();
    const labels = new THREE.Group();
    const rackNames = new THREE.Group();
    const net = new THREE.Group();
    const netDown = new THREE.Group();
    const netUp = new THREE.Group();
    net.add(netDown);
    net.add(netUp);
    scene.add(floors);
    scene.add(labels);
    scene.add(rackNames);
    scene.add(net);

    const bodyGeo = new THREE.BoxGeometry(RACK_W, RACK_H, RACK_D);
    const capGeo = new THREE.BoxGeometry(RACK_W * 0.98, 0.04, RACK_D * 0.98);
    const bodyMat = new THREE.MeshStandardMaterial({ metalness: 0.5, roughness: 0.45 });
    const capMat = new THREE.MeshStandardMaterial({ metalness: 0.3, roughness: 0.4, emissive: 0xe10600, emissiveIntensity: 0.28 });
    let bodyMesh: THREE.InstancedMesh | null = null;
    let capMesh: THREE.InstancedMesh | null = null;

    const dummy = new THREE.Object3D();
    let entries: Entry[] = [];
    let pitch = 28;

    const ring = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(RACK_W + 0.08, RACK_H + 0.08, RACK_D + 0.08)),
      new THREE.LineBasicMaterial({ color: 0xe10600 }),
    );
    ring.visible = false;
    scene.add(ring);

    const clusterSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture("FIRMUS", 72), transparent: true, depthTest: false }));
    clusterSprite.scale.set(22, 5.5, 1);
    clusterSprite.position.set(0, 18.5, 0);
    scene.add(clusterSprite);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.06;
    controls.minDistance = 6;
    controls.maxDistance = 220;
    controls.target.set(0, 0.6, 0);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    type Fly = { t: number; dur: number; fromP: THREE.Vector3; toP: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3 };
    let fly: Fly | null = null;

    const worldOf = (entry: Entry) => {
      const origin = hallOrigin(entry.hallIndex, pitch);
      const local = tileToWorld(entry.rack.x, entry.rack.y, entry.width, entry.depth);
      return { x: origin.x + local.x, z: origin.z + local.z };
    };

    const disposeInstanced = () => {
      bodyMesh?.dispose();
      capMesh?.dispose();
      if (bodyMesh) scene.remove(bodyMesh);
      if (capMesh) scene.remove(capMesh);
      bodyMesh = null;
      capMesh = null;
    };

    const rebuild = () => {
      const hs = hallsRef.current;
      pitch = campusPitch(hs);
      entries = [];
      hs.forEach((hall, hallIndex) => {
        for (const rack of hall.racks) {
          entries.push({ rack, hallId: hall.id, hallIndex, width: hall.width_tiles, depth: hall.depth_tiles });
        }
      });

      floors.clear();
      labels.clear();
      hs.forEach((hall, hallIndex) => {
        const origin = hallOrigin(hallIndex, pitch);
        const fw = hall.width_tiles * TILE;
        const fd = hall.depth_tiles * TILE;
        const floor = new THREE.Mesh(
          new THREE.PlaneGeometry(fw, fd),
          new THREE.MeshStandardMaterial({ color: 0x0c0c0c, metalness: 0.12, roughness: 0.88 }),
        );
        floor.rotation.x = -Math.PI / 2;
        floor.position.set(origin.x, 0, origin.z);
        floor.userData = { isFloor: true, hallId: hall.id };
        floors.add(floor);
        const grid = new THREE.GridHelper(Math.max(fw, fd), Math.max(hall.width_tiles, hall.depth_tiles), 0x2a2a2a, 0x161616);
        grid.position.set(origin.x, 0.01, origin.z);
        floors.add(grid);
        const edge = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(fw, 0.02, fd)),
          new THREE.LineBasicMaterial({ color: 0xe10600, transparent: true, opacity: 0.55 }),
        );
        edge.position.set(origin.x, 0.02, origin.z);
        floors.add(edge);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(hall.name, 48), transparent: true, depthTest: false }));
        sprite.position.set(origin.x, 6.2, origin.z);
        sprite.scale.set(12, 3, 1);
        sprite.userData = { isHallLabel: true, hallId: hall.id };
        labels.add(sprite);
      });

      rackNames.clear();
      entries.forEach((entry) => {
        const tag = shortRackName(entry.rack.name);
        let tex = nameTexCache.get(tag);
        if (!tex) {
          tex = labelTexture(tag, 54);
          nameTexCache.set(tag, tex);
        }
        const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
        const pos = worldOf(entry);
        spr.position.set(pos.x, RACK_H + 0.42, pos.z);
        spr.scale.set(2.4, 0.62, 1);
        spr.userData = { isRackName: true };
        rackNames.add(spr);
      });

      disposeInstanced();
      const count = Math.max(entries.length, 1);
      bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, count);
      capMesh = new THREE.InstancedMesh(capGeo, capMat, count);
      bodyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      capMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (count > 0) {
        bodyMesh.frustumCulled = false;
        capMesh.frustumCulled = false;
      }
      scene.add(bodyMesh);
      scene.add(capMesh);
      buildNetwork(hs, pitch);
      paint();
    };

    const buildNetwork = (hs: CampusHall[], pitchNow: number) => {
      for (let i = net.children.length - 1; i >= 0; i--) {
        const ch = net.children[i];
        if (ch === netDown || ch === netUp) continue;
        net.remove(ch);
      }
      netDown.clear();
      netUp.clear();

      const leafMat = new THREE.MeshStandardMaterial({
        color: 0x2a2a2a,
        metalness: 0.6,
        roughness: 0.35,
        emissive: 0xe10600,
        emissiveIntensity: 0.12,
      });
      const spineMat = new THREE.MeshStandardMaterial({
        color: 0x1a1a1a,
        metalness: 0.7,
        roughness: 0.28,
        emissive: 0xe10600,
        emissiveIntensity: 0.35,
      });
      const downMat = new THREE.LineBasicMaterial({ color: 0x5a5a5a, transparent: true, opacity: 0.55 });
      const upMat = new THREE.LineBasicMaterial({ color: 0xe10600, transparent: true, opacity: 0.35 });

      const core = new THREE.Mesh(
        new THREE.BoxGeometry(15.2, 0.16, 10.2),
        new THREE.MeshStandardMaterial({
          color: 0x140808,
          metalness: 0.45,
          roughness: 0.55,
          emissive: 0xe10600,
          emissiveIntensity: 0.1,
        }),
      );
      core.position.set(0, 8.35, 0);
      core.userData = { netId: "SP-01", netRole: "spine" };
      net.add(core);
      const corePick = new THREE.Mesh(
        new THREE.SphereGeometry(7.5, 12, 12),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
      );
      corePick.position.set(0, 9.2, 0);
      corePick.userData = { netId: "SP-01", netRole: "spine" };
      net.add(corePick);
      const spinePos: THREE.Vector3[] = [];
      for (let i = 0; i < 8; i++) {
        const x = (i % 4 - 1.5) * 4.2;
        const z = (Math.floor(i / 4) - 0.5) * 5.0;
        const pos = new THREE.Vector3(x, 9.15, z);
        spinePos.push(pos);
        const box = new THREE.Mesh(new THREE.BoxGeometry(2.7, 1.0, 1.5), spineMat);
        box.position.copy(pos);
        box.userData = { netId: `SP-${String(i + 1).padStart(2, "0")}`, netRole: "spine" };
        net.add(box);
        const edge = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(2.76, 1.05, 1.56)),
          new THREE.LineBasicMaterial({ color: 0xe10600 }),
        );
        edge.position.copy(pos);
        edge.userData = { netId: `SP-${String(i + 1).padStart(2, "0")}`, netRole: "spine" };
        net.add(edge);
        const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(`SP-${String(i + 1).padStart(2, "0")}`, 40), transparent: true, depthTest: false }));
        spr.position.set(pos.x, pos.y + 1.15, pos.z);
        spr.scale.set(7.2, 1.9, 1);
        spr.userData = { isNetLabel: true };
        net.add(spr);
      }

      const downPts: number[] = [];
      const upPts: number[] = [];
      hs.forEach((hall, hallIndex) => {
        const origin = hallOrigin(hallIndex, pitchNow);
        const rows = new Map<number, ClusterRack[]>();
        for (const rack of hall.racks) {
          const list = rows.get(rack.y) ?? [];
          list.push(rack);
          rows.set(rack.y, list);
        }
        const ys = [...rows.keys()].sort((a, b) => a - b);
        ys.forEach((y, rowI) => {
          const rowRacks = rows.get(y) ?? [];
          const local = tileToWorld(hall.width_tiles - 0.15, y, hall.width_tiles, hall.depth_tiles);
          const leafPos = new THREE.Vector3(origin.x + local.x + 1.1, 2.35, origin.z + local.z);
          const leaf = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.38, 0.5), leafMat);
          leaf.position.copy(leafPos);
          leaf.userData = { netId: `${hall.name}-LF-R${String(rowI + 1).padStart(2, "0")}`, netRole: "leaf", hallId: hall.id };
          net.add(leaf);
          const leafEdge = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(1.38, 0.41, 0.53)),
            new THREE.LineBasicMaterial({ color: 0x8a8a8a }),
          );
          leafEdge.position.copy(leafPos);
          leafEdge.userData = {
            netId: `${hall.name}-LF-R${String(rowI + 1).padStart(2, "0")}`,
            netRole: "leaf",
            hallId: hall.id,
          };
          net.add(leafEdge);
          for (const rack of rowRacks) {
            const rp = tileToWorld(rack.x, rack.y, hall.width_tiles, hall.depth_tiles);
            downPts.push(origin.x + rp.x, RACK_H + 0.05, origin.z + rp.z, leafPos.x, leafPos.y, leafPos.z);
          }
          for (const sp of spinePos) {
            upPts.push(leafPos.x, leafPos.y, leafPos.z, sp.x, sp.y, sp.z);
          }
        });
      });
      if (downPts.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(downPts, 3));
        netDown.add(new THREE.LineSegments(g, downMat));
      }
      if (upPts.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(upPts, 3));
        netUp.add(new THREE.LineSegments(g, upMat));
      }
    };

    const paint = () => {
      if (!bodyMesh || !capMesh) return;
      const selected = new Set(selectedRef.current);
      let ringOn = false;
      entries.forEach((entry, i) => {
        const pos = worldOf(entry);
        dummy.position.set(pos.x, RACK_H / 2, pos.z);
        dummy.rotation.set(0, THREE.MathUtils.degToRad(entry.rack.rotation), 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        bodyMesh!.setMatrixAt(i, dummy.matrix);
        dummy.position.y = RACK_H + 0.03;
        dummy.updateMatrix();
        capMesh!.setMatrixAt(i, dummy.matrix);
        const isSel = selected.has(entry.rack.id);
        bodyMesh!.setColorAt(i, bodyColor(entry.rack, isSel));
        capMesh!.setColorAt(i, capColor(entry.rack, isSel));
        if (isSel && selected.size === 1) {
          ring.position.set(pos.x, RACK_H / 2, pos.z);
          ring.rotation.y = dummy.rotation.y;
          ring.visible = true;
          ringOn = true;
        }
      });
      if (!ringOn) ring.visible = false;
      bodyMesh.instanceMatrix.needsUpdate = true;
      capMesh.instanceMatrix.needsUpdate = true;
      if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
      if (capMesh.instanceColor) capMesh.instanceColor.needsUpdate = true;
    };

    rebuildRef.current = rebuild;
    paintRef.current = paint;
    rebuild();

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
      const netHits = raycaster.intersectObjects(net.children, true);
      for (const h of netHits) {
        const found = netFrom(h.object, h.point);
        if (found) return found;
      }
      const objs: THREE.Object3D[] = [...floors.children, ...labels.children];
      if (bodyMesh) objs.unshift(bodyMesh);
      const hits = raycaster.intersectObjects(objs, false);
      for (const h of hits) {
        if (h.object === bodyMesh && h.instanceId != null) {
          return { kind: "rack" as const, entry: entries[h.instanceId], point: h.point };
        }
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
      const origin = hallOrigin(idx, pitch);
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
      const origin = hallOrigin(idx, pitch);
      fly = {
        t: 0,
        dur: 0.7,
        fromP: camera.position.clone(),
        toP: new THREE.Vector3(origin.x, 18, origin.z + 22),
        fromT: controls.target.clone(),
        toT: new THREE.Vector3(origin.x, 0.4, origin.z),
      };
    };
    flyToHallRef.current = flyToHall;
    flyToClusterRef.current = () => {
      fly = {
        t: 0,
        dur: 0.7,
        fromP: camera.position.clone(),
        toP: new THREE.Vector3(0, 58, 86),
        fromT: controls.target.clone(),
        toT: new THREE.Vector3(0, 0.6, 0),
      };
    };

    let dragIndex: number | null = null;
    let dragMoved = false;
    let startX = 0;
    let startY = 0;
    const ghost = new THREE.Mesh(
      new THREE.BoxGeometry(RACK_W, 0.04, RACK_D),
      new THREE.MeshBasicMaterial({ color: 0xe10600, transparent: true, opacity: 0.45 }),
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
            const origin = hallOrigin(idx, pitch);
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
      if (!dragMoved || !bodyMesh || !capMesh) return;
      const found = hit(event);
      const entry = entries[dragIndex];
      if (found?.kind === "floor" && found.hallId === entry.hallId) {
        const tile = tileOnHall(entry.hallId, found.point);
        if (!tile) return;
        const origin = hallOrigin(entry.hallIndex, pitch);
        const local = tileToWorld(tile.x, tile.y, entry.width, entry.depth);
        dummy.position.set(origin.x + local.x, RACK_H / 2, origin.z + local.z);
        dummy.rotation.set(0, THREE.MathUtils.degToRad(entry.rack.rotation), 0);
        dummy.updateMatrix();
        bodyMesh.setMatrixAt(dragIndex, dummy.matrix);
        dummy.position.y = RACK_H + 0.03;
        dummy.updateMatrix();
        capMesh.setMatrixAt(dragIndex, dummy.matrix);
        bodyMesh.instanceMatrix.needsUpdate = true;
        capMesh.instanceMatrix.needsUpdate = true;
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
      clusterSprite.visible = level === "cluster";
      labels.visible = level !== "rack";
      rackNames.visible = level !== "cluster";
      const nameScale = level === "rack" ? 1 : 0.72;
      rackNames.children.forEach((ch) => ch.scale.set(2.4 * nameScale, 0.62 * nameScale, 1));
      netDown.visible = level !== "cluster";
      netUp.visible = level !== "rack";
      net.visible = true;
      const labelScale = level === "cluster" ? 1.35 : 1;
      net.children.forEach((ch) => {
        if (ch.userData.isNetLabel) ch.scale.set(7.2 * labelScale, 1.9 * labelScale, 1);
      });
      const nearest = (() => {
        let best: { id: string; d: number } | null = null;
        hallsRef.current.forEach((hall, i) => {
          const o = hallOrigin(i, pitch);
          const d = Math.hypot(controls.target.x - o.x, controls.target.z - o.z);
          if (!best || d < best.d) best = { id: hall.id, d };
        });
        return best ? best.id : null;
      })();
      if (level !== lastLevel || nearest !== lastHall) {
        lastLevel = level;
        lastHall = nearest;
        onViewRef.current({ level, hallId: nearest, distance });
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("pointerleave", onLeave);
      controls.dispose();
      disposeInstanced();
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
