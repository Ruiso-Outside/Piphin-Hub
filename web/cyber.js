// Arasaka Central · efeitos "Cyberpunk": inicialização, barra de status, glitch nos títulos e transição de tela.
// Só visual. Liga e desliga no item "FX" da barra de status (ou Ctrl+Shift+F); a escolha fica salva neste PC.
(() => {
  const KEY = "cy-fx";
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sem armazenamento */ } },
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fxOn = () => !document.body.classList.contains("fx-off");
  const setFx = (on) => {
    document.body.classList.toggle("fx-off", !on);
    store.set(KEY, on ? "on" : "off");
    const b = document.getElementById("csFx");
    if (b) b.innerHTML = `FX <b>${on ? "ON" : "OFF"}</b>`;
    // a tela dos módulos fica acima da barra de status (que só aparece com os efeitos ligados)
    try { if (window.hub && hub.layout) hub.layout({ bottom: on ? 24 : 0 }); } catch { /* sem ponte */ }
  };
  document.body.classList.toggle("fx-off", store.get(KEY) === "off");

  // ---------------------------------------------------------------- inicialização (uma vez por abertura)
  function boot() {
    let seen = false;
    try { seen = sessionStorage.getItem("cy-boot") === "1"; sessionStorage.setItem("cy-boot", "1"); } catch { /* ok */ }
    if (seen || reduced || !fxOn()) return;
    const el = document.createElement("div");
    el.id = "cyBoot";
    el.innerHTML = `<img class="cb-logo" src="../icons/logo.png" alt=""><div class="cb-name">ARASAKA</div><div class="cb-kanji">荒坂産業</div>
      <div class="cb-log"></div><div class="cb-bar"><i></i></div>`;
    document.body.appendChild(el);
    const log = el.querySelector(".cb-log"), bar = el.querySelector(".cb-bar i");
    const hex = () => Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0").toUpperCase();
    const lines = [
      `> ARASAKA CORP // SUBNET ${hex()}`,
      "> AUTENTICANDO OPERADOR........... <span class=ok>OK</span>",
      "> CARREGANDO MÓDULOS.............. <span class=ok>OK</span>",
      `> CRIPTOGRAFIA ICE v7.${Math.floor(Math.random() * 9)}............ <span class=ok>ATIVA</span>`,
      "> LINK NEURAL ESTABELECIDO",
    ];
    let i = 0, done = false;
    const finish = () => {
      if (done) return; done = true;
      el.classList.add("out");
      setTimeout(() => el.remove(), 480);
    };
    const step = () => {
      if (done) return;
      if (i < lines.length) { log.innerHTML += (i ? "\n" : "") + lines[i]; i++; bar.style.width = `${(i / lines.length) * 100}%`; setTimeout(step, 190 + Math.random() * 120); }
      else setTimeout(finish, 260);
    };
    el.addEventListener("click", finish);
    addEventListener("keydown", finish, { once: true });
    setTimeout(step, 320);
  }

  // ---------------------------------------------------------------- barra de status
  function statusBar() {
    const bar = document.createElement("footer");
    bar.className = "cy-status";
    bar.innerHTML = `<span class="cs-tag">ARASAKA // ONLINE</span>
      <span class="cs-item" id="csClock"></span>
      <span class="cs-item" id="csMods"></span>
      <span class="cs-item" id="csNet"></span>
      <span class="cs-ticker"><span id="csTicker"></span></span>
      <button class="cs-item" id="csFx" title="Efeitos visuais (Ctrl+Shift+F)" style="background:none;border:0;border-left:1px solid var(--p-line);color:inherit;font:inherit;cursor:pointer"></button>
      <span class="cs-kanji">荒坂</span>`;
    document.body.appendChild(bar);
    const clock = bar.querySelector("#csClock"), mods = bar.querySelector("#csMods"), net = bar.querySelector("#csNet");
    const tick = () => {
      const d = new Date();
      clock.innerHTML = `T <b>${d.toLocaleTimeString("pt-BR")}</b>`;
      const n = document.querySelectorAll("#modNav .nav-item").length, on = document.querySelectorAll("#modNav .dot.ok").length;
      mods.innerHTML = `MÓD <b>${on}/${n}</b>`;
      net.innerHTML = `NET <b>${navigator.onLine ? "LINK" : "OFF"}</b>`;
    };
    tick(); setInterval(tick, 1000);
    const hex = () => Array.from({ length: 4 }, () => Math.floor(Math.random() * 65536).toString(16).padStart(4, "0").toUpperCase()).join(" ");
    const msgs = ["CORPO-SEC: NENHUMA INTRUSÃO DETECTADA", "NIGHT CITY // FAIXA 7 ESTÁVEL", "SAKURA TOWER // UPLINK ATIVO", "BLACKWALL: ÍNTEGRA",
      "DIVISÃO DE CONTRAINTELIGÊNCIA // MONITORANDO", "LEALDADE É LUCRO", "SAÚDE DO SISTEMA: NOMINAL"];
    const ticker = bar.querySelector("#csTicker");
    const fill = () => { ticker.textContent = msgs.sort(() => Math.random() - .5).map((m) => `${m}  ▲  0x${hex()}`).join("    ///    "); };
    fill(); ticker.addEventListener("animationiteration", fill);
    bar.querySelector("#csFx").addEventListener("click", () => setFx(!fxOn()));
    setFx(fxOn());
  }

  // ---------------------------------------------------------------- glitch nos títulos
  const GLITCH = ".hero h1, main h1, .tb-word";
  function tagGlitch(root = document) {
    for (const h of root.querySelectorAll(GLITCH)) {
      if (!h.classList.contains("cy-glitch")) h.classList.add("cy-glitch");
      if (h.dataset.text !== h.textContent) h.dataset.text = h.textContent;
    }
  }
  function glitch(h) {
    if (!h || !fxOn() || reduced) return;
    h.classList.remove("on"); void h.offsetWidth; h.classList.add("on");
    setTimeout(() => h.classList.remove("on"), 340);
  }
  function randomGlitch() {
    const list = [...document.querySelectorAll(".cy-glitch")].filter((h) => h.offsetParent);
    if (list.length) glitch(list[Math.floor(Math.random() * list.length)]);
    setTimeout(randomGlitch, 3500 + Math.random() * 5500);
  }
  document.addEventListener("mouseover", (e) => { const h = e.target.closest && e.target.closest(".cy-glitch"); if (h && !h.classList.contains("on")) glitch(h); });

  // ---------------------------------------------------------------- transição só quando a pessoa troca de tela
  let switching = false;
  document.addEventListener("click", (e) => { if (e.target.closest && e.target.closest("[data-view], [data-goto]")) switching = true; }, true);
  function watchMain() {
    const main = document.getElementById("main");
    if (!main) return;
    new MutationObserver(() => {
      tagGlitch(main);
      if (!switching) return;
      switching = false;
      main.classList.remove("cy-enter"); void main.offsetWidth; main.classList.add("cy-enter");
      setTimeout(() => main.classList.remove("cy-enter"), 500);
    }).observe(main, { childList: true });
  }

  addEventListener("keydown", (e) => { if (e.ctrlKey && e.shiftKey && (e.key === "F" || e.key === "f")) { e.preventDefault(); setFx(!fxOn()); } });
  // ícones no vermelho Arasaka: o brilho de cada pixel vira vermelho (hue-rotate do CSS puxa para rosa/laranja)
  function redFilter() {
    if (document.getElementById("cyRed")) return;
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "0"); svg.setAttribute("height", "0"); svg.setAttribute("aria-hidden", "true");
    svg.style.position = "absolute";
    const f = document.createElementNS(NS, "filter");
    f.id = "cyRed"; f.setAttribute("color-interpolation-filters", "sRGB");
    const m = document.createElementNS(NS, "feColorMatrix");
    m.setAttribute("type", "matrix");
    m.setAttribute("values", "0.45 1.5 0.15 0 0.03  0.03 0.10 0.01 0 0  0.03 0.10 0.01 0 0  0 0 0 1 0");
    f.appendChild(m); svg.appendChild(f); document.body.appendChild(svg);
  }
  const start = () => { redFilter(); boot(); statusBar(); tagGlitch(); watchMain(); setTimeout(randomGlitch, 2500); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
