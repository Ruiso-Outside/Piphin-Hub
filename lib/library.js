// Mídia compartilhada: o que os módulos criam ou baixam (músicas do Piphin Música, sons do Piphin Som,
// prints e gravações do Piphin Captura, imagens do Piphin Foto, vídeos do Piphin Vídeo...) fica numa lista só,
// e qualquer módulo pode usar. Os arquivos continuam onde o módulo salvou; aqui fica só o índice.
//
// Cada item: { id, path, kind: "audio" | "video" | "image", title, by (id do módulo), sub?, artist?, album?,
//   duration? (s), width?, height?, license?, credit?, videoOk?, cover? (imagem), tags?: [], game?, size, addedAt }
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");

const EXT = {
  audio: ["mp3", "m4a", "aac", "wav", "ogg", "opus", "flac", "wma", "weba"],
  video: ["mp4", "m4v", "mov", "webm", "mkv", "avi"],
  image: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
};
const KINDS = Object.keys(EXT);
const kindOf = (file) => { const e = path.extname(String(file)).slice(1).toLowerCase(); return KINDS.find((k) => EXT[k].includes(e)) || null; };
const MAX_ITEMS = 20000;
const str = (v, n = 200) => (v == null || v === "" ? undefined : String(v).slice(0, n));
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);

