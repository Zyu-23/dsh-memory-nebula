# 记忆星云 · dsh-memory-nebula

> 把 DSH 的记忆画成一张会呼吸的双星云图，并让「记忆 / 人格 / 状态」完全归插件管理。
>
> **记忆是电，插件是电器**——模型可以换，本体留在这张图里。

---

## 这是什么

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，做四件事：

1. **可视化**：把记忆做成力导向星云图，节点之间有连线，点节点能看到它关联哪些记忆、保存在哪
2. **记忆管理**：提供 `memory_write` / `memory_read` / `memory_list` / `memory_delete` / `memory_search` 五个工具（兼容 dsh-auto-memory 的 markdown 格式）
3. **人格管理**：人格存成 `persona.json`，每轮注入，不再藏在 AGENTS.md
4. **状态管理**：记录「此刻正在做什么」，换会话不丢

---

## 功能

### 星云图

- **双星云**：自动发现你的多个工作区（`~/.dsh/memory/<slug>/`），每个一个「阵营」；只有一个工作区就是单星云
- **力导向布局**：Canvas 2D 手写物理引擎，60fps；节点按类型着色（人/物/话题/地点/技能/人格）
- **点节点看详情**：关联记忆列表 + 每条记忆的正本路径
- **人格簇**：图中间一簇金色节点，就是「她是谁」
- **三种入口**：侧栏 Tab（小窗）/ 侧栏图标（全屏）/ 主面板

### 记忆工具

| 工具 | 作用 |
|---|---|
| `memory_write` | 写/更新记忆（同名覆盖，保留原 created 时间；原子写）|
| `memory_read` | 读记忆全文 |
| `memory_list` | 列记忆 |
| `memory_delete` | 删记忆 |
| `memory_search` | 四路打分检索（关键词 IDF + 图谱 + 重要性 + 新鲜度）|

### 人格 & 状态

- 人格数据在 `~/.dsh/memory-nebula/persona.json`，每轮注入 `<memory_nebula_persona>`
- 状态数据在 `~/.dsh/memory-nebula/state.json`，每轮注入 `<memory_nebula_state>`
- 想改人格：直接编辑 `persona.json`，刷新即生效

**状态怎么更新**：

- **手动**（主力）：让模型调 `nebula_state` 工具，准确记录「正在做什么」
- **自动兜底**：新会话开始时，如果状态超过 30 分钟没更新，插件会用当前用户消息自动记一笔（状态前带「（自动）」前缀，可被手动更新覆盖）

> **本插件不提供备份功能。** 需要备份你的记忆，请自行向 DSH 提要求（例如让它写一个备份脚本），或用 git / 云盘同步 `~/.dsh/memory/`。

---

## 安装

### 方式一：手动安装（推荐）

1. 下载本仓库，把整个目录放到你的 DSH profile 的 `node_modules/` 下：

```
<你的 DSH 目录>/profiles/<profile>/node_modules/dsh-memory-nebula/
```

2. 编辑该 profile 的 `package.json`：

```json
{
  "dependencies": {
    "dsh-memory-nebula": "0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "dsh-memory-nebula"
      ]
    }
  }
}
```

3. 重启 DSH

4. **验证安装**：打开侧栏，看到「记忆星云」图标即成功；点开应该是一张空白星云图 + 引导提示

### 方式二：npm 安装

> **本插件暂未发布到 npm**，请先按方式一手动安装。

（如果之后发布到 npm，可用：）

```bash
dsh plugin --profile <profile> add dsh-memory-nebula
```

### 首次启动

插件会自动初始化两个**空白**数据文件：

- `~/.dsh/memory-nebula/entities.json`（实体关系，默认 `entities: []`）
- `~/.dsh/memory-nebula/persona.json`（人格，默认 `directives: [] / sections: []`）

**这是设计如此**——插件只提供框架，星云图开箱就是空的，内容由你自己往里写。

**已有数据不会被覆盖**，所以升级安全。

---

## 使用（从零开始）

### 第 1 步：看图

