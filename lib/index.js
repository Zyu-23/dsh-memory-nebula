// dsh-memory-nebula 宿主半（host）——记忆星云的「本体」薄壳。
//
// 职责：只做装配（路由 + 注入 + 工具注册），具体逻辑都在同目录模块里：
//   paths.js   路径常量 + 动态发现记忆工作区 + 首次安装默认数据
//   store.js   记忆读写删（兼容 dsh-auto-memory 的 markdown 格式）
//   graph.js   图组装 + 节点目录 + entities.json 读写
//   recall.js  四路打分检索
//   persona.js 人格 + 状态注入文本
//   extract.js LLM 实体抽取
//
// 运行时数据：~/.dsh/memory-nebula/{entities.json, persona.json, state.json, contexts/}
// 记忆正本：~/.dsh/memory/<slug>/*.md（本插件读写；不提供备份功能，备份请自行向 DSH 提要求）
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";

import { initDefaults, nebulaDir, sessionKey, sideSlug } from "./paths.js";
import {
  deleteMemory, loadMemories, normalizeMemoryName, readMemory, writeMemory,
} from "./store.js";
import { buildContextsFiles, buildGraph, readEntities, writeEntities } from "./graph.js";
import { formatRecall, recall } from "./recall.js";
import { formatPersona, formatState, readPersona, readState, writeState } from "./persona.js";
import { buildExtractPrompt, parseExtractResult } from "./extract.js";

const name = "memory-nebula";
const inject = ["llm", "tools", "webServer", "systemPrompt"];

