#!/usr/bin/env node
require("dotenv").config();

const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 3000);
const CLOUDFLARED_BIN = process.env.CLOUDFLARED_BIN || "cloudflared";
const tunnelTarget = `http://localhost:${PORT}`;

let cloudflaredProcess = null;
let serverProcess = null;
let hasStartedServer = false;

function log(message) {
  console.log(`[dev:miniapp] ${message}`);
}

function pipeOutput(prefix, stream) {
  stream.on("data", (chunk) => {
    const lines = String(chunk).split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      console.log(`${prefix} ${line}`);
    }
  });
}

function shutdown(exitCode = 0) {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
  }
  if (cloudflaredProcess && !cloudflaredProcess.killed) {
    cloudflaredProcess.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 250);
}

function startServer(webAppUrl) {
  if (hasStartedServer) return;
  hasStartedServer = true;

  log(`WEBAPP_URL: ${webAppUrl}`);
  log("Запускаю сервер...");

  serverProcess = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      WEBAPP_URL: webAppUrl,
    },
    stdio: ["inherit", "pipe", "pipe"],
  });

  pipeOutput("[server]", serverProcess.stdout);
  pipeOutput("[server]", serverProcess.stderr);

  serverProcess.on("exit", (code) => {
    log(`Сервер завершился с кодом ${code ?? "unknown"}.`);
    shutdown(code ?? 0);
  });
}

function startTunnel() {
  log(`Поднимаю Cloudflare Tunnel -> ${tunnelTarget}`);

  cloudflaredProcess = spawn(
    CLOUDFLARED_BIN,
    ["tunnel", "--url", tunnelTarget, "--no-autoupdate"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  const onTunnelOutput = (chunk) => {
    const text = String(chunk);
    const lines = text.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      console.log(`[tunnel] ${line}`);

      const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) {
        startServer(match[0]);
      }
    }
  };

  cloudflaredProcess.stdout.on("data", onTunnelOutput);
  cloudflaredProcess.stderr.on("data", onTunnelOutput);

  cloudflaredProcess.on("error", (error) => {
    log(`Не удалось запустить cloudflared: ${error.message}`);
    log("Проверь, установлен ли cloudflared, или укажи путь в CLOUDFLARED_BIN.");
    shutdown(1);
  });

  cloudflaredProcess.on("exit", (code) => {
    if (!hasStartedServer) {
      log(`Tunnel завершился до получения HTTPS URL. Код: ${code ?? "unknown"}.`);
      shutdown(code ?? 1);
      return;
    }
    log("Tunnel остановлен.");
    shutdown(code ?? 0);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

startTunnel();
