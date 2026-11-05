// ── 图组装：实体关系 + 人格节点 + 记忆挂载 → 给客户端的图数据 ──────────
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { entitiesFile, memDir, nebulaDir, sideSlug } from "./paths.js";

const KIND_MAP = { user: "preference", feedback: "fact", project: "episode", reference: "fact" };

// 节点目录文件名安全化（E:\Altium 之类带非法字符的名字要清洗），与 build-contexts.mjs 保持一致
export function safeFileName(name) {
  return (name || "").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || "unnamed";
}

// ── entities.json 读写 ────────────────────────────────────────────────
export function readEntities() {
  const file = entitiesFile();
  if (!existsSync(file)) return { version: 1, entities: [], edges: [], memoryEntities: { host: {}, qq: {} } };
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeEntities(data) {
  mkdirSync(nebulaDir(), { recursive: true });
  writeFileSync(entitiesFile(), JSON.stringify(data, null, 2) + "\n", "utf8");
}

// ── 图组装 ────────────────────────────────────────────────────────────
export function buildGraph(entitiesData, hostRecords, qqRecords) {
  const ENTITY = entitiesData.entities;
  const EDGE = entitiesData.edges;
  const HOST_MAP = entitiesData.memoryEntities.host;
  const QQ_MAP = entitiesData.memoryEntities.qq;

  const degree = new Map();
  for (const e of EDGE) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }
  const memEntCount = new Map();
  for (const [records, map] of [[hostRecords, HOST_MAP], [qqRecords, QQ_MAP]]) {
    for (const rec of records) {
      for (const id of map[rec.name] ?? []) memEntCount.set(id, (memEntCount.get(id) ?? 0) + 1);
    }
  }

  const nodes = ENTITY.map((e) => ({
    id: e.id,
    name: e.name,
    type: e.type,
    side: e.side,
    core: e.core === true,
    degree: (degree.get(e.id) ?? 0) + (memEntCount.get(e.id) ?? 0),
    iso: (degree.get(e.id) ?? 0) === 0,
    // 节点目录文件（目录与正文分离，正文在 ~/.dsh/memory/）；文件名带 id 前缀防同名覆盖
    contextFile: join(nebulaDir(), "contexts", `${e.id}-${safeFileName(e.name)}.md`),
  }));

  // ── 人格条目：拆成图上的节点，挂在「人格」中枢下，中枢连两个核心 ──
  const PERSONA_HUB_ID = 199;
  const PERSONA_BASE_ID = 200;
  const personaNodes = [];
  const personaEdges = [];
  try {
    const pf = join(nebulaDir(), "persona.json");
    if (existsSync(pf)) {
      const sections = JSON.parse(readFileSync(pf, "utf8")).sections ?? [];
      if (sections.length > 0) {
        personaNodes.push({
          id: PERSONA_HUB_ID, name: "人格", type: "persona", side: "shared",
          core: false, degree: sections.length + 2, iso: false, contextFile: "",
          content: `${sections.length} 条人格设定，来自 persona.json`,
        });
        sections.forEach((s, i) => {
          const nid = PERSONA_BASE_ID + i;
          personaNodes.push({
            id: nid, name: s.title, type: "persona", side: "shared",
            core: false, degree: 1, iso: false, contextFile: "",
            content: s.content || "", category: s.category || "",
          });
          personaEdges.push({ src: PERSONA_HUB_ID, dst: nid, kind: "relation", label: s.category || "人格", weight: 0.6 });
        });
        personaEdges.push({ src: PERSONA_HUB_ID, dst: 1, kind: "relation", label: "属于", weight: 1.0 }); // 主工作区核心
        personaEdges.push({ src: PERSONA_HUB_ID, dst: 2, kind: "relation", label: "属于", weight: 1.0 }); // 次工作区核心
      }
    }
  } catch { /* 人格数据缺失不影响主图 */ }

  function buildMemories(records, map, side) {
    const slug = sideSlug(side);
    // 核心实体（id 1/2）存在时才把「没挂实体的记忆」默认挂到核心上；
    // 空白框架下没有核心，就不硬挂（否则边会指向不存在的节点）
    const coreId = side === "host" ? 1 : 2;
    const hasCore = ENTITY.some((e) => e.id === coreId);
    return records.map((rec, i) => {
      const ents = map[rec.name] ?? [];
      return {
        id: side === "host" ? i + 1 : 1000 + i + 1,
        name: rec.name,                       // 记忆名，可用 memory_read 直接调取
        file: slug ? join(memDir(slug), rec.name + ".md") : "", // 保存地点（文件路径）
        text: rec.description || rec.body.slice(0, 120),
        kind: KIND_MAP[rec.type] ?? "episode",
        importance: rec.type === "user" ? 0.9 : rec.type === "feedback" ? 0.8 : 0.6,
        created_at: Math.floor(Number(rec.created) / 1000) || Math.floor(Date.now() / 1000),
        entities: ents.length > 0 ? ents : (hasCore ? [coreId] : []),
        side,
      };
    });
  }

  const memories = [
    ...buildMemories(hostRecords, HOST_MAP, "host"),
    ...buildMemories(qqRecords, QQ_MAP, "qq"),
  ];

  const allNodes = [...nodes, ...personaNodes];
  const allEdges = [...EDGE, ...personaEdges];

  return {
    meta: {
      generated: new Date().toISOString(),
      source: "两端记忆（host + qq）+ 人格条目",
      memoryCount: memories.length,
      nodeCount: allNodes.length,
      edgeCount: allEdges.length,
    },
    nodes: allNodes,
    edges: allEdges,
    memories,
  };
}

