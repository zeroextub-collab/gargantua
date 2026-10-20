import * as THREE from "three";

export type FlyMode = "off" | "locked" | "drag";

/** First-person fly camera. Uses pointer lock when the browser grants it; when it is refused (embedded browsers,
 *  kiosks, some sandboxes) it falls back to drag-to-look, so flying through the cube works everywhere. */
export class FlyControls {
  mode: FlyMode = "off";
  private yaw = 0;
  private pitch = 0;
  private dragging = false;
  private readonly el: HTMLElement;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly onChange: (mode: FlyMode) => void;

  constructor(camera: THREE.PerspectiveCamera, el: HTMLElement, onChange: (mode: FlyMode) => void) {
    this.camera = camera;
    this.el = el;
    this.onChange = onChange;
    el.addEventListener("mousemove", (e) => this.look(e));
    el.addEventListener("pointerdown", () => (this.dragging = true));
    window.addEventListener("pointerup", () => (this.dragging = false));
    document.addEventListener("pointerlockchange", () => {
      if (this.mode === "locked" && document.pointerLockElement !== el) this.set("off");
    });
  }

  get active() {
    return this.mode !== "off";
  }

  enter() {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, "YXZ");
    this.yaw = e.y;
    this.pitch = e.x;
    const fallback = () => this.set("drag");
    try {
      const req = (this.el.requestPointerLock as unknown as () => Promise<void> | undefined).call(this.el);
      if (req && typeof req.then === "function") req.then(() => this.set("locked"), fallback);
      else this.set("locked"); // older browsers: lock state arrives via pointerlockchange
    } catch {
      fallback();
    }
  }

  exit() {
    if (document.pointerLockElement === this.el) document.exitPointerLock();
    this.set("off");
  }

  private set(m: FlyMode) {
    if (m === this.mode) return;
    this.mode = m;
    this.onChange(m);
  }

  private look(e: MouseEvent) {
    if (this.mode === "off" || (this.mode === "drag" && !this.dragging)) return;
    this.yaw -= e.movementX * 0.0022;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - e.movementY * 0.0022));
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
  }

  /** Move with W A S D (forward/strafe), Q / E (down/up); speed in world units per second. */
  update(dt: number, keys: Set<string>, speed: number) {
    if (this.mode === "off") return;
    const s = speed * (keys.has("shift") ? 3 : 1) * dt;
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const right = new THREE.Vector3().crossVectors(fwd, this.camera.up).normalize();
    if (keys.has("w")) this.camera.position.addScaledVector(fwd, s);
    if (keys.has("s")) this.camera.position.addScaledVector(fwd, -s);
    if (keys.has("d")) this.camera.position.addScaledVector(right, s);
    if (keys.has("a")) this.camera.position.addScaledVector(right, -s);
    if (keys.has("e")) this.camera.position.y += s;
    if (keys.has("q")) this.camera.position.y -= s;
  }
}
