"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { disposeObject, loadModel, type LoadProgress } from "@/lib/model-loaders";
import type { ModelFormat } from "@/lib/model-format";

/** This module is the only thing that pulls three.js in, and `ModelViewer`
 *  reaches it through `next/dynamic`. Everything below therefore lives in a
 *  chunk that is fetched the first time somebody opens a model, and never
 *  before. */

export interface ModelStats {
  triangles: number;
  vertices: number;
  /** width x height x depth of the bounding box, in the file's own units */
  size: [number, number, number];
  missingTextures: number;
  /** wall-clock from "start loading" to "first frame drawn", in ms */
  elapsedMs: number;
}

/** A 3/4 view: high enough to read the top, off-axis enough to read depth.
 *  Works whether the file was authored Y-up or Z-up, which CAD exports disagree
 *  about constantly. */
const VIEW_DIRECTION = new THREE.Vector3(1, 0.62, 1).normalize();

export function ModelCanvas({
  url,
  format,
  resetSignal,
  onProgress,
  onLoaded,
  onError,
}: {
  url: string;
  format: ModelFormat;
  /** bump to re-frame the camera on the model */
  resetSignal: number;
  onProgress: (p: LoadProgress) => void;
  onLoaded: (stats: ModelStats) => void;
  onError: (message: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<(() => void) | null>(null);

  /* Refit on demand. Held in a ref so the effect below owns the whole GL
     lifecycle and never re-runs just because a button was pressed. */
  useEffect(() => {
    if (resetSignal > 0) frameRef.current?.();
  }, [resetSignal]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const started = performance.now();
    let disposed = false;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    scene.add(camera);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.92;
    host.appendChild(renderer.domElement);

    /* Sky/ground ambient gives the form a vertical gradient; the key, fill and
       rim ride on the camera so an orbited part is never lit from behind into a
       flat silhouette. Kept deliberately under-exposed: a light part lit to the
       top of the range loses exactly the shading that shows its shape. */
    scene.add(new THREE.HemisphereLight(0xeaf1f7, 0x2f3841, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.35);
    key.position.set(0.55, 0.85, 0.75);
    camera.add(key);
    const fill = new THREE.DirectionalLight(0xd3deea, 0.4);
    fill.position.set(-0.85, -0.25, 0.35);
    camera.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.35);
    rim.position.set(-0.25, 0.45, -1);
    camera.add(rim);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;

    let model: THREE.Object3D | null = null;

    const resize = () => {
      const { clientWidth, clientHeight } = host;
      if (!clientWidth || !clientHeight) return;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    };

    /* Frame the camera on whatever arrived.
    
       Models turn up at wildly different scales and nowhere near the origin — a
       part in millimetres sitting 400 units off in X is normal. So nothing is
       assumed about either: the bounding sphere sets the orbit distance, the
       clipping planes and the zoom limits, and the box centre becomes the orbit
       target. A 0.001-unit fitting and a 5000-unit weldment both land in frame,
       and neither opens with the camera stuck inside the geometry. */
    const frameToModel = () => {
      if (!model) return;
      const box = new THREE.Box3().setFromObject(model);
      if (box.isEmpty()) return;

      const center = box.getCenter(new THREE.Vector3());
      const sphere = box.getBoundingSphere(new THREE.Sphere(center));
      const radius = Math.max(sphere.radius, 1e-6);

      const vertical = THREE.MathUtils.degToRad(camera.fov);
      const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
      // a little air around the part rather than a tight crop
      const distance =
        1.18 * Math.max(radius / Math.sin(vertical / 2), radius / Math.sin(horizontal / 2));

      camera.near = Math.max(distance / 5000, radius / 5000);
      camera.far = distance + radius * 40;
      camera.updateProjectionMatrix();

      camera.position.copy(center).addScaledVector(VIEW_DIRECTION, distance);
      controls.target.copy(center);
      controls.minDistance = radius * 0.05;
      controls.maxDistance = distance * 12;
      controls.update();
    };
    frameRef.current = frameToModel;

    const observer = new ResizeObserver(() => {
      resize();
      camera.updateProjectionMatrix();
    });
    observer.observe(host);
    resize();

    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
    });

    void (async () => {
      try {
        const loaded = await loadModel(url, format, (p) => {
          if (!disposed) onProgress(p);
        });
        if (disposed) {
          disposeObject(loaded.object);
          return;
        }

        const box = new THREE.Box3().setFromObject(loaded.object);
        const size = box.isEmpty()
          ? new THREE.Vector3()
          : box.getSize(new THREE.Vector3());

        /* A file that parses cleanly but yields nothing is the failure mode a
           naive "did it throw?" check sails straight past, so it is called out
           here rather than opening onto an empty grey frame. */
        if (loaded.triangles === 0 || box.isEmpty() || size.length() === 0) {
          disposeObject(loaded.object);
          onError("That file loaded but contains no visible geometry");
          return;
        }

        model = loaded.object;
        scene.add(model);
        resize();
        frameToModel();
        renderer.render(scene, camera);

        onLoaded({
          triangles: loaded.triangles,
          vertices: loaded.vertices,
          size: [size.x, size.y, size.z],
          missingTextures: loaded.missingTextures,
          elapsedMs: Math.round(performance.now() - started),
        });
      } catch (err) {
        if (disposed) return;
        onError(err instanceof Error ? err.message : "This model could not be read");
      }
    })();

    return () => {
      disposed = true;
      frameRef.current = null;
      observer.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      if (model) {
        scene.remove(model);
        disposeObject(model);
        model = null;
      }
      scene.clear();
      renderer.dispose();
      /* dispose() alone leaves the WebGL context alive until the GC gets round
         to it; browsers cap live contexts at ~16, so a few open/close cycles
         would start tearing down the oldest ones. Drop it explicitly. */
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
    // onProgress / onLoaded / onError are stable callbacks from the viewer above;
    // re-running this effect would tear down and rebuild the GL context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, format]);

  return <div className="model-canvas" ref={hostRef} />;
}

export default ModelCanvas;
