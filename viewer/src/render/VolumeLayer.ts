import * as THREE from "three";
import type { Gvol } from "../io/gvol.ts";
import { blueNoise } from "./blueNoise.ts";
import { volumeFrag, volumeVert } from "./shaders.ts";

export interface VolumeStats {
  bytesGPU: number;
  dims: [number, number, number];
}

/** The ray-marched box: textures from the .gvol plus the ShaderMaterial uniforms. */
export class VolumeLayer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly stats: VolumeStats;
  readonly frames: number;
  private textures: THREE.Texture[] = [];

  constructor(g: Gvol, box: [number, number, number]) {
    const p = g.header.plan;
    const [w, h, t] = [p.width, p.height, p.frames];
    this.frames = t;
    const vol = g.section("volume") as Uint8Array;
    const volTex = new THREE.Data3DTexture(vol, w, h, t);
    volTex.format = THREE.RGBAFormat;
    volTex.type = THREE.UnsignedByteType;
    volTex.minFilter = volTex.magFilter = THREE.LinearFilter;
    volTex.wrapS = volTex.wrapT = volTex.wrapR = THREE.ClampToEdgeWrapping;
    volTex.unpackAlignment = 1;
    volTex.generateMipmaps = false;
    volTex.needsUpdate = true;

    const bs = g.header.sections.bricks?.shape ?? [1, 1, 1];
    const bricksData = (g.section("bricks") as Uint8Array) ?? new Uint8Array([255]);
    const brickTex = new THREE.Data3DTexture(bricksData, bs[2], bs[1], bs[0]);
    brickTex.format = THREE.RedFormat;
    brickTex.minFilter = brickTex.magFilter = THREE.NearestFilter;
    brickTex.unpackAlignment = 1;
    brickTex.needsUpdate = true;

    const flick = (g.section("flicker") as Uint8Array) ?? new Uint8Array(w * h);
    const flickTex = new THREE.DataTexture(flick, w, h, THREE.RedFormat, THREE.UnsignedByteType);
    flickTex.minFilter = flickTex.magFilter = THREE.LinearFilter;
    flickTex.unpackAlignment = 1;
    flickTex.needsUpdate = true;

    const bg = (g.section("background") as Uint8Array) ?? new Uint8Array(w * h * 4);
    const plateTex = new THREE.DataTexture(bg, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    plateTex.minFilter = plateTex.magFilter = THREE.LinearFilter;
    plateTex.needsUpdate = true;

    const noise = blueNoise(64, 7).bytes;
    const noiseTex = new THREE.DataTexture(noise, 64, 64, THREE.RedFormat, THREE.UnsignedByteType);
    noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
    noiseTex.minFilter = noiseTex.magFilter = THREE.NearestFilter;
    noiseTex.unpackAlignment = 1;
    noiseTex.needsUpdate = true;

    this.textures = [volTex, brickTex, flickTex, plateTex, noiseTex];
    this.stats = {
      bytesGPU: vol.byteLength + bricksData.byteLength + flick.byteLength + bg.byteLength + noise.byteLength,
      dims: [w, h, t],
    };

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: volumeVert,
      fragmentShader: volumeFrag,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      uniforms: {
        uVolume: { value: volTex },
        uBricks: { value: brickTex },
        uFlicker: { value: flickTex },
        uPlate: { value: plateTex },
        uNoise: { value: noiseTex },
        uBox: { value: new THREE.Vector3(...box) },
        uCam: { value: new THREE.Vector3() },
        uBrickDims: { value: new THREE.Vector3(bs[2], bs[1], bs[0]) },
        uStep: { value: box[2] / t },
        uNoiseOffset: { value: new THREE.Vector2() },
        uSigma: { value: 0.5 },
        uSigmaSolid: { value: 400 },
        uTau: { value: 0 },
        uTauSoft: { value: 0.0015 },
        uTauDir: { value: 1 },
        uSep: { value: 0 },
        uGainA: { value: 1 },
        uFlickerMode: { value: 0 },
        uEdgeSoft: { value: 0.1 },
        uReveal: { value: 2 },
        uPlateOpacity: { value: 0 },
        uStretch: { value: new THREE.Vector2(0, 1) },
        uSaturation: { value: 1 },
        uEmissiveLuma: { value: 0.92 },
        uEmissiveGain: { value: 2 },
        uSmokeOn: { value: 1 },
        uDisplayBlend: { value: 0 },
        uEvidenceFloor: { value: 0.035 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.material);
    this.mesh.frustumCulled = false;
    this.setBox(box);
  }

  get u() {
    return this.material.uniforms;
  }

  setBox(box: [number, number, number]) {
    this.mesh.scale.set(...box);
    (this.u.uBox.value as THREE.Vector3).set(...box);
  }

  /** Release the CPU copy of the voxels once uploaded (875 MB+ would otherwise stay in the JS heap). */
  dropCpuData() {
    for (const t of this.textures) {
      const img = t.image as { data: unknown };
      if (img && "data" in img && (t as THREE.Data3DTexture).isData3DTexture) img.data = null;
    }
  }

  dispose() {
    this.textures.forEach((t) => t.dispose());
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
