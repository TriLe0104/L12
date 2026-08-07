"use client";

// Temporary diagnostic page. Deleted after the 3DM investigation.
import { useEffect, useState } from "react";
import type { BufferGeometry, Mesh } from "three";

export default function Tmp3dm() {
  const [out, setOut] = useState("running…");

  useEffect(() => {
    void (async () => {
      const lines: string[] = [];
      const url = new URLSearchParams(location.search).get("url")!;
      const format = (new URLSearchParams(location.search).get("format") ?? "3dm") as never;
      try {
        const THREE = await import("three");
        const { loadModel } = await import("@/lib/model-loaders");
        const loaded = await loadModel(url, format, (p) => lines.push(`progress ${p.phase}`));
        lines.push(
          `loadModel -> triangles=${loaded.triangles} vertices=${loaded.vertices} ` +
            `missingTextures=${loaded.missingTextures}`,
        );
        let n = 0;
        loaded.object.traverse((node) => {
          const mesh = node as Mesh;
          lines.push(
            `  ${node.type} isMesh=${!!mesh.isMesh} visible=${node.visible} ` +
              `objectType=${node.userData?.objectType ?? "-"}`,
          );
          if (mesh.isMesh) {
            n++;
            const g = mesh.geometry as BufferGeometry;
            lines.push(
              `     attrs=${Object.keys(g.attributes).join(",")} ` +
                `pos=${g.getAttribute("position")?.count} index=${g.getIndex()?.count} ` +
                `groups=${g.groups.length}`,
            );
          }
        });
        lines.push(`meshes=${n}`);
        const box = new THREE.Box3().setFromObject(loaded.object);
        lines.push(`box empty=${box.isEmpty()} min=${box.min.toArray()} max=${box.max.toArray()}`);
      } catch (err) {
        lines.push(`THREW: ${err instanceof Error ? `${err.message}\n${err.stack}` : String(err)}`);
      }
      setOut(lines.join("\n"));
    })();
  }, []);

  return <pre id="out">{out}</pre>;
}
