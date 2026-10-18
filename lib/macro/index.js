// Piphin Macro: macros de teclado e mouse, autoclicker, gravador e analisador de entradas.
// Tudo roda no motor local (engine.cs); as macros ficam em %APPDATA%\Piphin Hub\macros.json.
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const U = require("../util");
const { Engine } = require("./engine");

const CLICKER_ID = "autoclicker";
const DEFAULT_SETTINGS = {
  armed: true,                      // atalhos ligados
  panic: { vk: 123, mods: 0 },      // F12: para tudo na hora
  record: { vk: 120, mods: 0 },     // F9: encerra a gravação
  keepInTray: true,                 // fechar a janela mantém as macros funcionando
  testDelay: 3,                     // segundos antes do "Testar"
};
const DEFAULT_CLICKER = {
  id: CLICKER_ID, kind: "clicker", name: "Autoclicker", enabled: true,
  hotkey: { vk: 117, mods: 0 }, mode: "toggle", swallow: true, process: "",
  clicker: { button: 1, cps: 12, cpsMax: 14, hold: 18, double: false, fixed: false, x: 0, y: 0, limit: 0 },
};

const newId = () => crypto.randomBytes(5).toString("hex");
const num = (v, def, min = -Infinity, max = Infinity) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const r = (v) => Math.round(v * 1000) / 1000;

// ------------------------------------------------------------------ passos -> texto do motor
function compileStep(s) {
  switch (s.t) {
    case "key": {
      const vk = num(s.vk, 0, 0, 255);
      if (!vk) return null;
      if (s.act === "down") return `kd,${vk}`;
      if (s.act === "up") return `ku,${vk}`;
      return `kp,${vk},${num(s.hold, 30, 0)}`;
    }
    case "wait": {
      const ms = num(s.ms, 0, 0), max = num(s.max, 0, 0);
      return max > ms ? `w,${r(ms)},${r(max)}` : `w,${r(ms)}`;
    }
    case "click": {
      const b = num(s.btn, 1, 1, 6);
      if (s.act === "down") return `md,${b}`;
      if (s.act === "up") return `mu,${b}`;
      return `mc,${b},${num(s.hold, 25, 0)},${num(s.count, 1, 1, 100)}`;
    }
    case "move":
      return s.mode === "rel" ? `mr,${num(s.x, 0)},${num(s.y, 0)},${num(s.dur, 0, 0)}` : `ma,${num(s.x, 0)},${num(s.y, 0)},${num(s.dur, 0, 0)}`;
    case "wheel": return `${s.dir === "h" ? "hw" : "wh"},${Math.round(num(s.amount, 1) * 120)}`;
    case "text": return s.text ? `t,${Buffer.from(String(s.text), "utf8").toString("base64")},${num(s.gap, 15, 0)}` : null;
    case "pixel": {
      const color = String(s.color || "000000").replace(/[^0-9a-f]/gi, "").padStart(6, "0").slice(-6);
      return `wc,${num(s.x, 0)},${num(s.y, 0)},${color},${num(s.tol, 10, 0, 255)},${num(s.timeout, 0, 0)},${s.not ? 1 : 0}`;
    }
    case "loop": return `rs,${num(s.times, 2, 0)}`;
    case "end": return "re";
  }
  return null;
}

function compile(m) {
  if (m.kind === "clicker") {
    const c = m.clicker || {};
    const cps = num(c.cps, 10, 0.1, 200), cpsMax = Math.max(cps, num(c.cpsMax, cps, 0.1, 200));
    const hold = num(c.hold, 15, 1, 500);
    const steps = [];
    if (c.fixed) steps.push(`ma,${num(c.x, 0)},${num(c.y, 0)},0`);
    steps.push(`mc,${num(c.button, 1, 1, 6)},${hold},${c.double ? 2 : 1}`);
    // intervalo entre o fim de um clique e o começo do próximo, sorteado entre os dois CPS
    const gap = (v) => Math.max(1, 1000 / v - hold * (c.double ? 3 : 1));
    const a = gap(cpsMax), b = gap(cps);
    steps.push(b > a ? `w,${r(a)},${r(b)}` : `w,${r(a)}`);
    return { steps: steps.join(";"), repeat: num(c.limit, 0, 0), jitter: 0 };
  }
  const steps = (m.steps || []).map(compileStep).filter(Boolean);
  // blocos "repetir" sem "fim": fecha no final
  let open = 0;
  for (const s of steps) { if (s.startsWith("rs,")) open++; else if (s === "re" && open > 0) open--; }
  for (; open > 0; open--) steps.push("re");
  const repeat = m.mode === "toggle" || m.mode === "hold" ? 0 : m.mode === "repeat" ? num(m.repeat, 1, 0) : 1;
  return { steps: steps.join(";"), repeat, jitter: num(m.jitter, 0, 0, 90) };
}

