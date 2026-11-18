// Gera o ícone da Arasaka Central a partir de icons/logo.png: icons/hub.png (256) e icons/hub.ico (16-256).
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
  const logo = "data:image/png;base64," + fs.readFileSync(path.join(OUT, "logo.png")).toString("base64");
  const out = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image(); img.src = ${JSON.stringify(logo)}; await img.decode();
    const res = {};
    for (const s of ${JSON.stringify(sizes)}) {
      const c = document.createElement("canvas"); c.width = c.height = s;
      const g = c.getContext("2d"); g.imageSmoothingQuality = "high";
      // disco preto por dentro do anel da logo; a margem transparente da imagem é aproveitada
      const m = s * -0.03, d = s - 2 * m;
      g.fillStyle = "#050505"; g.beginPath(); g.arc(s / 2, s / 2, s * 0.49, 0, Math.PI * 2); g.fill();
      g.drawImage(img, m, m, d, d);
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
