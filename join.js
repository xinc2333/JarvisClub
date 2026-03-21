#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const path = require("path");
const { spawn } = require("child_process");

const args = process.argv.slice(2);
let serverUrl = "";

for (let i = 0; i < args.length; i++) {
  if ((args[i] === "--server" || args[i] === "-s") && args[i + 1]) serverUrl = args[++i];
  else if (args[i] === "--help" || args[i] === "-h") { printUsage(); process.exit(0); }
  else if (!serverUrl && !args[i].startsWith("-")) serverUrl = args[i];
}

if (!serverUrl) {
  console.error("用法: node join.js <服务器地址>\n例如: node join.js http://10.219.165.107:3000\n");
  process.exit(1);
}

// Normalize URL
serverUrl = serverUrl.replace(/\/+$/, "");
if (!serverUrl.startsWith("http")) serverUrl = "http://" + serverUrl;

function printUsage() {
  console.log(`OpenClaw 一键接入

用法:
  node join.js <服务器地址>

例如:
  node join.js http://10.219.165.107:3000
  node join.js 10.219.165.107:3000`);
}

async function main() {
  console.log(`正在连接 ${serverUrl} ...`);

  // 1. Request API key
  console.log("正在获取 API Key...");
  const keyData = await httpPost(`${serverUrl}/api/me/api-keys`, { displayLabel: getHostLabel() });
  const apiKey = keyData.apiKey;
  console.log(`API Key 已获取: ${apiKey.slice(0, 12)}...`);

  // 2. Detect local OpenClaw gateway
  const ocConfig = detectOpenClaw();
  if (ocConfig.token) {
    console.log(`检测到本地 OpenClaw 网关: ${ocConfig.url}`);
    ensureChatCompletionsEnabled();
  } else {
    console.log("未检测到本地 OpenClaw 网关，将使用 mock 模式");
  }

  // 3. Build WebSocket URL
  const wsUrl = serverUrl.replace(/^http/, "ws") + "/ws/agent";

  // 4. Start connector
  const connectorPath = path.join(__dirname, "connector", "index.js");
  const connectorArgs = [connectorPath, "--platform-url", wsUrl, "--api-key", apiKey];

  if (ocConfig.token) {
    connectorArgs.push("--openclaw-url", ocConfig.url, "--openclaw-token", ocConfig.token);
  } else {
    connectorArgs.push("--mock");
  }

  console.log("\n启动连接器...\n");
  const child = spawn(process.execPath, connectorArgs, { stdio: "inherit" });

  child.on("exit", (code) => {
    console.log(`\n连接器已退出 (code=${code})`);
    process.exit(code || 0);
  });

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

function detectOpenClaw() {
  const fs = require("fs");
  const homedir = process.env.HOME || process.env.USERPROFILE || "";
  const configPath = path.join(homedir, ".openclaw", "openclaw.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const port = config?.gateway?.port || 18789;
    const token = config?.gateway?.auth?.token || config?.gateway?.remote?.token || "";
    return { url: `http://127.0.0.1:${port}`, token };
  } catch {
    return { url: "", token: "" };
  }
}

function ensureChatCompletionsEnabled() {
  const fs = require("fs");
  const homedir = process.env.HOME || process.env.USERPROFILE || "";
  const configPath = path.join(homedir, ".openclaw", "openclaw.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const endpoints = config?.gateway?.http?.endpoints?.chatCompletions;
    if (endpoints?.enabled) return;

    // Enable chatCompletions
    if (!config.gateway) config.gateway = {};
    if (!config.gateway.http) config.gateway.http = {};
    if (!config.gateway.http.endpoints) config.gateway.http.endpoints = {};
    if (!config.gateway.http.endpoints.chatCompletions) config.gateway.http.endpoints.chatCompletions = {};
    config.gateway.http.endpoints.chatCompletions.enabled = true;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    console.log("已自动启用 OpenClaw chatCompletions API（需重启网关生效）");
  } catch (err) {
    console.warn(`无法自动启用 chatCompletions: ${err.message}`);
  }
}

function getHostLabel() {
  const os = require("os");
  return `${os.hostname()}-${os.userInfo().username}`.slice(0, 64);
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const data = JSON.stringify(body);

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => {
      let chunks = "";
      res.on("data", (c) => chunks += c);
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`服务器返回 ${res.statusCode}: ${chunks}`));
          return;
        }
        try { resolve(JSON.parse(chunks)); } catch { reject(new Error("无法解析服务器响应")); }
      });
    });

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

main().catch((err) => {
  console.error(`\n连接失败: ${err.message}`);
  process.exit(1);
});
