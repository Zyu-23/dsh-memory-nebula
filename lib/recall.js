// ── 「查」：动态检索（四路打分：关键词 + 图谱 + 重要性 + 新鲜度）──────────
// 参照 memory-brain 的五路混合，先做四路（向量留到后面接 embedding 再补）。
// 权重按「中文短 query 下关键词更可靠」的实测经验给关键词最高。
import { sideSlug } from "./paths.js";
import { loadMemories } from "./store.js";
import { readEntities } from "./graph.js";

const TYPE_WEIGHT = { user: 0.9, feedback: 0.85, project: 0.65, reference: 0.55, unknown: 0.4 };
const RECENCY_HALF_LIFE_DAYS = 14;

export function tokenize(text) {
  const lower = String(text || "").toLowerCase();
  const tokens = new Set();
  for (const w of lower.split(/[^a-z0-9_+#.\-]+/)) {
    if (w.length >= 2) tokens.add(w);
  }
  for (const seg of lower.split(/[^\u4e00-\u9fa5]+/)) {
    // 中文 bigram：不依赖分词也能覆盖大部分短 query
    if (seg.length === 1) tokens.add(seg);
    for (let i = 0; i + 1 < seg.length; i++) tokens.add(seg.slice(i, i + 2));
  }
  return [...tokens];
}

export function recall(query, opts = {}) {
  const topN = opts.topN ?? 5;
  const q = String(query || "").trim();
  if (q.length === 0) return [];
  const qTokens = tokenize(q);
  if (qTokens.length === 0) return [];

  const entitiesData = readEntities();
  const hostMems = loadMemories(sideSlug("host"));
  const qqMems = loadMemories(sideSlug("qq"));
  const qLower = q.toLowerCase();

  // 图谱那一路：query 里直接点名的实体
  const hitEntityIds = new Set();
  for (const e of entitiesData.entities) {
    const nm = String(e.name || "").toLowerCase();
    if (nm.length >= 2 && qLower.includes(nm)) hitEntityIds.add(e.id);
  }

  const memEntityMap = new Map();
  for (const map of [entitiesData.memoryEntities.host, entitiesData.memoryEntities.qq]) {
    for (const [name, ids] of Object.entries(map)) memEntityMap.set(name, ids);
  }

  // IDF：先统计每个 token 出现在多少条记忆里，泛词（老大/表情包这种到处都有的）降权
  const allMems = [...hostMems, ...qqMems];
  const df = new Map();
  for (const rec of allMems) {
    const toks = new Set(tokenize(`${rec.name} ${rec.description} ${rec.body}`));
    for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = Math.max(1, allMems.length);
  const idfOf = (t) => Math.log((N + 1) / ((df.get(t) ?? 1) + 1)) + 1;

  const now = Date.now();
  const scored = [];
  for (const [records, side] of [[hostMems, "host"], [qqMems, "qq"]]) {
    for (const rec of records) {
      const nameL = rec.name.toLowerCase();
      const descL = rec.description.toLowerCase();
      const bodyL = rec.body.toLowerCase();
      // 字段加权：名字命中 > 描述 > 正文（正文太长，降权防误配）
      let hitIdf = 0;
      let totalIdf = 0;
      for (const t of qTokens) {
        const w = idfOf(t);
        totalIdf += w;
        if (nameL.includes(t)) hitIdf += w;
        else if (descL.includes(t)) hitIdf += w * 0.8;
        else if (bodyL.includes(t)) hitIdf += w * 0.35;
      }
      const keywordScore = totalIdf > 0 ? hitIdf / totalIdf : 0;

      const ents = memEntityMap.get(rec.name) ?? [];
      let graphHit = 0;
      for (const id of ents) if (hitEntityIds.has(id)) graphHit++;
      const graphScore = ents.length === 0 ? 0 : graphHit / ents.length;

      const importanceScore = TYPE_WEIGHT[rec.type] ?? TYPE_WEIGHT.unknown;

      const created = Number(rec.created) || 0;
      const ageDays = created > 0 ? Math.max(0, (now - created) / 86400000) : 30;
      const recencyScore = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);

      const total =
        0.5 * keywordScore + 0.2 * graphScore + 0.15 * importanceScore + 0.15 * recencyScore;

      // 至少要有一个关键词命中，避免纯靠重要性/新鲜度凑数
      if (keywordScore > 0 && total > 0.12) {
        scored.push({ ...rec, side, score: total, keywordScore, graphScore });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, topN);
}

export function formatRecall(hits) {
  if (hits.length === 0) return "";
  const lines = [];
  lines.push("<memory_nebula>");
  lines.push("以下是和当前对话相关的记忆（按相关度排序）。每条都给了记忆名和正本文件路径：");
  lines.push("· 要全文 → memory_read 对应的记忆名");
  lines.push("· 要直接看文件 → 读下面给的路径");
  for (const h of hits) {
    lines.push(`- ${h.name}：${h.description}（${h.side === "host" ? "主工作区" : "次工作区"}）`);
    if (h.file) lines.push(`  文件：${h.file}`);
  }
  lines.push("</memory_nebula>");
  return lines.join("\n");
}
