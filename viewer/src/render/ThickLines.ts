import * as THREE from "three";
import { linesFrag, linesVert } from "./shaders.ts";

/** Instanced screen-space line segments with analytic AA, additive blending, optional time window. */
export class ThickLines {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly geometry: THREE.InstancedBufferGeometry;
  readonly a: Float32Array;
  readonly b: Float32Array;
  readonly colA: Float32Array;
  readonly colB: Float32Array;
  readonly time: Float32Array;
  readonly capacity: number;

  constructor(capacity: number, width = 1.4, intensity = 1) {
    this.capacity = capacity;
    const g = new THREE.InstancedBufferGeometry();
    // quad: x along the segment (0..1), y across (-1..1)
    g.setAttribute("position", new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.a = new Float32Array(capacity * 3);
    this.b = new Float32Array(capacity * 3);
    this.colA = new Float32Array(capacity * 4);
    this.colB = new Float32Array(capacity * 4);
    this.time = new Float32Array(capacity * 2);
    g.setAttribute("aA", new THREE.InstancedBufferAttribute(this.a, 3));
    g.setAttribute("aB", new THREE.InstancedBufferAttribute(this.b, 3));
    g.setAttribute("aColA", new THREE.InstancedBufferAttribute(this.colA, 4));
    g.setAttribute("aColB", new THREE.InstancedBufferAttribute(this.colB, 4));
    g.setAttribute("aTime", new THREE.InstancedBufferAttribute(this.time, 2));
    g.instanceCount = 0;
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: linesVert,
      fragmentShader: linesFrag,
      uniforms: {
        uRes: { value: new THREE.Vector2(1, 1) },
        uWidth: { value: width },
        uIntensity: { value: intensity },
        uWindow: { value: new THREE.Vector4(0, 0, 1, 0.05) },
        uOcclude: { value: 0 },
        uBoxHalf: { value: new THREE.Vector3(1, 1, 1) },
        uDensity: { value: new THREE.Vector4(0, 0, 0, 1) },
        uRevealT: { value: 2 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
  }

  set count(n: number) {
    this.geometry.instanceCount = Math.min(n, this.capacity);
  }

  get count() {
    return this.geometry.instanceCount;
  }

  touch(colorsOnly = false) {
    const g = this.geometry;
    if (!colorsOnly) {
      (g.getAttribute("aA") as THREE.InstancedBufferAttribute).needsUpdate = true;
      (g.getAttribute("aB") as THREE.InstancedBufferAttribute).needsUpdate = true;
      (g.getAttribute("aTime") as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
    (g.getAttribute("aColA") as THREE.InstancedBufferAttribute).needsUpdate = true;
    (g.getAttribute("aColB") as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  setResolution(w: number, h: number) {
    (this.material.uniforms.uRes.value as THREE.Vector2).set(w, h);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
