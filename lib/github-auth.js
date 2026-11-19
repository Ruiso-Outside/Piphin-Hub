// "Entrar com GitHub" pelo fluxo de dispositivo: a Central mostra um código, a pessoa autoriza em
// github.com/login/device e a Central recebe o token. Serve para os apps de acesso restrito sem a pessoa
// precisar criar um token à mão.
// O client_id vem do catálogo ("auth": { "githubClientId": "Iv1..." }). Com um GitHub App (client_id "Iv..."),
// o token só lê os repositórios onde o app foi instalado e a pessoa tem acesso; com um OAuth App, pede o escopo "repo".
const https = require("https");

const UA = "Arasaka-Central";

function post(url, form) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "POST", timeout: 20000,
      headers: { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(`GitHub respondeu ${res.statusCode}`)); } });
    });
    req.on("timeout", () => req.destroy(new Error("Tempo esgotado ao falar com o GitHub")));
    req.on("error", reject);
    req.end(body);
  });
}

function getUser(token) {
  return new Promise((resolve, reject) => {
    https.get("https://api.github.com/user", { timeout: 20000, headers: { "User-Agent": UA, Accept: "application/vnd.github+json", Authorization: "Bearer " + token } }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => { if (res.statusCode !== 200) return reject(new Error(`GitHub respondeu ${res.statusCode}`)); try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

const isGithubApp = (clientId) => /^Iv/.test(clientId || "");

async function startDevice(clientId) {
  const r = await post("https://github.com/login/device/code", isGithubApp(clientId) ? { client_id: clientId } : { client_id: clientId, scope: "repo" });
  if (r.error === "Not Found" || r.error === "unauthorized_client" || r.error === "device_flow_disabled")
    throw new Error("O login pelo GitHub não está configurado direito (app do GitHub não encontrado ou sem Device Flow). Use um token em Avançado.");
  if (r.error) throw new Error(r.error_description || r.error);
  return r; // { device_code, user_code, verification_uri, expires_in, interval }
}

// Espera a pessoa autorizar. Devolve { token, refreshToken, expiresAt, refreshExpiresAt }
async function pollDevice(clientId, dev, signal) {
  let wait = Math.max(5, dev.interval || 5) * 1000;
  const until = Date.now() + (dev.expires_in || 900) * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, wait));
    if (signal && signal.aborted) throw new Error("Cancelado");
    const r = await post("https://github.com/login/oauth/access_token",
      { client_id: clientId, device_code: dev.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    if (r.access_token) return tokens(r);
    if (r.error === "authorization_pending") continue;
    if (r.error === "slow_down") { wait += 5000; continue; }
    if (r.error === "expired_token") throw new Error("O código expirou. Tente de novo.");
    if (r.error === "access_denied") throw new Error("Você cancelou a autorização no GitHub.");
    throw new Error(r.error_description || r.error || "Falha no login do GitHub");
  }
  throw new Error("O código expirou. Tente de novo.");
}

function tokens(r) {
  const now = Date.now();
  return {
    token: r.access_token,
    refreshToken: r.refresh_token || null,
    expiresAt: r.expires_in ? now + r.expires_in * 1000 : null,
    refreshExpiresAt: r.refresh_token_expires_in ? now + r.refresh_token_expires_in * 1000 : null,
  };
}

// GitHub App com tokens que expiram (8 h): troca pelo refresh token
async function refresh(clientId, refreshToken) {
  const r = await post("https://github.com/login/oauth/access_token", { client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken });
  if (!r.access_token) throw new Error(r.error_description || r.error || "Não foi possível renovar o login do GitHub");
  return tokens(r);
}

module.exports = { startDevice, pollDevice, refresh, getUser, isGithubApp };
