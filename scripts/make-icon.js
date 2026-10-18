// Desenha o ícone do Hub: icons/hub.png (256) e icons/hub.ico (16-256).
// Uso: npm run icon   (usa o próprio Electron para desenhar; sem dependências)
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "icons");

function ico(pngs) {
  // ICO com entradas PNG (aceito desde o Windows Vista)
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(({ size, buf }, i) => {
    const e = 6 + i * 16;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += buf.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.buf)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL("about:blank");
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const out = await win.webContents.executeJavaScript(`(() => {
    const res = {};
    for (const s of ${JSON.stringify(sizes)}) {
      const c = document.createElement("canvas"); c.width = c.height = s;
      const g = c.getContext("2d"); const k = s / 256;
      // fundo: quadrado arredondado escuro
      const r = 56 * k;
      g.beginPath(); g.roundRect(8 * k, 8 * k, 240 * k, 240 * k, r);
      const bg = g.createLinearGradient(0, 0, s, s); bg.addColorStop(0, "#1d1640"); bg.addColorStop(1, "#0b0a12");
      g.fillStyle = bg; g.fill();
      g.lineWidth = Math.max(1, 3 * k); g.strokeStyle = "rgba(168,85,247,.55)"; g.stroke();
      // hub: nó central ligado a 6 nós (os apps)
      const cx = 128 * k, cy = 128 * k, R = 66 * k;
      const pts = [...Array(6)].map((_, i) => [cx + R * Math.cos(Math.PI / 3 * i - Math.PI / 2), cy + R * Math.sin(Math.PI / 3 * i - Math.PI / 2)]);
      g.shadowColor = "#a855f7"; g.shadowBlur = 14 * k;
      g.strokeStyle = "#a855f7"; g.lineWidth = Math.max(1.5, 9 * k); g.lineCap = "round";
      g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.stroke();
      if (s >= 32) { g.lineWidth = Math.max(1, 6 * k); g.strokeStyle = "rgba(192,132,252,.8)";
        pts.forEach(([x, y]) => { g.beginPath(); g.moveTo(cx, cy); g.lineTo(x, y); g.stroke(); }); }
      g.fillStyle = "#e9d5ff";
      pts.forEach(([x, y]) => { g.beginPath(); g.arc(x, y, Math.max(1.5, 15 * k), 0, Math.PI * 2); g.fill(); });
      const cg = g.createRadialGradient(cx, cy, 0, cx, cy, 30 * k); cg.addColorStop(0, "#ffffff"); cg.addColorStop(1, "#c084fc");
      g.fillStyle = cg; g.beginPath(); g.arc(cx, cy, Math.max(2.5, 27 * k), 0, Math.PI * 2); g.fill();
      res[s] = c.toDataURL("image/png");
    }
    return res;
  })()`);
  const png = (s) => Buffer.from(out[s].split(",")[1], "base64");
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "hub.png"), png(256));
  fs.writeFileSync(path.join(OUT, "hub.ico"), ico(sizes.map((s) => ({ size: s, buf: png(s) }))));
  console.log("ícones gerados:", sizes.join(", "));
  app.exit(0);
});
