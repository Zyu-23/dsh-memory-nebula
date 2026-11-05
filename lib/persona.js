// ── 状态 + 人格：都从 ~/.dsh/memory-nebula/ 读取，生成注入文本 ──────────
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nebulaDir } from "./paths.js";

// ── 状态：此刻正在做什么（按工作区隔离，换会话不丢，每轮注入）──────────
// key 来自 sessionKey(agent)（如 default-workspace / qq-chat）；null 表示退回全局单文件。
export function stateFile(key) {
  return key ? join(nebulaDir(), `state-${key}.json`) : join(nebulaDir(), "state.json");
}

export function readState(key) {
  try {
    // 先读本工作区状态；没有则读全局 state.json（兼容旧数据/单工作区）
    const candidates = key ? [stateFile(key), stateFile(null)] : [stateFile(null)];
    for (const f of candidates) {
      if (!existsSync(f)) continue;
      return JSON.parse(readFileSync(f, "utf8"));
    }
    return null;
  } catch {
    return null;
  }
}

export function writeState(obj, key) {
  mkdirSync(nebulaDir(), { recursive: true });
  writeFileSync(stateFile(key), JSON.stringify(obj, null, 2) + "\n", "utf8");
}

export function formatState(state) {
  if (!state || !state.current) return "";
  const since = state.since ? `（始于 ${state.since}）` : "";
  return `<memory_nebula_state>\n当前状态：${state.current}${since}\n更新时间：${state.updated || ""}\n</memory_nebula_state>`;
}

// ── 人格：从 persona.json 读取并生成注入文本（人格归插件管）──────────
export function readPersona() {
  try {
    const f = join(nebulaDir(), "persona.json");
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

export function formatPersona(persona) {
  if (!persona) return "";
  const lines = [];
  const dirs = Array.isArray(persona.directives) ? persona.directives : [];
  const sections = Array.isArray(persona.sections) ? persona.sections : [];
  if (dirs.length === 0 && sections.length === 0) return "";
  lines.push("<memory_nebula_persona>");
  lines.push("【人格 · 由记忆星云插件提供】");
  if (dirs.length > 0) {
    lines.push("## 指令块");
    lines.push(dirs.join("\n"));
  }
  if (sections.length > 0) {
    lines.push("## 人格描述");
    for (const s of sections) {
      lines.push(`- ${s.title}：${s.content}`);
    }
  }
  lines.push("</memory_nebula_persona>");
  return lines.join("\n");
}