// ── 节点目录文件（目录与正文分离；目录是索引，正文在 ~/.dsh/memory/）──
const CTX_SIDE_CN = { host: "主工作区", qq: "次工作区", shared: "共享" };
const CTX_TYPE_CN = { person: "人", thing: "物", topic: "话题", place: "地点", skill: "技能" };

export function buildContextsFiles(entitiesData, hostRecords, qqRecords) {
  const contextsDir = join(nebulaDir(), "contexts");
  mkdirSync(contextsDir, { recursive: true });
  const now = new Date().toISOString();

  // 记忆名 -> 记录（附带 side 与正本路径）
  const memByName = new Map();
  for (const [records, side] of [[hostRecords, "host"], [qqRecords, "qq"]]) {
    const slug = sideSlug(side);
    for (const r of records) {
      memByName.set(r.name, { ...r, side, file: slug ? join(memDir(slug), r.name + ".md") : "" });
    }
  }

  // 实体 id -> 关联记忆名
  const entityToMems = new Map();
  const rels = [["host", entitiesData.memoryEntities.host || {}], ["qq", entitiesData.memoryEntities.qq || {}]];
  for (const [, rel] of rels) {
    for (const [memName, ids] of Object.entries(rel)) {
      for (const id of ids) {
        if (!entityToMems.has(id)) entityToMems.set(id, new Set());
        entityToMems.get(id).add(memName);
      }
    }
  }

  const summary = [];
  for (const ent of entitiesData.entities) {
    const memNames = entityToMems.get(ent.id) || new Set();
    const listed = [...memNames].map((n) => memByName.get(n)).filter(Boolean);

    const lines = [];
    lines.push("# 节点：" + ent.name);
    lines.push("");
    lines.push("> 类型：" + (CTX_TYPE_CN[ent.type] || ent.type) + "（" + ent.type + "） · 阵营：" +
      (CTX_SIDE_CN[ent.side] || ent.side) + (ent.core ? " · **核心**" : ""));
    lines.push("> 关联记忆：" + listed.length + " 条");
    lines.push("> 生成时间：" + now);
    lines.push("");
    if (listed.length === 0) {
      lines.push("_（这个节点目前还没有挂载记忆）_");
    } else {
      lines.push("## 关联记忆");
      for (const m of listed) {
        lines.push("");
        lines.push("### " + m.name);
        if (m.description) lines.push("**描述**：" + m.description);
        lines.push("**正本**：`" + m.file + "`");
        lines.push("**阵营**：" + (CTX_SIDE_CN[m.side] || m.side) + " · **类型**：" + m.type);
      }
    }
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("*本文件是自动生成的「目录索引」，不复制正文。记忆正本在 `~/.dsh/memory/`。*");
    lines.push("");

    // 文件名带 id 前缀：两侧可能出现同名节点，加 id 前缀避免互相覆盖
    const fileName = `${ent.id}-${safeFileName(ent.name)}.md`;
    writeFileSync(join(contextsDir, fileName), lines.join("\n"), "utf8");
    summary.push({ name: ent.name, fileName, count: listed.length, core: ent.core === true });
  }

  // 总索引
  summary.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const idx = [];
  idx.push("# 记忆星云 · 节点目录总索引");
  idx.push("");
  idx.push("> 每个节点一个目录文件，目录只做索引，正文在 `~/.dsh/memory/`。");
  idx.push("> 生成时间：" + now + " · 节点 " + summary.length + " 个");
  idx.push("");
  idx.push("| 节点 | 关联记忆 | 文件 |");
  idx.push("|---|---:|---|");
  for (const s of summary) idx.push("| " + s.name + (s.core ? " ★" : "") + " | " + s.count + " | `" + s.fileName + "` |");
  idx.push("");
  writeFileSync(join(contextsDir, "INDEX.md"), idx.join("\n"), "utf8");

  return summary.length;
}
