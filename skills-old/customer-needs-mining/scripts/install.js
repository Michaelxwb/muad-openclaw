#!/usr/bin/env node
"use strict";

var fs = require("fs");
var path = require("path");
var cp = require("child_process");

var HOME = process.env.HOME || process.env.USERPROFILE || "~";
var PLUGIN = path.join(HOME, ".openclaw", "npm", "node_modules", "@wecom", "wecom-openclaw-plugin");
var PROJECT = path.join(__dirname, "..");
var STORE = path.join(PROJECT, "scripts", "store.js");
var STORE_Q = JSON.stringify(STORE);

function log(m) { console.log("  " + m); }
function ok(m) { console.log("  ✔ " + m); }
function warn(m) { console.log("  ⚠ " + m); }
function die(m) { console.error("  ✘ " + m); process.exit(1); }

// ---------------------------------------------------------------------------
// 注入目标
// ---------------------------------------------------------------------------

// 目标 1: src/monitor.js - WebSocket 长连接模式的群消息入口
// 注入位置: wsClient.on("message" ...) 内，processWeComMessageNow(entry) 之前
// 变量 source: 函数体内 frame,target,account 可用
var WS_HOOK = [
  "",
  "        // ==== customer-needs-mining (auto) ====",
  "        try {",
  "          var _body = frame.body;",
  "          var _isGroup = (_body.chattype === \"group\");",
  "          if (_isGroup && _body.text && _body.text.content) {",
  "            var _script = " + STORE_Q + ";",
  "            var _esc = _body.text.content.replace(/\"/g, '\\\\\"');",
  "            var _cid = (_body.chatid || \"\").replace(/\"/g, \"\");",
  "            var _sn = ((_body.from && (_body.from.name || _body.from.userid)) || \"\").replace(/\"/g, \"\");",
  "            var _sid = (_body.from && _body.from.userid || \"\").replace(/\"/g, \"\");",
  "            var _ts = _body.msgtime || _body.CreateTime || String(Math.floor(Date.now() / 1000));",
  "            var _ft = new Date(parseInt(_ts) * 1000).toISOString().slice(0, 19).replace(\"T\", \" \");",
  "            var _args = [",
  "              JSON.stringify(_cid),  // roomname (先填 chatid, 后续可映射)",
  "              JSON.stringify(_cid),  // roomid",
  "              JSON.stringify(_sid),  // sender",
  "              JSON.stringify(_sn),   // sender_name",
  "              JSON.stringify(_esc),  // content",
  "              JSON.stringify(_ft),   // msgtime",
  "            ].join(\" \");",
  "            cp.execSync(\"node \" + _script + \" insert \" + _args, { timeout: 3000, stdio: \"pipe\" });",
  "          }",
  "        } catch (_e) { /* 入库静默失败 */ }",
  "        // ==== end hook ====",
  "",
].join("\n");

var TARGETS = [
  {
    name: "src/monitor.js (WebSocket 消息入口)",
    file: path.join(PLUGIN, "dist", "src", "monitor.js"),
    marker: "// 排队逻辑暂时关闭，直接处理消息",
    hook: WS_HOOK,
  },
];

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

function apply(t, dry) {
  if (!fs.existsSync(t.file)) { warn("跳过 " + t.name + " (文件不存在)"); return; }
  var raw = fs.readFileSync(t.file, "utf-8");
  if (raw.indexOf("customer-needs-mining") !== -1) { warn("跳过 " + t.name + " (已注入)"); return; }
  var pos = raw.indexOf(t.marker);
  if (pos === -1) { die("未找到注入点 " + t.name + " marker=" + t.marker.substring(0, 40)); }
  var lineEnd = raw.indexOf("\n", pos);
  if (dry) { ok(t.name + " 注入点已定位 (line ~" + raw.slice(0, pos).split("\n").length + ")"); return; }
  var bak = t.file + ".backup";
  if (!fs.existsSync(bak)) fs.copyFileSync(t.file, bak);
  fs.writeFileSync(t.file, raw.slice(0, lineEnd + 1) + t.hook + raw.slice(lineEnd + 1), "utf-8");
  ok(t.name + " 已注入");
}

function revert(t) {
  var bak = t.file + ".backup";
  if (!fs.existsSync(bak)) { warn("跳过 " + t.name + " (无备份)"); return; }
  fs.copyFileSync(bak, t.file);
  fs.unlinkSync(bak);
  ok(t.name + " 已还原");
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

var dry = process.argv.indexOf("--dry") !== -1;
var undo = process.argv.indexOf("--undo") !== -1 || process.argv.indexOf("--uninstall") !== -1;

if (undo) {
  console.log("\n🔧 customer-needs-mining - 卸载\n");
  for (var i = 0; i < TARGETS.length; i++) revert(TARGETS[i]);
  console.log("\n  卸载完成。openclaw gateway restart 生效。\n");
  process.exit(0);
}

console.log("\n🔧 customer-needs-mining - " + (dry ? "检查模式" : "安装") + "\n");
if (!fs.existsSync(PLUGIN)) die("未找到 wecom-openclaw-plugin, 请设置 WECOM_PLUGIN_ROOT");
ok("wecom-openclaw-plugin 已找到");
if (!dry) { var d = path.join(PROJECT, "data"); if (!fs.existsSync(d)) fs.mkdirSync(d); }
ok("data 目录: " + path.join(PROJECT, "data"));

for (var i = 0; i < TARGETS.length; i++) apply(TARGETS[i], dry);
if (dry) { console.log("\n干跑通过。\n"); process.exit(0); }

console.log("\n╔══════════════════════════════╗");
console.log("║  🎉 安装完成!                 ║");
console.log("║  openclaw gateway restart     ║");
console.log("║  拉机器人入群 → 自动记录      ║");
console.log("╚══════════════════════════════╝\n");
