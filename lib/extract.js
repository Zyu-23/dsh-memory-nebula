// ── LLM 抽取：判断一条记忆涉及哪些实体 ────────────────────────────────
export function buildExtractPrompt(entities, rec, side) {
  const table = entities
    .filter((e) => e.side === side || e.side === "shared")
    .map((e) => `${e.id}: ${e.name} (${e.type})`)
    .join("\n");
  return `你是记忆实体抽取器。给定「已有实体表」和一条记忆，判断这条记忆涉及哪些已有实体、以及是否需要新增实体。

【已有实体表】
${table}

【记忆】
name: ${rec.name}
description: ${rec.description}
body（前 800 字）:
${rec.body.slice(0, 800)}

【输出要求】直接输出一个 JSON 对象，不要任何解释、不要思考过程、不要用 markdown 代码块、不要复述记忆内容。输出总长度控制在 300 字以内。格式严格如下：
{"entities":[数字id...],"new":[{"name":"新实体名","type":"person|thing|topic|place|skill","side":"${side}"}]}

规则：
- entities 只放这条记忆「明确涉及」的已有实体 id，最多 8 个，宁缺毋滥
- 核心实体（主工作区/次工作区/老大）不用列，系统自动处理
- new 只在「确实出现、且不在已有实体表里」时新增，最多 3 个；泛词（记忆/会话/备份/聊天/文件 等）一律不新增
- 没有就返回空数组
- 只输出 JSON 本身，一个多余的字都不要，不要用 \`\`\` 包裹`;
}

export function validateResult(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (!Array.isArray(obj.entities)) return null;
  if (obj.new !== undefined && !Array.isArray(obj.new)) return null;
  return obj;
}

// 稳健提取 JSON：即使模型在 JSON 后面又啰嗦了一堆、或被截断，也能把第一个完整 JSON 对象抠出来
export function parseExtractResult(text) {
  if (!text) return null;
  // 1. 整体直接 parse
  try { return validateResult(JSON.parse(text)); } catch { /* 继续 */ }
  // 2. 找第一个 { 到第一个平衡闭合的 }
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        try { return validateResult(JSON.parse(text.slice(start, i + 1))); } catch { return null; }
      }
    }
  }
  // 3. 贪婪兜底（不推荐，但尽量救）
  const m = /(\{[\s\S]*\})/.exec(text);
  if (m) { try { return validateResult(JSON.parse(m[1])); } catch { return null; } }
  return null;
}