打开侧栏「记忆星云」（或点侧栏面板列表里的星云图标）。

刚装好时图是**空白**的，中间会显示提示：「星云还是空的 → memory_write 写记忆 → nebula_extract 抽实体 → 刷新」。

### 第 2 步：写第一条记忆

让我（或你自己）调 `memory_write`：

```json
{
  "name": "my-first-memory",
  "description": "一句话摘要",
  "type": "project",
  "body": "记忆正文……"
}
```

### 第 3 步：抽实体（让记忆进图）

调 `nebula_extract`：

```json
{ "memoryName": "my-first-memory", "side": "host" }
```

它会读这条记忆，用 LLM 判断涉及哪些实体/要不要新建，然后更新 `entities.json`。

### 第 4 步：刷新星云图

节点就长出来了。之后每条记忆重复「写 → 抽」，图会越来越丰富。

### 交互

- 拖拽节点 / 滚轮缩放 / 拖空白平移
- 点节点看详情（关联记忆 + 正本路径）
- 人格节点（金色）点开看人格条目内容

### 自定义人格

默认空白。编辑 `~/.dsh/memory-nebula/persona.json`：

```json
{
  "directives": ["LANG_ZH_CN_ONLY", "ADDRESS_AS_USER"],
  "sections": [
    { "id": "identity", "title": "身份", "category": "身份", "content": "你是……" }
  ]
}
```

- `directives`：压缩指令（模型解析用）
- `sections`：自然语言描述（每条 = 图上一个金色节点）
- 填好后每轮自动注入 `<memory_nebula_persona>`

### 自定义实体

默认空白。也可以直接编辑 `~/.dsh/memory-nebula/entities.json` 手工加实体：

```json
{
  "entities": [
    { "id": 1, "name": "我的项目", "type": "topic", "side": "host" }
  ],
  "edges": [],
  "memoryEntities": { "host": {}, "qq": {} }
}
```

> **实体 id 不要重复**（图布局依赖 id 做确定性定位）。

---

## 数据位置

| 数据 | 位置 |
|---|---|
| 记忆正本 | `~/.dsh/memory/<slug>/*.md`（markdown + frontmatter）|
| 实体关系 | `~/.dsh/memory-nebula/entities.json` |
| 人格 | `~/.dsh/memory-nebula/persona.json` |
| 状态 | `~/.dsh/memory-nebula/state.json`（有多个工作区时按工作区拆成 `state-<key>.json`，各存各的）|
| 节点目录 | `~/.dsh/memory-nebula/contexts/` |
| 注入调试 | `~/.dsh/memory-nebula/last-inject.json` |

---

## 原理速览

- **渲染**：Canvas 2D + 手写力导向（斥力 2600 / 弹簧 0.045 / 阻尼 0.86），按节点 id 做确定性初始布局
- **检索**：分词（中文 bigram）→ IDF 加权 → 字段加权（名字 > 描述 > 正文）→ 四路合并
- **注入**：`systemPrompt.section`，order 4300 人格 / 4400 状态 / 4500 记忆召回；注入文本按检索结果签名去抖，减少 KV 缓存失效
- **存储**：markdown + YAML frontmatter，原子写（tmp → rename）
- **工作区发现**：扫描 `~/.dsh/memory/*/`，不硬编码任何路径

---

## 已知限制

- 检索没有 embedding（语义相似），同义不同词可能查不到；top-5 注入一般够用
- 图是静态快照，改了记忆要刷新页面
- 抽实体是手动的（`nebula_extract`）
- 不提供备份（见上）

---

## 开发

```bash
# 修改 lib/client.template.js 后，复制为 client.js
cp lib/client.template.js lib/client.js
```

（`lib/*.js` 是宿主模块，`lib/client.template.js` 是客户端渲染源码。）

---

## 致谢

思路借鉴 [peterpoal134/memory-brain](https://github.com/peterpoal134/memory-brain)（AGPL-3.0）的「存 / 喂 / 查」设计。本实现为独立编写，未复制其代码，采用 MIT 许可。

---

## License

MIT