class MediaLibrary extends EventEmitter {
  constructor({ file, nativeImage }) {
    super();
    this.file = file;
    this.nativeImage = nativeImage;
    this.thumbs = new Map(); // id -> dataURL (só na memória)
    let data = null;
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* primeira vez */ }
    this.items = Array.isArray(data && data.items) ? data.items : [];
    this.prune(false);
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file + ".tmp", JSON.stringify({ version: 1, items: this.items }));
        fs.renameSync(this.file + ".tmp", this.file);
      } catch { /* sem disco: tenta na próxima mudança */ }
    }, 400);
    clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => this.emit("changed"), 250);
  }

  // item vindo de um módulo -> item guardado (ou null se o arquivo não existe / formato desconhecido)
  normalize(by, it, old) {
    if (!it || !it.path) return null;
    const file = path.resolve(String(it.path));
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    if (!st.isFile()) return null;
    const kind = KINDS.includes(it.kind) ? it.kind : kindOf(file);
    if (!kind) return null;
    const tags = Array.isArray(it.tags) ? it.tags.map((t) => String(t).slice(0, 60)).filter(Boolean).slice(0, 12) : undefined;
    const out = {
      id: old ? old.id : crypto.randomBytes(6).toString("hex"),
      path: file, kind, by,
      title: str(it.title, 160) || path.basename(file).replace(/\.[^.]+$/, ""),
      sub: str(it.sub, 60), artist: str(it.artist, 120), album: str(it.album, 120),
      duration: num(it.duration), width: num(it.width), height: num(it.height),
      license: str(it.license, 60), credit: str(it.credit, 400), videoOk: typeof it.videoOk === "boolean" ? it.videoOk : undefined,
      cover: it.cover && fs.existsSync(String(it.cover)) ? path.resolve(String(it.cover)) : undefined,
      tags: tags && tags.length ? tags : undefined, game: str(it.game, 120),
      size: st.size,
      addedAt: old ? old.addedAt : (it.addedAt && !isNaN(Date.parse(it.addedAt)) ? new Date(it.addedAt).toISOString() : new Date(st.mtimeMs || Date.now()).toISOString()),
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    if (old && (old.size !== out.size || old.cover !== out.cover)) this.thumbs.delete(old.id);
    return out;
  }

  key(p) { return path.resolve(String(p)).toLowerCase(); }

  // acrescenta ou atualiza (pelo caminho do arquivo)
  add(by, list) {
    const out = [];
    for (const it of [].concat(list || [])) {
      const k = it && it.path ? this.key(it.path) : null;
      const i = k ? this.items.findIndex((x) => this.key(x.path) === k) : -1;
      const item = this.normalize(i >= 0 ? this.items[i].by : by, it, i >= 0 ? this.items[i] : null);
      if (!item) continue;
      if (i >= 0) this.items[i] = item; else this.items.push(item);
      out.push(item);
    }
    if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
    if (out.length) this.save();
    return out;
  }

  // a lista inteira de um módulo: o que não veio sai (ex.: música removida no Piphin Música)
  sync(by, list) {
    const before = this.items.filter((x) => x.by === by);
    const old = new Map(before.map((x) => [this.key(x.path), x]));
    const next = [];
    const seen = new Set();
    for (const it of [].concat(list || [])) {
      if (!it || !it.path) continue;
      const k = this.key(it.path);
      if (seen.has(k)) continue;
      seen.add(k);
      const item = this.normalize(by, it, old.get(k));
      if (item) next.push(item);
    }
    const others = this.items.filter((x) => x.by !== by && !seen.has(this.key(x.path)));
    const same = before.length === next.length && next.every((x) => { const o = old.get(this.key(x.path)); return o && JSON.stringify(o) === JSON.stringify(x); });
    this.items = [...others, ...next];
    if (!same) this.save();
    return next.length;
  }

  remove(by, paths) {
    const keys = new Set([].concat(paths || []).map((p) => this.key(p)));
    const n = this.items.length;
    this.items = this.items.filter((x) => !(x.by === by && keys.has(this.key(x.path))));
    if (this.items.length !== n) this.save();
    return n - this.items.length;
  }

  // tira os itens cujo arquivo sumiu (apagado ou movido)
  prune(notify = true) {
    const n = this.items.length;
    this.items = this.items.filter((x) => x && x.path && fs.existsSync(x.path));
    if (this.items.length !== n && notify) this.save();
    return n - this.items.length;
  }

  get(id) { return this.items.find((x) => x.id === id) || null; }

  list({ kind, kinds, by, query, tag, game, limit = 500 } = {}) {
    this.prune();
    const ks = kinds ? [].concat(kinds) : kind ? [kind] : null;
    const words = String(query || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/\s+/).filter(Boolean);
    const g = game ? String(game).toLowerCase() : null;
    return this.items
      .filter((x) => (!ks || ks.includes(x.kind)) && (!by || x.by === by) && (!tag || (x.tags || []).includes(tag)) && (!g || (x.game || "").toLowerCase() === g))
      .filter((x) => {
        if (!words.length) return true;
        const hay = [x.title, x.sub, x.artist, x.album, x.game, path.basename(x.path), ...(x.tags || [])].join(" ").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0))
      .slice(0, Math.max(1, Math.min(5000, Number(limit) || 500)));
  }

  // miniatura (JPEG em data URL): a do Windows para imagens e vídeos, a capa para músicas
  async thumb(id, size = 320) {
    if (this.thumbs.has(id)) return this.thumbs.get(id);
    const it = this.get(id);
    if (!it) return null;
    let url = null;
    const src = it.cover || (it.kind !== "audio" ? it.path : null);
    if (src) {
      try {
        let img = await this.nativeImage.createThumbnailFromPath(src, { width: size, height: size });
        if (!img || img.isEmpty()) throw new Error("vazia");
        url = "data:image/jpeg;base64," + img.toJPEG(82).toString("base64");
      } catch {
        try { // sem miniatura do Windows: lê a imagem direto (só arquivos de imagem)
          if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(src) && fs.statSync(src).size < 40 * 1024 * 1024) {
            let img = this.nativeImage.createFromPath(src);
            if (!img.isEmpty()) {
              const s = img.getSize();
              if (s.width > size || s.height > size) img = img.resize(s.width >= s.height ? { width: size } : { height: size });
              url = "data:image/jpeg;base64," + img.toJPEG(82).toString("base64");
            }
          }
        } catch { url = null; }
      }
    }
    if (this.thumbs.size > 600) this.thumbs.delete(this.thumbs.keys().next().value);
    this.thumbs.set(id, url);
    return url;
  }
}

module.exports = { MediaLibrary, kindOf, KINDS, EXT };
