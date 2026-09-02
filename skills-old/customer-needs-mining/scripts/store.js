#!/usr/bin/env node
/**
 * 群消息存储工具 — customer-needs-mining skill 的数据层
 *
 * 用法:
 *   node scripts/store.js insert <群名> <群ID> <发送者> <消息内容> <时间>
 *   node scripts/store.js query <群名> [--days=7] [--sender=张三] [--limit=200]
 *   node scripts/store.js group <群名>           # 显示群信息
 *   node scripts/store.js list                   # 列出所有群
 *   node scripts/store.js senders <群名>          # 列出群内发言者
 *   node scripts/store.js cleanup --days=7        # 清理旧数据
 *   node scripts/store.js stats <群名> [--days=7] # 统计信息
 *
 * 存储路径: <workspace>/skills/customer-needs-mining/data/
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================================================================
// 命令行解析
// ============================================================================

const args = process.argv.slice(2);
const cmd = args[0];
const flags = {};
const positional = [];

for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    if (eq > -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      flags[a.slice(2)] = args[++i] || "true";
    }
  } else {
    positional.push(a);
  }
}

// ============================================================================
// 数据文件操作
// ============================================================================

function safeName(name) {
  return name.replace(/[<>:"/\\|?*]/g, "_").trim() || "unknown";
}

function groupFile(groupName) {
  return path.join(DATA_DIR, `group_${safeName(groupName)}.json`);
}

function readGroup(groupName) {
  const fp = groupFile(groupName);
  if (!fs.existsSync(fp)) return [];
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return [];
  }
}

function writeGroup(groupName, messages) {
  const fp = groupFile(groupName);
  fs.writeFileSync(fp, JSON.stringify(messages, null, 2), "utf-8");
}

// ============================================================================
// 命令处理
// ============================================================================

function cmdInsert() {
  // store.js insert <群名> <群ID> <发送者> <发送者名> <消息内容> <时间>
  const [groupName, groupId, sender, senderName, content, msgtime] = positional;
  if (!groupName || !groupId || !sender || !content || !msgtime) {
    console.error("用法: store.js insert <群名> <群ID> <发送者> <发送者名> <消息内容> <时间>");
    process.exit(1);
  }

  const messages = readGroup(groupName);
  messages.push({
    msgid: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    roomid: groupId,
    roomname: groupName,
    sender,
    sender_name: senderName || sender,
    msgtype: "text",
    content,
    msgtime,
  });

  // 只保留最近 7 天
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 19);
  const filtered = messages.filter((m) => m.msgtime >= cutoff);

  writeGroup(groupName, filtered);
  console.log(JSON.stringify({ ok: true, count: filtered.length }));
}

function cmdQuery() {
  const [groupName] = positional;
  const days = parseInt(flags.days || "7");
  const sender = flags.sender;
  const limit = parseInt(flags.limit || "200");
  const offset = parseInt(flags.offset || "0");

  if (!groupName) {
    console.error("用法: store.js query <群名> [--days=7] [--sender=xxx] [--limit=200]");
    process.exit(1);
  }

  let messages = readGroup(groupName);

  // 时间筛选
  if (days > 0) {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 19);
    messages = messages.filter((m) => m.msgtime >= cutoff);
  }

  // 发送者筛选
  if (sender) {
    messages = messages.filter(
      (m) => m.sender === sender || m.sender_name === sender || m.sender_name.includes(sender),
    );
  }

  // 排序：时间升序
  messages.sort((a, b) => (a.msgtime > b.msgtime ? 1 : -1));

  const total = messages.length;
  const page = messages.slice(offset, offset + limit);

  console.log(JSON.stringify({
    groupName,
    total,
    offset,
    limit,
    has_more: offset + limit < total,
    messages: page,
  }, null, 2));
}

function cmdList() {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith("group_") && f.endsWith(".json"));

  const groups = files.map((f) => {
    const name = f.replace(/^group_/, "").replace(/\.json$/, "");
    const msgs = readGroup(name);
    return {
      name,
      msg_count: msgs.length,
      last_msg_time: msgs.length > 0 ? msgs[msgs.length - 1].msgtime : null,
    };
  }).filter((g) => g.msg_count > 0)
    .sort((a, b) => (b.last_msg_time || "").localeCompare(a.last_msg_time || ""));

  console.log(JSON.stringify({ total: groups.length, groups }, null, 2));
}

function cmdSenders() {
  const [groupName] = positional;
  if (!groupName) {
    console.error("用法: store.js senders <群名>");
    process.exit(1);
  }

  const messages = readGroup(groupName);
  const map = {};
  for (const m of messages) {
    const key = m.sender;
    if (!map[key]) {
      map[key] = { sender: m.sender, sender_name: m.sender_name, msg_count: 0, last_msg_time: m.msgtime };
    }
    map[key].msg_count++;
    if (m.msgtime > map[key].last_msg_time) map[key].last_msg_time = m.msgtime;
  }

  const senders = Object.values(map).sort((a, b) => b.msg_count - a.msg_count);
  console.log(JSON.stringify({ groupName, total_senders: senders.length, senders }, null, 2));
}

function cmdCleanup() {
  const days = parseInt(flags.days || "7");
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 19);

  const files = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith("group_") && f.endsWith(".json"));
  let totalRemoved = 0;

  for (const f of files) {
    const groupName = f.replace(/^group_/, "").replace(/\.json$/, "");
    const msgs = readGroup(groupName);
    const before = msgs.length;
    const filtered = msgs.filter((m) => m.msgtime >= cutoff);
    const removed = before - filtered.length;

    if (removed > 0) {
      totalRemoved += removed;
      if (filtered.length === 0) {
        fs.unlinkSync(groupFile(groupName));
      } else {
        writeGroup(groupName, filtered);
      }
    }
  }

  console.log(JSON.stringify({ ok: true, removed: totalRemoved, cutoff }, null, 2));
}

function cmdStats() {
  const [groupName] = positional;
  const days = parseInt(flags.days || "7");

  if (!groupName) {
    console.error("用法: store.js stats <群名> [--days=7]");
    process.exit(1);
  }

  let messages = readGroup(groupName);
  if (days > 0) {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 19);
    messages = messages.filter((m) => m.msgtime >= cutoff);
  }

  const senders = {};
  for (const m of messages) {
    const key = m.sender;
    if (!senders[key]) senders[key] = { sender: m.sender, sender_name: m.sender_name, count: 0 };
    senders[key].count++;
  }

  const top = Object.values(senders).sort((a, b) => b.count - a.count).slice(0, 20);

  console.log(JSON.stringify({
    groupName,
    total_messages: messages.length,
    total_senders: Object.keys(senders).length,
    top_senders: top,
  }, null, 2));
}

// ============================================================================
// 路由
// ============================================================================

switch (cmd) {
  case "insert":  cmdInsert();  break;
  case "query":   cmdQuery();   break;
  case "list":    cmdList();    break;
  case "senders": cmdSenders(); break;
  case "cleanup": cmdCleanup(); break;
  case "stats":   cmdStats();   break;
  default:
    console.error(`未知命令: ${cmd}`);
    console.error("可用: insert | query | list | senders | cleanup | stats");
    process.exit(1);
}
