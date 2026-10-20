// GLSL for the volume ray-march, the screen-space thick lines and the final composite.
// Box convention: centred at the origin, size (W, H, D). Texture coordinates:
//   u = x / W + 0.5,  v = 0.5 - y / H (image row 0 at the top),  w = 0.5 - z / D (t = 0 at the front face).

export const MAX_STEPS = 1600;

export const volumeVert = /* glsl */ `
out vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const volumeFrag = /* glsl */ `
precision highp float;
precision highp sampler3D;
#define MAX_STEPS ${MAX_STEPS}

uniform sampler3D uVolume;   // rgb raw video colour (sRGB), a = evidence
uniform sampler3D uBricks;   // max evidence per 8^3 brick (nearest)
uniform sampler2D uFlicker;  // animated-screen mask
uniform sampler2D uPlate;    // background plate (context)
uniform sampler2D uNoise;    // 64x64 blue noise
uniform vec3 uBox;
uniform vec3 uCam;
uniform vec3 uBrickDims;
uniform float uStep;
uniform vec2 uNoiseOffset;
uniform float uSigma;        // smoke extinction per world unit
uniform float uSigmaSolid;   // solid extinction per world unit
uniform float uTau;
uniform float uTauSoft;
uniform float uTauDir;
uniform float uSep;
uniform float uGainA;
uniform int uFlickerMode;    // 0 keep, 1 scenery, 2 suppress
uniform float uEdgeSoft;
uniform float uReveal;
uniform float uPlateOpacity;
uniform vec2 uStretch;
uniform float uSaturation;
uniform float uEmissiveLuma;
uniform float uEmissiveGain;
uniform float uSmokeOn;
uniform float uDisplayBlend; // 1: composite sRGB values, 0: composite linear light (default)
uniform float uEvidenceFloor; // evidence below this is decoder noise on static edges, not motion

in vec3 vWorld;
out vec4 outColor;

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

// uDisplayBlend = 0 (default): colours are composited in linear light. 1: sRGB values are composited directly and
// converted after the march. Linear fits the reel's measurements better (docs/REEL_ANALYSIS.md section 8,
// docs/evidence/p3/blend_test/); display space is kept as a switch.
vec3 grade(vec3 c) {
  c = clamp((c - uStretch.x) / max(uStretch.y - uStretch.x, 1e-3), 0.0, 1.0);
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3(lum), c, uSaturation), 0.0);
  float e = smoothstep(uEmissiveLuma, min(uEmissiveLuma + 0.06, 1.0), lum);
  if (uDisplayBlend < 0.5) c = srgbToLinear(c);
  return c * (1.0 + e * uEmissiveGain);   // emissive pixels exceed 1.0 and feed the bloom
}

vec3 texCoord(vec3 p) { return vec3(p.x / uBox.x + 0.5, 0.5 - p.y / uBox.y, 0.5 - p.z / uBox.z); }

vec2 slab(vec3 ro, vec3 rd) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (-0.5 * uBox - ro) * inv;
  vec3 t1 = (0.5 * uBox - ro) * inv;
  vec3 lo = min(t0, t1), hi = max(t0, t1);
  return vec2(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
}

float solidMask(float w) {
  // tau at either end means "all smoke" / "all solid" exactly; the soft edge must not leave a solid sliver
  // on the back (or front) face
  if (uTau >= 0.999) return uTauDir > 0.0 ? 0.0 : 1.0;
  if (uTau <= 0.001) return uTauDir > 0.0 ? 1.0 : 0.0;
  float s = smoothstep(uTau - uTauSoft, uTau + uTauSoft, w);
  return uTauDir > 0.0 ? s : 1.0 - s;
}

float edgeFalloff(vec3 p) {
  vec3 d = 0.5 * uBox - abs(p);
  return smoothstep(0.0, uEdgeSoft, min(min(d.x, d.y), d.z));
}