// ------------------------------------------------------------------ gravação -> passos
function eventsToSteps(events, { moves, relative }) {
  const steps = [];
  const keysDown = new Set();
  let last = null;
  let pos = null;
  const wait = (t) => {
    if (last !== null) { const gap = t - last; if (gap >= 1) steps.push({ t: "wait", ms: Math.round(gap) }); }
    last = t;
  };
  for (const e of events) {
    if (e.dev === "k") {
      if (e.kind === "d" && keysDown.has(e.vk)) continue; // repetição automática do teclado
      if (e.kind === "d") keysDown.add(e.vk); else keysDown.delete(e.vk);
      wait(e.t);
      steps.push({ t: "key", vk: e.vk, act: e.kind === "d" ? "down" : "up" });
      continue;
    }
    if (e.kind === "mv") {
      if (!moves) continue;
      wait(e.t);
      if (relative && pos) steps.push({ t: "move", mode: "rel", x: e.x - pos.x, y: e.y - pos.y, dur: 0 });
      else if (!relative) steps.push({ t: "move", mode: "abs", x: e.x, y: e.y, dur: 0 });
      pos = { x: e.x, y: e.y };
      continue;
    }
    wait(e.t);
    if (!moves && !relative && (e.kind === "d" || !pos || Math.abs(pos.x - e.x) + Math.abs(pos.y - e.y) > 3)) {
      steps.push({ t: "move", mode: "abs", x: e.x, y: e.y, dur: 0 });
    }
    pos = { x: e.x, y: e.y };
    if (e.kind === "d" || e.kind === "u") steps.push({ t: "click", btn: e.btn, act: e.kind === "d" ? "down" : "up" });
    else if (e.kind === "wh" || e.kind === "hw") steps.push({ t: "wheel", dir: e.kind === "hw" ? "h" : "v", amount: Math.round((e.delta / 120) * 100) / 100 });
  }
  return compact(steps);
}

// "aperta + espera + solta" vira um passo só (pressionar/clicar com tempo segurado)
function compact(steps) {
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const a = steps[i], w = steps[i + 1], b = steps[i + 2];
    if (a.t === "key" && a.act === "down" && w && w.t === "wait" && b && b.t === "key" && b.act === "up" && b.vk === a.vk) {
      out.push({ t: "key", vk: a.vk, act: "press", hold: w.ms }); i += 2; continue;
    }
    if (a.t === "key" && a.act === "down" && w && w.t === "key" && w.act === "up" && w.vk === a.vk) {
      out.push({ t: "key", vk: a.vk, act: "press", hold: 0 }); i += 1; continue;
    }
    if (a.t === "click" && a.act === "down" && w && w.t === "wait" && b && b.t === "click" && b.act === "up" && b.btn === a.btn) {
      out.push({ t: "click", btn: a.btn, act: "click", hold: w.ms, count: 1 }); i += 2; continue;
    }
    out.push(a);
  }
  return out;
}

// ------------------------------------------------------------------ gerenciador
class Macros extends EventEmitter {
  constructor({ userDir }) {
    super();
    this.file = path.join(userDir, "macros.json");
    const data = U.readJson(this.file, {});
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    this.list = Array.isArray(data.macros) ? data.macros : [];
    if (!this.list.some((m) => m.id === CLICKER_ID)) this.list.unshift(JSON.parse(JSON.stringify(DEFAULT_CLICKER)));
    this.running = {}; // id -> { since, loops }
    this.recording = null;
    this.lab = null; // { moves }
    this.pending = {}; // "Testar" com contagem regressiva
    this.engine = new Engine();
    this.engine.on("line", (f) => this._event(f));
    this.engine.on("status", () => this._changed());
    this.engine.on("restarted", () => this._sync());
  }

  save() { U.writeJson(this.file, { schema: 1, settings: this.settings, macros: this.list }); }

