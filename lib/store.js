// ── 记忆存储：读写删（兼容 dsh-auto-memory 的 markdown + frontmatter 格式）──
// 格式与 auto-memory 逐字段一致，现有记忆不用迁移；文件位置也相同（~/.dsh/memory/<slug>/）。
// 注意：本版本**不做备份**——需要备份请自行向 DSH 提要求（或直接用 git/云盘同步记忆目录）。
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { memDir } from "./paths.js";

// ── 记忆读取 ──────────────────────────────────────────────────────────
export function parseMemory(raw, fallbackName) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2];
  }
  return {
    name: fm.name ?? fallbackName,
    type: fm.type ?? "unknown",
    description: fm.description ?? "",
    created: fm.created ?? "",
    body: (m[2] ?? "").trim(),
  };
}

export function loadMemories(slug) {
  if (!slug) return []; // 该工作区不存在
  const dir = memDir(slug);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md") || f === "MEMORY.md") continue;
    const rec = parseMemory(readFileSync(join(dir, f), "utf8"), f.replace(/\.md$/, ""));
    if (rec) {
      rec.file = join(dir, f); // 记忆正本绝对路径，注入时一并给模型
      out.push(rec);
    }
  }
  return out;
}

// ── 记忆存储 ──────────────────────────────────────────────────────────
export function serializeMemory(rec) {
  const fm = [];
  fm.push(`name: ${rec.name}`);
  fm.push(`description: ${rec.description}`);
  fm.push(`type: ${rec.type}`);
  if (rec.title) fm.push(`title: ${rec.title}`);
  if (rec.importance !== undefined) fm.push(`importance: ${rec.importance}`);
  fm.push(`created: ${rec.created}`);
  fm.push(`updated: ${rec.updated}`);
  const head = `---\n${fm.join("\n")}\n---\n\n`;
  return head + (rec.body ?? "") + "\n";
}

export function writeMemory(rec, slug) {
  const dir = memDir(slug);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, rec.name + ".md");
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  writeFileSync(tmp, serializeMemory(rec), "utf8"); // 先写临时文件，再原子替换，崩溃不留半截文件
  renameSync(tmp, file);
  return file;
}

export function readMemory(name, slug) {
  if (!slug) return null;
  const file = join(memDir(slug), name + ".md");
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8");
    const rec = parseMemory(raw, name);
    if (!rec) return null;
    rec.file = file;
    rec.raw = raw;
    return rec;
  } catch {
    return null;
  }
}

export function deleteMemory(name, slug) {
  if (!slug) return false;
  const file = join(memDir(slug), name + ".md");
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

// 记忆名归一化（kebab-case，和 auto-memory 一致）
export function normalizeMemoryName(input) {
  return String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