void main() {
  vec3 ro = uCam;
  vec3 rd = normalize(vWorld - uCam);
  vec2 tt = slab(ro, rd);
  float tNear = max(tt.x, 0.0);
  float tFar = tt.y;
  if (tFar <= tNear || uSmokeOn < 0.5) { outColor = vec4(0.0); return; }

  float jitter = texture(uNoise, (gl_FragCoord.xy + uNoiseOffset) / 64.0).r;
  float ds = uStep;
  float t = tNear + jitter * ds;
  vec3 du = vec3(rd.x / uBox.x, -rd.y / uBox.y, -rd.z / uBox.z);   // d(uvw)/dt
  vec3 col = vec3(0.0);
  float T = 1.0;
  bool canSkip = uSep > 0.98;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (t >= tFar || T < 0.004) break;
    vec3 p = ro + rd * t;
    vec3 uvw = clamp(texCoord(p), 0.0, 1.0);
    if (uvw.z > uReveal) { t += ds; continue; }
    float solid = solidMask(uvw.z);
    if (canSkip && solid < 0.5) {
      // empty-space skipping: when the whole brick holds no evidence, jump to the brick's exit
      float bmax = texture(uBricks, uvw).r;
      if (bmax * uGainA < 0.002) {
        vec3 cell = floor(uvw * uBrickDims);
        vec3 lo = cell / uBrickDims, hi = (cell + 1.0) / uBrickDims;
        vec3 tl = (lo - uvw) / du, th = (hi - uvw) / du;
        vec3 tx = max(tl, th);
        float te = min(min(tx.x, tx.y), tx.z);
        t += max(te, 0.0) + 0.25 * ds;
        continue;
      }
    }
    vec4 s = texture(uVolume, uvw);
    float F = uFlickerMode > 0 ? texture(uFlicker, uvw.xy).r : 0.0;
    float ev = max(s.a - uEvidenceFloor, 0.0) / (1.0 - uEvidenceFloor) * (1.0 - F);
    float raw = uFlickerMode == 2 ? 1.0 - F : 1.0;
    float field = mix(raw, min(ev * uGainA, 8.0), uSep);
    float sig = mix(uSigma * edgeFalloff(p), uSigmaSolid, solid) * field;
    float a = 1.0 - exp(-sig * ds);
    vec3 c = grade(s.rgb);
    if (uFlickerMode == 2) c *= 1.0 - 0.85 * F;
    col += T * a * c;
    T *= 1.0 - a;
    t += ds;
  }
  if (uPlateOpacity > 0.0 && T > 0.004) {
    vec3 uvw = texCoord(ro + rd * tFar);
    if (uvw.z > 0.995) col += T * uPlateOpacity * grade(texture(uPlate, uvw.xy).rgb);
  }
  col = max(col, 0.0);
  outColor = vec4(uDisplayBlend > 0.5 ? srgbToLinear(col) : col, 1.0 - T);   // -> linear light for ACES/bloom
}`;

// Screen-space thick lines with analytic anti-aliasing (no MSAA needed); additive.
export const linesVert = /* glsl */ `
uniform vec2 uRes;
uniform float uWidth;
uniform vec4 uWindow;   // x: enabled, y: t_min, z: t_max, w: fade length
// occlusion by the cube (worldlines live inside it): exact transmittance camera -> vertex for the
// piecewise-constant sigma(t) of transmittance.ts (smoke before / solid after tau, nothing past reveal)
uniform float uOcclude;
uniform vec3 uBoxHalf;
uniform vec4 uDensity;  // x: sigma smoke, y: sigma solid, z: tau, w: tau direction
uniform float uRevealT; // > 1: off
float sigmaZ(float z) {
  float t = 0.5 - z / (2.0 * uBoxHalf.z);
  if (t > uRevealT) return 0.0;
  bool later = uDensity.z >= 0.999 ? false : (uDensity.z <= 0.001 ? true : t >= uDensity.z);
  bool solid = uDensity.w >= 0.0 ? later : !later;
  return solid ? uDensity.y : uDensity.x;
}
float transmit(vec3 c, vec3 p) {
  vec3 d = p - c;
  float t0 = 0.0;
  for (int k = 0; k < 3; k++) {
    if (abs(d[k]) < 1e-9) continue;
    float ta = (-uBoxHalf[k] - c[k]) / d[k];
    float tb = (uBoxHalf[k] - c[k]) / d[k];
    t0 = max(t0, min(ta, tb));
  }
  if (t0 >= 1.0) return 1.0;
  vec3 e = c + d * t0;
  float len = length(p - e);
  float lo = min(e.z, p.z), hi = max(e.z, p.z);
  if (hi - lo < 1e-6) return exp(-sigmaZ(0.5 * (lo + hi)) * len);
  float zt = (0.5 - uDensity.z) * 2.0 * uBoxHalf.z;
  float zr = (0.5 - min(uRevealT, 1.5)) * 2.0 * uBoxHalf.z;
  float b1 = clamp(zt, lo, hi), b2 = clamp(zr, lo, hi);
  float m1 = min(b1, b2), m2 = max(b1, b2);
  float opt = (m1 - lo) * sigmaZ(0.5 * (lo + m1)) + (m2 - m1) * sigmaZ(0.5 * (m1 + m2)) + (hi - m2) * sigmaZ(0.5 * (m2 + hi));
  return exp(-opt * len / (hi - lo));
}
in vec3 aA;
in vec3 aB;
in vec4 aColA;
in vec4 aColB;
in vec2 aTime;
out vec4 vCol;
out float vAcross;
out float vHalf;
void main() {
  vec4 ca = projectionMatrix * viewMatrix * vec4(aA, 1.0);
  vec4 cb = projectionMatrix * viewMatrix * vec4(aB, 1.0);
  const float nearW = 1e-3;
  if (ca.w < nearW && cb.w < nearW) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vCol = vec4(0.0); return; }
  if (ca.w < nearW) ca = mix(ca, cb, (nearW - ca.w) / (cb.w - ca.w));
  if (cb.w < nearW) cb = mix(cb, ca, (nearW - cb.w) / (ca.w - cb.w));
  vec2 sa = ca.xy / ca.w * uRes * 0.5;
  vec2 sb = cb.xy / cb.w * uRes * 0.5;
  vec2 d = sb - sa;
  vec2 dir = length(d) > 1e-4 ? normalize(d) : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float halfW = uWidth * 0.5 + 1.0;
  vec4 c = mix(ca, cb, position.x);
  c.xy += nrm * position.y * halfW / (uRes * 0.5) * c.w;
  gl_Position = c;
  vCol = mix(aColA, aColB, position.x);
  if (uOcclude > 0.5) vCol *= transmit(cameraPosition, mix(aA, aB, position.x));
  if (uWindow.x > 0.5) {
    float tt = mix(aTime.x, aTime.y, position.x);
    vCol *= smoothstep(uWindow.y - uWindow.w, uWindow.y, tt) * (1.0 - step(uWindow.z, tt));
  }
  vAcross = position.y * halfW;
  vHalf = uWidth * 0.5;
}`;

export const linesFrag = /* glsl */ `
precision highp float;
uniform float uIntensity;
in vec4 vCol;
in float vAcross;
in float vHalf;
out vec4 outColor;
void main() {
  float cover = clamp(vHalf + 0.5 - abs(vAcross), 0.0, 1.0);
  if (cover <= 0.0) discard;
  outColor = vec4(vCol.rgb * vCol.a * cover * uIntensity, 0.0);
}`;

export const fsVert = /* glsl */ `
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export const accumFrag = /* glsl */ `
precision highp float;
uniform sampler2D tPrev;
uniform sampler2D tCur;
uniform float uBlend;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = mix(texture(tPrev, vUv), texture(tCur, vUv), uBlend); }`;