function apply(ctx) {
  // 首次安装自动初始化默认数据（entities.json / persona.json），下载即可用
  initDefaults();
  ctx.logger?.info?.("[dsh-memory-nebula] 记忆星云 host 已挂载（图路由 + 抽取工具）");

  // 1. 图数据路由：运行时组装最新图，返回给客户端
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/nebula/graph",
    handler: (_req, res) => {
      try {
        const entitiesData = readEntities();
        const hostRecords = loadMemories(sideSlug("host"));
        const qqRecords = loadMemories(sideSlug("qq"));
        const graph = buildGraph(entitiesData, hostRecords, qqRecords);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(graph));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(error) }));
      }
    },
  }), "dsh-memory-nebula: /nebula/graph route");

  // 2. 「喂」：每轮把和当前对话相关的记忆注入 system prompt。
  //    准优先：查询用「最近 3 条用户消息」每轮更新，话题变了能跟上。
  //    KV 缓存友好：注入文本按「检索结果签名」去抖——结果没变就返回上次的文本。
  const msgsBySession = new Map(); // sessionId -> 最近 3 条用户消息
  const lastInject = new Map();    // sessionId -> { signature, text }

  // ── 状态自动兜底 ──────────────────────────────────────────────
  // 平时靠模型手动调 nebula_state（准确）；万一忘了更新，新会话开始时若状态超过
  // 30 分钟没变，就用当前用户消息自动补一笔（标记 auto:true，手动状态可覆盖）。
  const STATE_STALE_MS = 30 * 60 * 1000;
  let lastCheckSession = null;
  function autoStateFallback(sid, userText, agent) {
    try {
      if (sid === lastCheckSession) return; // 每个会话只检查一次
      lastCheckSession = sid;
      const key = sessionKey(agent);
      const st = readState(key);
      const updatedAt = st?.updated ? Date.parse(st.updated) : 0;
      if (updatedAt && Date.now() - updatedAt < STATE_STALE_MS) return; // 状态还新鲜，不动
      const summary = String(userText || "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!summary) return;
      const nowIso = new Date().toISOString();
      const history = Array.isArray(st?.history) ? st.history.slice() : [];
      if (st?.current) history.push({ text: st.current, at: st.updated || nowIso });
      while (history.length > 10) history.shift();
      writeState({
        current: `（自动）正在处理：${summary}`,
        since: nowIso,
        updated: nowIso,
        history,
        auto: true,
      }, key);
    } catch { /* 兜底失败永不影响主流程 */ }
  }

  ctx.on("agent/inbox/claimed", ({ agent, message }) => {
    if (!message || message.role !== "user") return;
    const sid = agent?.session?.id;
    if (!sid) return;
    const text = (Array.isArray(message.content) ? message.content : [])
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join(" ")
      .trim();
    if (text.length === 0) return;
    const list = msgsBySession.get(sid) ?? [];
    list.push(text.slice(0, 300));
    while (list.length > 3) list.shift(); // 只保留最近 3 条，兼顾上下文和新鲜度
    msgsBySession.set(sid, list);

    autoStateFallback(sid, text, agent); // 状态兜底
  });
  ctx.on("session/disposed", (session) => {
    msgsBySession.delete(session.id);
    lastInject.delete(session.id);
  });

  // 2-0. 「人格」注入：从 persona.json 生成完整人格（人格归插件管）
  ctx.effect(() => ctx.systemPrompt.section({
    name: "memory-nebula:persona",
    order: 4300, // 最前：人格决定"她是谁"
    interpolate: false,
    text: () => {
      try {
        return formatPersona(readPersona());
      } catch (error) {
        return "";
      }
    },
  }), "dsh-memory-nebula: persona injection");

  // 2a. 「状态」注入：此刻正在做什么（每轮注入、换会话不丢）
  ctx.effect(() => ctx.systemPrompt.section({
    name: "memory-nebula:state",
    order: 4400,
    interpolate: false,
    text: () => {
      try {
        return formatState(readState(sessionKey(context?.agent)));
      } catch (error) {
        return "";
      }
    },
  }), "dsh-memory-nebula: state injection");

  // 2b. 「记忆召回」注入：按当前话题精选 top5
  ctx.effect(() => ctx.systemPrompt.section({
    name: "memory-nebula:recall",
    order: 4500,
    interpolate: false, // 记忆描述里可能出现 {{ }}，禁止插值避免整段组装失败
    text: (context) => {
      try {
        const agent = context?.agent;
        const sid = agent?.session?.id;
        if (!sid) return "";
        const list = msgsBySession.get(sid);
        if (!list || list.length === 0) return "";
        const query = list.join(" ");
        const hits = recall(query, { topN: 5 });
        const signature = hits.map((h) => h.name).join("|");
        // 去抖：检索结果没变 → 直接返回上次的注入文本（KV 前缀缓存稳定）
        const cached = lastInject.get(sid);
        if (cached && cached.signature === signature) return cached.text;

        const block = formatRecall(hits);
        lastInject.set(sid, { signature, text: block });

        // 调试：记录最近一次注入，便于验证「喂」是否真的在跑
        if (block) {
          try {
            writeFileSync(
              join(nebulaDir(), "last-inject.json"),
              JSON.stringify({
                at: new Date().toISOString(),
                sessionId: sid,
                query: query.slice(0, 200),
                hits: hits.map((h) => ({ name: h.name, score: Math.round(h.score * 1000) / 1000, side: h.side })),
              }, null, 2),
              "utf8"
            );
          } catch { /* 调试写入失败不影响注入 */ }
        }
        return block;
      } catch (error) {
        return ""; // 注入失败永不影响主流程
      }
    },
  }), "dsh-memory-nebula: recall injection");

  // 3. 抽取工具：读记忆 + LLM 抽实体 + 更新 entities.json
  ctx.tools.register(defineTool({
    name: "nebula_extract",
    description: "为记忆星云抽取实体：读一条记忆，用 LLM 判断它涉及哪些已知实体、是否需要新增实体，并更新实体关系数据（entities.json）。记忆写入后可调用它让星云图长出新的节点。",
    parameters: {
      memoryName: { type: "string", required: true, description: "要抽取的记忆 name（不含 .md）" },
      side: { type: "string", required: true, enum: ["host", "qq"], description: "记忆属于哪一侧：host=主工作区，qq=次工作区" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          matched: { type: "array", items: { type: "number" } },
          added: { type: "array", items: { type: "object", additionalProperties: true } },
          message: { type: "string" },
        },
      },
      render: (_args, v) => [{ type: "text", text: v.message }],
    },
    async execute(args, exec) {
      const side = String(args.side ?? "host");
      const slug = sideSlug(side);
      const memName = String(args.memoryName ?? "").trim();
      if (memName.length === 0) return { ok: false, matched: [], added: [], message: "memoryName 不能为空" };

      // 读记忆
      const all = loadMemories(slug);
      const rec = all.find((r) => r.name === memName);
      if (rec === undefined) {
        return { ok: false, matched: [], added: [], message: `在 ${side === "host" ? "主工作区" : "次工作区"}侧没找到记忆 ${memName}` };
      }

      // 读实体表
      const entitiesData = readEntities();

      // 调 LLM 抽取
      const llm = ctx.get("llm");
      if (llm === undefined) {
        return { ok: false, matched: [], added: [], message: "llm 服务不可用" };
      }
      const agent = exec.agent;
      const provider = agent?.options?.provider;
      const model = agent?.options?.model;
      if (provider === undefined || model === undefined) {
        return { ok: false, matched: [], added: [], message: "当前会话没有 provider/model，无法调 LLM" };
      }

      const prompt = buildExtractPrompt(entitiesData.entities, rec, side);
      const assembler = new BlockAssembler();
      try {
        const request = {
          provider,
          model,
          reasoningEffort: "off", // 关闭思考：抽取是简单任务，直接输出 JSON，避免 high 推理耗光 token 导致截断
          messages: [createUserMessage({
            content: [{ type: "text", text: prompt }],
            source: { kind: "dsh-memory-nebula" },
          })],
          maxTokens: 1500,
          sessionId: agent?.session?.id,
          signal: exec.signal,
        };
        for await (const chunk of llm.stream(request)) assembler.push(chunk);
      } catch (error) {
        return { ok: false, matched: [], added: [], message: `LLM 调用失败: ${String(error)}` };
      }
      const finish = assembler.finish;
      const text = assembler.blocks().filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const result = parseExtractResult(text);
      if (result === null) {
        const preview = (text || "").slice(0, 200).replace(/\s+/g, " ");
        const why = finish.kind === "text" ? "不是合法 JSON" : `LLM 未正常结束(${finish.kind})且未解析到 JSON`;
        return { ok: false, matched: [], added: [], message: `${why}，输出前 200 字: ${preview}` };
      }

      // 更新 entities.json
      const validIds = new Set(entitiesData.entities.map((e) => e.id));
      const matched = (result.entities ?? []).filter((id) => validIds.has(id));
      // 核心实体（主工作区/次工作区）如果还没建（空白框架），就不强行挂到不存在的 id 上
      const coreId = side === "host" ? 1 : 2;
      const hasCore = validIds.has(coreId);
      const merged = [...new Set([
        ...(entitiesData.memoryEntities[side][memName] ?? []),
        ...matched,
        ...(hasCore ? [coreId] : []),
      ])];

      const added = [];
      // 空实体表时 Math.max(...[]) 是 -Infinity，必须单独处理
      let nextId = entitiesData.entities.length > 0
        ? Math.max(...entitiesData.entities.map((e) => e.id)) + 1
        : 1;
      for (const raw of result.new ?? []) {
        const nm = String(raw.name ?? "").trim();
        const ty = ["person", "thing", "topic", "place", "skill"].includes(raw.type) ? raw.type : "thing";
        if (nm.length === 0) continue;
        if (entitiesData.entities.some((e) => e.name === nm)) continue; // 已存在，跳过
        entitiesData.entities.push({ id: nextId, name: nm, type: ty, side });
        merged.push(nextId);
        added.push({ id: nextId, name: nm, type: ty, side });
        nextId += 1;
      }

      // 空白框架下用户抽的第一条记忆：如果还没有任何实体，连 line 都没有
      entitiesData.memoryEntities[side][memName] = merged;
      writeEntities(entitiesData);

      // 同步重建节点目录（失败不影响抽取结果）
      try {
        buildContextsFiles(entitiesData, loadMemories(sideSlug("host")), loadMemories(sideSlug("qq")));
      } catch (error) {
        ctx.logger?.warn?.("[dsh-memory-nebula] contexts 重建失败: " + String(error));
      }

      return {
        ok: true,
        matched,
        added,
        message: `已抽取记忆「${memName}」：匹配 ${matched.length} 个已有实体` +
          (added.length > 0 ? `，新增 ${added.map((a) => a.name).join(", ")}` : "") +
          `。已更新 entities.json 与节点目录（contexts/），刷新星云图即可看到。`,
      };
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: "generic", title: "记忆星云抽取实体", kind: "other", rawInput: null }),
  }));

  // 4. 状态工具：更新「此刻正在做什么」
  ctx.tools.register(defineTool({
    name: "nebula_state",
    description: "更新记忆星云的「当前状态」——此刻正在做什么。写进 ~/.dsh/memory-nebula/state.json，每轮注入提示词、换会话不丢，让下一次对话仍知道上次在干什么。",
    parameters: {
      text: { type: "string", required: true, description: "当前正在做什么（一句话，比如「正在给老大优化记忆星云的喂」）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          message: { type: "string" },
        },
      },
      render: (_args, v) => [{ type: "text", text: v.message }],
    },
    async execute(args, exec) {
      const text = String(args.text ?? "").trim();
      if (text.length === 0) return { ok: false, message: "text 不能为空" };
      const key = sessionKey(exec?.agent); // 按工作区隔离
      const old = readState(key);
      const now = new Date().toISOString();
      const history = Array.isArray(old?.history) ? old.history.slice() : [];
      if (old?.current && old.current !== text) {
        history.push({ text: old.current, at: old.updated || now });
      }
      while (history.length > 10) history.shift();
      const same = old?.current === text;
      writeState({
        current: text,
        since: same ? (old?.since ?? now) : now, // 状态没变时保留原起始时间
        updated: now,
        history,
      }, key);
      return { ok: true, message: `状态已更新：${text}` };
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: "generic", title: "更新记忆星云状态", kind: "other", rawInput: null }),
  }));

  // ── 5. 记忆读写工具（接管 dsh-auto-memory）──────────────────────────
  const sideOf = (raw) => (String(raw).toLowerCase() === "qq" ? "qq" : "host");
  const slugOf = (side) => sideSlug(side === "qq" ? "qq" : "host");

  ctx.tools.register(defineTool({
    name: "memory_write",
    description: "写入或更新一条记忆（记忆星云本体提供的持久记忆）。查重更新而非堆积：同名记忆会覆盖并保留原 created 时间。",
    parameters: {
      name: { type: "string", required: true, description: "kebab-case 英文 id，如 user-prefers-python" },
      description: { type: "string", required: true, description: "一句话摘要（索引里显示的，≤160 字符）" },
      type: { type: "string", required: true, enum: ["user", "feedback", "project", "reference"], description: "记忆类型" },
      body: { type: "string", required: true, description: "记忆正文（markdown）" },
      side: { type: "string", enum: ["host", "qq"], description: "写哪一侧：host=主工作区（默认），qq=次工作区" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          name: { type: "string", required: true },
          operation: { type: "string", required: true, enum: ["created", "updated"] },
          file: { type: "string" },
          message: { type: "string" },
        },
      },
      render: (_args, v) => [{ type: "text", text: v.message }],
    },
    async execute(args) {
      const memName = normalizeMemoryName(args.name);
      if (!memName) return { ok: false, name: "", operation: "created", message: "记忆名不合法（需 kebab-case）" };
      const side = sideOf(args.side ?? "host");
      const slug = slugOf(side);
      const now = Date.now();
      const existing = readMemory(memName, slug);
      const rec = {
        name: memName,
        description: String(args.description ?? "").trim(),
        type: String(args.type ?? "project"),
        body: String(args.body ?? "").trim(),
        created: existing ? Number(existing.created) || now : now,
        updated: now,
      };
      const file = writeMemory(rec, slug);
      return {
        ok: true, name: memName, operation: existing ? "updated" : "created", file,
        message: `记忆已${existing ? "更新" : "创建"}：${memName}（${side === "host" ? "主工作区" : "次工作区"}）\n文件：${file}`,
      };
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: "generic", title: "写记忆", kind: "other", rawInput: null }),
  }));

  ctx.tools.register(defineTool({
    name: "memory_read",
    description: "读取一条记忆的全文（含 frontmatter 与正文）。正文丢失时自动从备份找回。",
    parameters: {
      name: { type: "string", required: true, description: "记忆名（不含 .md）" },
      side: { type: "string", enum: ["host", "qq"], description: "哪一侧：host=主工作区（默认），qq=次工作区" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          name: { type: "string" },
          file: { type: "string" },
          text: { type: "string" },
          message: { type: "string" },
        },
      },
      render: (_args, v) => [{ type: "text", text: v.text || v.message || "" }],
    },
    async execute(args) {
      const memName = String(args.name ?? "").trim();
      const side = sideOf(args.side ?? "host");
      const rec = readMemory(memName, slugOf(side));
      if (!rec) return { ok: false, name: memName, file: "", text: "", message: `没找到记忆 ${memName}（${side === "host" ? "主工作区" : "次工作区"}）` };
      return { ok: true, name: memName, file: rec.file, text: rec.raw, message: "" };
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: "generic", title: "读记忆", kind: "other", rawInput: null }),
  }));

  ctx.tools.register(defineTool({
    name: "memory_list",
    description: "列出记忆（可按侧过滤），返回记忆名、类型、描述、更新时间。",
    parameters: {
      side: { type: "string", enum: ["host", "qq"], description: "只列某一侧；省略=两侧都列" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          count: { type: "number", required: true },
          items: { type: "array", items: { type: "object", additionalProperties: true } },
          message: { type: "string", required: true },
        },
      },
      render: (_args, v) => [{ type: "text", text: v.message }],
    },
    async execute(args) {
      const sides = args.side ? [sideOf(args.side)] : ["host", "qq"];
      const items = [];
      for (const side of sides) {
        for (const rec of loadMemories(slugOf(side))) {
          items.push({
            name: rec.name, side, type: rec.type, description: rec.description,
            updated: rec.created ? new Date(Number(rec.created)).toISOString().slice(0, 10) : "",
          });
        }
      }
      const lines = items.map((i) => `- ${i.name}（${i.side === "host" ? "主工作区" : "次工作区"}/${i.type}）：${i.description}`);
      return {
        ok: true, count: items.length, items,
        message: items.length === 0 ? "（没有记忆）" : `共 ${items.length} 条记忆：\n${lines.join("\n")}`,
      };
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: "generic", title: "列记忆", kind: "other", rawInput: null }),
  }));

  ctx.tools.register(defineTool({
    name: "memory_delete",
    description: "删除一条记忆（文件删除，不可恢复，慎用）。正本和备份一起删。",
    parameters: {
      name: { type: "string", required: true, description: "记忆名（不含 .md）" },
      side: { type: "string", enum: ["host", "qq"], description: "哪一侧：host=主工作区（默认），qq=次工作区" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          name: { type: "string" },
          message: { type: "string" },
        },
      },
      render: (_args, v) => [{ type: "text", text: v.message }],
    },
    async execute(args) {
      const memName = String(args.name ?? "").trim();
      const side = sideOf(args.side ?? "host");
      const removed = deleteMemory(memName, slugOf(side));
      return {
        ok: removed, name: memName,
        message: removed ? `已删除记忆 ${memName}（${side === "host" ? "主工作区" : "次工作区"}）` : `没找到记忆 ${memName}`,
      };
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: "generic", title: "删记忆", kind: "other", rawInput: null }),
  }));

  ctx.tools.register(defineTool({
    name: "memory_search",
    description: "按语义/关键词检索记忆（四路打分：关键词 IDF + 图谱 + 重要性 + 新鲜度），返回最相关的 N 条。",
    parameters: {
      query: { type: "string", required: true, description: "检索词或一句话" },
      topN: { type: "number", description: "返回条数，默认 5" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          count: { type: "number", required: true },
          message: { type: "string", required: true },
        },
      },
      render: (_args, v) => [{ type: "text", text: v.message }],
    },
    async execute(args) {
      const query = String(args.query ?? "").trim();
      if (!query) return { ok: false, count: 0, message: "query 不能为空" };
      const hits = recall(query, { topN: Number(args.topN) || 5 });
      if (hits.length === 0) return { ok: true, count: 0, message: `没有匹配「${query}」的记忆。` };
      const lines = hits.map((h) => `- ${h.name}（${h.side === "host" ? "主工作区" : "次工作区"}，score ${h.score.toFixed(3)}）：${h.description}`);
      return { ok: true, count: hits.length, message: `匹配「${query}」的记忆 ${hits.length} 条：\n${lines.join("\n")}` };
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: "generic", title: "检索记忆", kind: "other", rawInput: null }),
  }));
}

export { apply, inject, name };
