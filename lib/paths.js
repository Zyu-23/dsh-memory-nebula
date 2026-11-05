// ── 路径与常量：动态发现记忆工作区，不硬编码任何路径 ──────────────────
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

// ── 记忆工作区发现 ────────────────────────────────────────────────────
// DSH 把每个工作区的记忆放在 ~/.dsh/memory/<slug>/ 下。
// 本插件自动扫描这些目录：第 1 个作为「主工作区」（host），第 2 个作为「次工作区」（qq）。
// 只有一个工作区时就是单星云；有两个时就是双星云。
let _sides = null;

function shortenSlug(slug) {
  // "--C-Users-alice-my-workspace--" → "my-workspace"
  const cleaned = String(slug || "").replace(/^-+|-+$/g, "");
  const parts = cleaned.split("-").filter(Boolean);
  return parts.slice(-2).join("-") || cleaned || slug;
}

// ── 工作区识别：多工作区必须各存各的状态，不能共用一个文件 ──────────
// 工作区路径 → DSH 记忆目录 slug（例：C:\a\b → --C-a-b--）
export function slugFromCwd(cwd) {
  if (!cwd) return null;
  const cleaned = String(cwd).replace(/[:\\/]+/g, "-").replace(/^-|-$/g, "");
  return cleaned ? `--${cleaned}--` : null;
}

// 会话 → 状态文件 key（从 agent.session.header.cwd 推导；拿不到则 null=退回全局）
export function sessionKey(agent) {
  const cwd = agent?.session?.header?.cwd ?? agent?.session?.cwd;
  const slug = slugFromCwd(cwd);
  return slug ? shortenSlug(slug) : null;
}

export function sides() {
  if (_sides) return _sides;
  const root = join(resolveDshHome(), "memory");
  const out = [];
  try {
    if (existsSync(root)) {
      const dirs = readdirSync(root)
        .filter((d) => {
          try {
            const p = join(root, d);
            if (!statSync(p).isDirectory()) return false;
            // 只认「有 md 记忆文件」的目录，排除空目录/其他杂项
            return readdirSync(p).some((f) => f.endsWith(".md") && f !== "MEMORY.md");
          } catch {
            return false;
          }
        })
        .sort();
      for (let i = 0; i < Math.min(2, dirs.length); i++) {
        out.push({
          slug: dirs[i],
          side: i === 0 ? "host" : "qq",
          label: shortenSlug(dirs[i]),
        });
      }
    }
  } catch { /* 发现失败按无工作区处理 */ }
  _sides = out;
  return out;
}

export function sideSlug(side) {
  const found = sides().find((s) => s.side === side);
  return found ? found.slug : null;
}

export function sideLabel(side) {
  const found = sides().find((s) => s.side === side);
  return found ? found.label : side;
}

// ── 运行时数据路径 ────────────────────────────────────────────────────
export const nebulaDir = () => join(resolveDshHome(), "memory-nebula");
export const entitiesFile = () => join(nebulaDir(), "entities.json");
export const memDir = (slug) => join(resolveDshHome(), "memory", slug);

// 插件自带的默认数据（首次安装时复制到 ~/.dsh/memory-nebula/，做到「下载即用」）
export const DEFAULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "defaults");

export function initDefaults() {
  try {
    mkdirSync(nebulaDir(), { recursive: true });
    for (const file of ["entities.json", "persona.json"]) {
      const target = join(nebulaDir(), file);
      if (existsSync(target)) continue; // 已有数据绝不覆盖
      const source = join(DEFAULTS_DIR, file);
      if (!existsSync(source)) continue;
      writeFileSync(target, readFileSync(source), "utf8");
    }
  } catch { /* 初始化失败不影响插件加载 */ }
}
