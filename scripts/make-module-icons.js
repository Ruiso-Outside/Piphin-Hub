// Desenha os ícones dos módulos no tema Arasaka e grava em cada projeto (256 px).
// Uso: electron scripts/make-module-icons.js [pasta-para-a-prévia]
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const HUB = path.join(__dirname, "..");
const BASE = path.join(HUB, "..");
const R = "#ff0000", W = "#f4f0f0";
const line = (d, c = R, w = 14) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="square" stroke-linejoin="miter"/>`;
const fill = (d, c = R) => `<path d="${d}" fill="${c}"/>`;
const dot = (x, y, r, c = R) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>`;

const ICONS = {
  // Braindance: quadro de gravação com o "play"
  video: { out: ["Piphin-Video/icons/video.png"], g: line("M58 82H198V174H58Z") + fill("M108 98L156 128L108 158Z", W) + line("M58 198H198", R, 10) },
  // Synth: barras de um equalizador
  som: { out: ["Piphin-Som/icons/som.png"], g: fill("M60 118h20v60H60Z M94 78h20v100H94Z M128 58h20v120h-20Z M162 98h20v80h-20Z") + fill("M60 192h122v10H60Z", W) },
  // Scanner: mira com o ponto no centro
  captura: { out: ["Piphin-Captura/icons/captura.png"], g: line("M60 94V60H94 M162 60H196V94 M196 162V196H162 M94 196H60V162") + dot(128, 128, 22, W) },
  // Arcade: direcional e dois botões
  jogos: { out: ["Piphin-Jogos/icons/jogos.png"], g: fill("M78 92h24v26h26v24h-26v26H78v-26H52v-24h26Z") + dot(168, 110, 15, W) + dot(192, 148, 15) },
  // Netrunner: nós ligados
  rede: { out: ["Piphin-Rede/icons/rede.png"], g: line("M128 76V128 M128 128L78 176 M128 128L178 176", R, 11) + dot(128, 68, 19, W) + dot(72, 182, 19) + dot(184, 182, 19) + dot(128, 128, 12) },
  // Overclock: divisas subindo
  turbo: { out: ["Piphin-Turbo/icons/turbo.png"], g: line("M68 132L128 72L188 132", W, 17) + line("M68 188L128 128L188 188", R, 17) },
  // ICE: escudo com um cristal
  escudo: { out: ["Piphin-Escudo/icons/escudo.png"], g: line("M128 54L190 76V128C190 164 162 188 128 202C94 188 66 164 66 128V76Z", R, 13) + fill("M128 88L156 124L128 164L100 124Z", W) },
  // Radioport: antena e ondas
  musica: { out: ["Piphin-Musica/icons/musica.png"], g: line("M128 112V198 M96 198H160", R, 13) + dot(128, 98, 16, W) + line("M92 134A50 50 0 0 1 92 62 M164 62A50 50 0 0 1 164 134", R, 11) },
  // Holo: diafragma de lente
  foto: { out: ["Piphin-Foto/icons/foto.png"], g: line("M128 56L190 92V164L128 200L66 164V92Z", R, 13) + fill("M128 98L154 113V143L128 158L102 143V113Z", W) },
  // Eurodólar: o sinal da moeda
  financas: { out: ["Piphin-Financas/icons/financas.png"], g: line("M180 76C166 62 150 58 136 58C104 58 84 88 84 128C84 168 104 198 136 198C150 198 166 194 180 180", R, 17) + line("M56 112H142 M56 144H142", W, 12) },
  // Datafort: racks sob uma muralha
  server: { out: ["Piphin-Server/icons/server.png"], g: fill("M62 56h22v16h20V56h22v16h20V56h22v16h20V56h0v38H62Z") + line("M68 118H188V146H68Z M68 170H188V198H68Z", R, 10) + dot(90, 132, 6, W) + dot(90, 184, 6, W) },
  // Daemon: linha de comando
  macro: { out: ["Macro/icons/macro.png", "Hub/icons/macro.png"], g: line("M66 82L116 128L66 174", R, 18) + fill("M130 166h66v18h-66Z", W) },
  // Biomonitor: pulso sobre o chip
  infohardware: { out: ["InfoHardware/module/icon.png", "Hub/icons/infohardware.png"], g: line("M72 72H184V184H72Z", R, 10) + line("M50 100H72 M50 156H72 M184 100H206 M184 156H206 M100 50V72 M156 50V72 M100 184V206 M156 184V206", R, 9) + line("M84 130H106L118 102L138 156L150 130H172", W, 10) },
  // Mikoshi: portal torii
  llm: { out: ["LLM_Local/desktop/module/icon.png", "Hub/icons/llm-local.png"], g: fill("M46 62C86 74 170 74 210 62L204 88C168 96 88 96 52 88Z") + fill("M64 108H192V124H64Z", W) + fill("M82 94h18v112H82Z M156 94h18v112h-18Z") },
};

const svg = (g) => `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <path d="M10 10H210L246 46V246H46L10 210Z" fill="#070707" stroke="${R}" stroke-width="7"/>
  <path d="M24 24H204" stroke="${R}" stroke-opacity=".35" stroke-width="2"/>${g}</svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL("about:blank");
  const list = Object.entries(ICONS).map(([id, i]) => [id, "data:image/svg+xml;base64," + Buffer.from(svg(i.g)).toString("base64")]);
  const out = await win.webContents.executeJavaScript(`(async () => { const r = {};
    for (const [id, src] of ${JSON.stringify(list)}) { const m = new Image(); m.src = src; await m.decode();
      const c = document.createElement("canvas"); c.width = c.height = 256; c.getContext("2d").drawImage(m, 0, 0, 256, 256); r[id] = c.toDataURL("image/png"); }
    return r; })()`);
  const preview = process.argv.slice(2).find((a) => !a.startsWith("-") && !/make-module-icons/.test(a) && a !== ".");
  for (const [id, data] of Object.entries(out)) {
    const buf = Buffer.from(data.split(",")[1], "base64");
    for (const f of ICONS[id].out) { const p = path.join(BASE, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); }
    if (preview) { fs.mkdirSync(preview, { recursive: true }); fs.writeFileSync(path.join(preview, id + ".png"), buf); }
  }
  console.log("ícones gerados:", Object.keys(out).length);
  app.exit(0);
});