// Worldlines are summed in their own target, then added with a saturating curve so thousands of overlapping
// tracks in a dense crowd converge to a bright glow (max 1.25) instead of blowing out through the bloom.
export const saturateFrag = /* glsl */ `
precision highp float;
uniform sampler2D tLines;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = vec4(1.25 * (1.0 - exp(-texture(tLines, vUv).rgb)), 0.0); }`;

export const copyFrag = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = texture(tSrc, vUv); }`;

// ACES (Narkowicz fit) + vignette + film grain + dither, then sRGB encode.
export const finalFrag = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform float uExposure;
uniform float uVignette;
uniform float uGrain;
uniform float uFrame;
in vec2 vUv;
out vec4 outColor;
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 toSrgb(vec3 l) { return mix(l * 12.92, 1.055 * pow(l, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, l)); }
float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
void main() {
  vec3 c = aces(texture(tColor, vUv).rgb * uExposure);
  vec2 q = vUv - 0.5;
  c *= 1.0 - uVignette * smoothstep(0.18, 0.75, dot(q, q) * 1.8);
  vec3 s = toSrgb(c);
  float n = hash(gl_FragCoord.xy + vec2(uFrame * 17.31, uFrame * 7.13));
  s += (n - 0.5) * uGrain * (0.35 + 0.65 * (1.0 - s));   // grain sits mostly in the shadows and mids
  s += (hash(gl_FragCoord.yx * 1.37 + uFrame) - 0.5) / 255.0;
  outColor = vec4(clamp(s, 0.0, 1.0), 1.0);
}`;