  snapshot() {
    return {
      settings: this.settings,
      macros: this.list,
      running: this.running,
      recording: this.recording ? { since: this.recording.since, count: this.recording.events.length, moves: this.recording.moves, relative: this.recording.relative } : null,
      pending: Object.keys(this.pending),
      lab: this.lab,
      engine: { running: !!this.engine.proc, ready: this.engine.ready, error: this.engine.error, screen: this.engine.screen },
    };
  }

  _changed() { this.emit("changed"); }

  // há algo que precise do motor ligado?
  hasActiveHotkeys() { return this.settings.armed && this.list.some((m) => m.enabled && m.hotkey && m.hotkey.vk); }

  // só reenvia os atalhos quando o motor acabou de ligar (reenviar zera o estado "pressionado")
  async start() {
    const fresh = !this.engine.proc;
    await this.engine.start();
    if (fresh) this._sync();
  }

  // inicia o motor se houver atalhos ligados (chamado ao abrir o Hub)
  boot() { if (this.hasActiveHotkeys()) this.start().catch(() => this._changed()); }

  // reenvia atalhos, tecla de pânico e monitor ao motor
  _sync() {
    const e = this.engine;
    if (!e.proc) return;
    e.send("hkclear");
    const p = this.settings.panic || {};
    e.send("panic", p.vk || 0, p.mods || 0);
    if (this.settings.armed) {
      for (const m of this.list) {
        if (!m.enabled || !m.hotkey || !m.hotkey.vk) continue;
        e.send("hk", m.id, m.hotkey.vk, m.hotkey.mods || 0, m.swallow ? 1 : 0, m.process || "");
      }
    }
    if (this.recording) { const k = this.settings.record || {}; if (k.vk) e.send("hk", "__rec", k.vk, k.mods || 0, 1, ""); }
    this._monitor();
  }

  _monitor() {
    const on = !!(this.recording || this.lab);
    const moves = !!((this.recording && (this.recording.moves || this.recording.relative)) || (this.lab && this.lab.moves));
    this.engine.send("mon", on ? 1 : 0, moves ? 1 : 0);
  }

  // ---------------------------------------------------------------- eventos do motor
  _event(f) {
    switch (f[0]) {
      case "hd": return this._hotkey(f[1], true);
      case "hu": return this._hotkey(f[1], false);
      case "loop": if (this.running[f[1]]) { this.running[f[1]].loops = +f[2]; this.emit("loop", { id: f[1], loops: +f[2] }); } return;
      case "end": if (f[2] !== "restart") { delete this.running[f[1]]; this._changed(); } return;
      case "panic":
        for (const id of Object.keys(this.pending)) { clearTimeout(this.pending[id]); delete this.pending[id]; }
        this.emit("notice", { kind: "panic", text: "Tecla de pânico: todas as macros foram paradas" });
        this._changed();
        return;
      case "err": this.emit("notice", { kind: "err", text: f.slice(1).join(" ") }); return;
      case "k": case "m": return this._input(f);
    }
  }

  _hotkey(id, down) {
    if (id === "__rec") { if (down) this.stopRecording("hotkey"); return; }
    const m = this.list.find((x) => x.id === id);
    if (!m) return;
    const running = !!this.running[id];
    const mode = m.kind === "clicker" ? (m.mode === "hold" ? "hold" : "toggle") : m.mode || "once";
    if (!down) { if (mode === "hold") this.stop(id); return; }
    if (mode === "hold") return this.run(id);
    if (mode === "once") { if (!running) this.run(id); return; }
    // "repetir N vezes" e "liga/desliga": o mesmo atalho para
    if (running) this.stop(id); else this.run(id);
  }

  _input(f) {
    const e = f[0] === "k"
      ? { dev: "k", kind: f[1], vk: +f[2], scan: +f[3], ext: f[4] === "1", src: +f[5], t: +f[6] }
      : { dev: "m", kind: f[1], x: +f[2], y: +f[3], btn: f[1] === "d" || f[1] === "u" ? +f[4] : 0, delta: f[1] === "wh" || f[1] === "hw" ? +f[4] : 0, src: +f[5], t: +f[6] };
    if (this.recording && e.src !== 2) {
      const k = this.settings.record || {};
      if (!(e.dev === "k" && e.vk === k.vk)) { this.recording.events.push(e); if (this.recording.events.length % 20 === 1) this._changed(); }
    }
    if (this.lab) this.emit("input", e);
  }

