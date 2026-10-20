// Tiny two-way control builders bound to the Store (no framework).
import type { Params, Store } from "../app/state.ts";

type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | undefined)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") e.addEventListener(k.replace(/^on/, ""), v as EventListener);
    else if (k === "class") e.className = String(v);
    else if (v === true) e.setAttribute(k, "");
    else e.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined) e.append(c);
  return e;
}

export class Binder {
  private refreshers: (() => void)[] = [];
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    store.on(() => this.refresh());
  }
  add(fn: () => void) {
    this.refreshers.push(fn);
    fn();
  }
  refresh() {
    for (const f of this.refreshers) f();
  }

  slider(o: {
    label: string;
    key: keyof Params;
    min: number;
    max: number;
    step?: number;
    log?: boolean;
    fmt?: (v: number) => string;
    hint?: string;
  }) {
    const p = this.store.params as unknown as Record<string, number>;
    const toPos = (v: number) => (o.log ? (Math.log(v) - Math.log(o.min)) / (Math.log(o.max) - Math.log(o.min)) : (v - o.min) / (o.max - o.min));
    const fromPos = (x: number) => (o.log ? Math.exp(Math.log(o.min) + x * (Math.log(o.max) - Math.log(o.min))) : o.min + x * (o.max - o.min));
    const input = el("input", { type: "range", min: 0, max: 1000, step: 1, "aria-label": o.label }) as HTMLInputElement;
    const val = el("span", { class: "val" });
    input.addEventListener("input", () => {
      let v = fromPos(Number(input.value) / 1000);
      if (o.step) v = Math.round(v / o.step) * o.step;
      this.store.set({ [o.key]: v } as Partial<Params>);
    });
    input.addEventListener("dblclick", () => input.blur());
    const row = el("label", { class: "ctl slider", title: o.hint }, el("span", { class: "lbl" }, o.label), val, input);
    this.add(() => {
      const v = p[o.key as string];
      if (document.activeElement !== input) input.value = String(Math.round(toPos(v) * 1000));
      input.style.setProperty("--fill", `${toPos(v) * 100}%`);
      val.textContent = o.fmt ? o.fmt(v) : v.toFixed(2);
    });
    return row;
  }

  toggle(label: string, key: keyof Params, hint?: string, shortcut?: string) {
    const p = this.store.params as unknown as Record<string, boolean>;
    const b = el("button", { class: "toggle", type: "button", title: hint, "aria-pressed": "false" }, el("span", { class: "dot" }), label,
      shortcut ? el("kbd", {}, shortcut) : null) as HTMLButtonElement;
    b.addEventListener("click", () => this.store.set({ [key]: !p[key as string] } as Partial<Params>));
    this.add(() => b.setAttribute("aria-pressed", String(!!p[key as string])));
    return b;
  }

  segmented<T extends string | number>(label: string, options: { value: T; label: string; hint?: string }[], get: () => T, set: (v: T) => void) {
    const btns = options.map((o) => {
      const b = el("button", { type: "button", title: o.hint }, o.label) as HTMLButtonElement;
      b.addEventListener("click", () => set(o.value));
      return { b, v: o.value };
    });
    this.add(() => btns.forEach(({ b, v }) => b.setAttribute("aria-pressed", String(get() === v))));
    return el("div", { class: "ctl seg" }, el("span", { class: "lbl" }, label), el("div", { class: "segs" }, ...btns.map((x) => x.b)));
  }
}

export function section(title: string, open: boolean, ...kids: (Node | null)[]) {
  const d = el("details", { class: "sec", open }, el("summary", {}, el("span", {}, title)), el("div", { class: "body" }, ...kids));
  return d;
}

export function button(label: string, onClick: () => void, cls = "btn", hint?: string) {
  const b = el("button", { class: cls, type: "button", title: hint }, label);
  b.addEventListener("click", onClick);
  return b;
}

export function toast(msg: string, kind: "info" | "warn" | "error" = "info", ms = 4200) {
  const host = document.getElementById("toasts")!;
  const t = el("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, msg);
  host.append(t);
  setTimeout(() => t.classList.add("out"), ms);
  setTimeout(() => t.remove(), ms + 400);
}