  // ---------------------------------------------------------------- execução
  async run(id, { once = false } = {}) {
    const m = this.list.find((x) => x.id === id);
    if (!m) throw new Error("Macro não encontrada");
    await this.start();
    const c = compile(m);
    if (!c.steps) throw new Error("A macro não tem passos");
    this.running[id] = { since: Date.now(), loops: 0 };
    this.engine.send("run", id, once ? 1 : c.repeat, c.jitter, c.steps);
    this._changed();
  }

  // "Testar" pelo botão: espera alguns segundos para dar tempo de trocar para o jogo
  test(id) {
    if (this.pending[id]) { clearTimeout(this.pending[id]); delete this.pending[id]; this._changed(); return false; }
    const delay = num(this.settings.testDelay, 3, 0, 30) * 1000;
    this.pending[id] = setTimeout(() => { delete this.pending[id]; this.run(id, { once: true }).catch((e) => this.emit("notice", { kind: "err", text: e.message })); }, delay);
    this._changed();
    return true;
  }

  stop(id) {
    if (this.pending[id]) { clearTimeout(this.pending[id]); delete this.pending[id]; }
    this.engine.send("stop", id);
    this._changed();
  }

  stopAll() {
    for (const id of Object.keys(this.pending)) { clearTimeout(this.pending[id]); delete this.pending[id]; }
    this.engine.send("stopall");
    this._changed();
  }

  // ---------------------------------------------------------------- edição
  saveMacro(def) {
    const m = { ...def };
    if (!m.id) m.id = newId();
    m.name = String(m.name || "Macro sem nome").slice(0, 80);
    if (m.kind !== "clicker") m.kind = "macro";
    const i = this.list.findIndex((x) => x.id === m.id);
    if (i >= 0) this.list[i] = m; else this.list.push(m);
    this.save();
    this._sync();
    this._changed();
    return m;
  }

  deleteMacro(id) {
    if (id === CLICKER_ID) throw new Error("O autoclicker não pode ser apagado");
    this.stop(id);
    this.list = this.list.filter((m) => m.id !== id);
    this.save();
    this._sync();
    this._changed();
  }

  importMacros(arr) {
    const list = (Array.isArray(arr) ? arr : arr && Array.isArray(arr.macros) ? arr.macros : [arr]).filter((m) => m && Array.isArray(m.steps));
    if (!list.length) throw new Error("Nenhuma macro válida no arquivo");
    for (const m of list) this.list.push({ ...m, id: newId(), kind: "macro", enabled: false });
    this.save();
    this._sync();
    this._changed();
    return list.length;
  }

  setSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.save();
    if (this.hasActiveHotkeys() && !this.engine.proc) this.start().catch(() => {});
    this._sync();
    this._changed();
  }

  setHotkeysPaused(on) { this.engine.send("hkpause", on ? 1 : 0); }

  // ---------------------------------------------------------------- gravação
  async startRecording({ moves = false, relative = false } = {}) {
    await this.start();
    this.recording = { since: Date.now(), events: [], moves: !!moves, relative: !!relative };
    this._sync();
    this._changed();
  }

  // encerra a gravação; "ignore" = área da janela do Hub (o clique em "Parar" não entra)
  stopRecording(how, ignore) {
    const rec = this.recording;
    if (!rec) return null;
    this.recording = null;
    this._sync();
    const ev = rec.events;
    if (how === "button" && ignore) {
      const inside = (e) => e.dev === "m" && e.x >= ignore.x && e.y >= ignore.y && e.x < ignore.x + ignore.width && e.y < ignore.y + ignore.height;
      while (ev.length && (inside(ev[ev.length - 1]) || ev[ev.length - 1].kind === "mv")) ev.pop();
    }
    const steps = eventsToSteps(ev, rec);
    this.emit("recorded", { steps, events: ev.length, how });
    this._changed();
    return steps;
  }

  setLab(on, moves) {
    this.lab = on ? { moves: !!moves } : null;
    if (on) this.start().then(() => this._monitor()).catch(() => this._changed());
    else this._monitor();
    this._changed();
  }

  shutdown() { this.engine.stop(); }
}

module.exports = { Macros, compile, compileStep, eventsToSteps, CLICKER_ID };
