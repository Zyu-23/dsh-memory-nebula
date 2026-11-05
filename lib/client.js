/**
 * 记忆星云 —— 客户端模块（侧栏 Tab）
 *
 * 这是 DSH 的自定义模块格式：window.__ModuleLoader__.load({ id, factory })，
 * factory 返回 { apply, inject }。不能有 default export。
 *
 * 渲染：Canvas 2D 力导向星云。不依赖 three.js：
 *   - 节点之间斥力、边是弹簧、整体向心，自然长成一张"星云"
 *   - 节点用径向渐变画发光球，边是半透明细线
 * 数据：GRAPH 由 build-client.mjs 从 graph.json 内联进来。
 */
window.__ModuleLoader__.load({
  id: "dsh-memory-nebula",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;

    // 类型配色，跟 source 3D 场景的色板保持一致
    const TYPE_COLOR = {
      person: "#54e7ff",
      thing: "#ffc66c",
      topic: "#bd96ff",
      place: "#79f3c8",
      skill: "#f9a0df",
      memory: "#92caff",
      persona: "#ffe08a", // 人格：金色，和记忆区分开
    };
    const TYPE_CN = {
      person: "人",
      thing: "物",
      topic: "话题",
      place: "地点",
      skill: "技能",
      memory: "记忆",
      persona: "人格",
    };
    const SIDE_CN = { host: "主工作区", qq: "次工作区", shared: "共享" };
    const EDGE_STYLE = {
      relation: { width: 1.4, alpha: 0.34, dash: null },
      cooccur: { width: 0.8, alpha: 0.16, dash: null },
      similar: { width: 1.0, alpha: 0.20, dash: [4, 5] },
    };

    // ── 模拟参数 ───────────────────────────────────────────
    const REPULSE = 2600;      // 节点斥力
    const SPRING = 0.045;      // 边弹簧系数
    const SPRING_LEN = 78;     // 边的自然长度
    const CLUSTER_K = 0.004;   // 阵营聚簇力：普通节点向自己的核心靠拢
    const CORE_K = 0.03;       // 核心节点的锚定强度（更强，保持两团分开）
    const DAMPING = 0.86;      // 阻尼
    const MAX_SPEED = 6;

    // 两个核心的锚点：主工作区在左，次工作区在右，你（shared）在中间偏上
    const SIDE_ANCHOR = {
      host: { x: -240, y: 0 },
      qq: { x: 240, y: 0 },
      shared: { x: 0, y: -40 },
    };

    // 核心节点的专属颜色
    const CORE_COLOR = { host: "#7ce8ff", qq: "#ff9ad5" };

    function hashSeed(str) {
      let h1 = 2166136261;
      for (let i = 0; i < str.length; i++) {
        h1 ^= str.charCodeAt(i);
        h1 = Math.imul(h1, 16777619);
      }
      return h1 >>> 0;
    }

    /** 确定性初始位置：按阵营落到各自核心周围，核心本身钉在锚点上。 */
    function seedPosition(node, index) {
      const s = hashSeed("node:" + node.id);
      const side = node.side || "host";
      const anchor = SIDE_ANCHOR[side] || SIDE_ANCHOR.host;
      if (node.core) return { x: anchor.x, y: anchor.y };
      const angle = (s % 10000) / 10000 * Math.PI * 2 + index * 0.7;
      const radius = 45 + ((s >>> 10) % 1000) / 1000 * 115;
      return {
        x: anchor.x + Math.cos(angle) * radius,
        y: anchor.y + Math.sin(angle) * radius,
      };
    }

    function buildSimulation(graph) {
      const raw = graph.nodes || [];
      const nodes = raw.map((n, i) => {
        const side = n.side || "host";
        const anchor = SIDE_ANCHOR[side] || SIDE_ANCHOR.host;
        const p = seedPosition({ id: n.id, side, core: n.core === true }, i);
        return {
          id: n.id,
          name: n.name,
          type: n.type || "thing",
          side,
          core: n.core === true,
          degree: n.degree || 0,
          iso: n.iso === true,
          contextFile: n.contextFile || "",
          content: n.content || "",   // 人格条目内容（persona 节点用）
          category: n.category || "",
          x: p.x,
          y: p.y,
          vx: 0,
          vy: 0,
          homeX: anchor.x,
          homeY: anchor.y,
          // 半径：核心最大，人格中枢次之，其余按连接数收敛
          r: n.core === true ? 9 : n.type === "persona" && (n.degree || 0) > 3 ? 7 : 4.2 + Math.min(11, Math.sqrt(n.degree || 1) * 1.9),
        };
      });
      const byId = new Map();
      for (const n of nodes) byId.set(n.id, n);

      const edges = (graph.edges || [])
        .map((e) => {
          const s = byId.get(e.src);
          const t = byId.get(e.dst);
          return s && t ? { s, t, kind: e.kind || "cooccur", label: e.label || "", weight: e.weight ?? 0.5, bridge: e.bridge === true, shared: e.shared === true } : null;
        })
        .filter(Boolean);

      // 邻居表，供悬停高亮用
      const neighbors = new Map();
      for (const n of nodes) neighbors.set(n.id, new Set());
      for (const e of edges) {
        neighbors.get(e.s.id).add(e.t.id);
        neighbors.get(e.t.id).add(e.s.id);
      }

      return { nodes, edges, byId, neighbors, memories: graph.memories || [] };
    }

    function tick(sim, energy) {
      const { nodes, edges } = sim;
      const n = nodes.length;
      if (n === 0) return;

      // 1. 节点斥力（O(n²)，当前规模足够；上千节点再换四叉树）
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            // 完全重合时给一个确定性的小扰动，避免除零
            dx = ((a.id * 7 + b.id) % 5) - 2 || 1;
            dy = ((a.id * 11 + b.id) % 5) - 2 || 1;
            d2 = dx * dx + dy * dy;
          }
          const d = Math.sqrt(d2);
          const force = REPULSE / d2;
          const fx = (dx / d) * force;
          const fy = (dy / d) * force;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }

      // 2. 边弹簧
      for (const e of edges) {
        const dx = e.t.x - e.s.x;
        const dy = e.t.y - e.s.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const stretch = d - SPRING_LEN;
        const force = stretch * SPRING * (0.6 + (e.weight || 0.5) * 0.8);
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        e.s.vx += fx;
        e.s.vy += fy;
        e.t.vx -= fx;
        e.t.vy -= fy;
      }

      // 3. 阵营聚簇 + 阻尼 + 位移
      for (const node of nodes) {
        if (node === sim.dragging) continue; // 被拖拽的节点不动
        const k = node.core ? CORE_K : CLUSTER_K;
        node.vx += (node.homeX - node.x) * k;
        node.vy += (node.homeY - node.y) * k;
        node.vx *= DAMPING;
        node.vy *= DAMPING;

        const speed = Math.hypot(node.vx, node.vy);
        if (speed > MAX_SPEED) {
          node.vx = (node.vx / speed) * MAX_SPEED;
          node.vy = (node.vy / speed) * MAX_SPEED;
        }

        node.x += node.vx * energy;
        node.y += node.vy * energy;
      }
    }

    // ── React 组件 ────────────────────────────────────────
    function NebulaView(props) {
      const canvasRef = react.useRef(null);
      const simRef = react.useRef(null);
      const viewRef = react.useRef({ scale: 1, ox: 0, oy: 0 });
      const hoverRef = react.useRef(null);
      const [selected, setSelected] = react.useState(null);
      const [stats, setStats] = react.useState(null);
      const visible = props && props.visible !== false;

      // 初始化模拟 + 动画循环（只跑一次）
      react.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        let sim = null;
        simRef.current = null;

        const ctx2d = canvas.getContext("2d");
        let raf = 0;
        let alive = true;
        let frame = 0;
        // 冷启动先跑一段，让图自己"长"成稳定形状，之后低能量维持轻微呼吸
        let energy = 1;

        function draw() {
          if (!alive || !sim) return;
          const w = canvas.clientWidth || 800;
          const hgt = canvas.clientHeight || 600;
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(hgt * dpr);
          }

          ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
          // 背景：深空渐变
          const bg = ctx2d.createRadialGradient(w / 2, hgt / 2, 20, w / 2, hgt / 2, Math.max(w, hgt) * 0.75);
          bg.addColorStop(0, "#07131f");
          bg.addColorStop(1, "#03070d");
          ctx2d.fillStyle = bg;
          ctx2d.fillRect(0, 0, w, hgt);

          const view = viewRef.current;
          ctx2d.save();
          ctx2d.translate(w / 2 + view.ox, hgt / 2 + view.oy);
          ctx2d.scale(view.scale, view.scale);

          const hover = hoverRef.current;
          const highlight = new Set();
          if (hover !== null) {
            highlight.add(hover);
            for (const id of sim.neighbors.get(hover) || []) highlight.add(id);
          }

          // 阵营底色：两团各自的淡色光晕，让"两块"更分明
          for (const side of ["host", "qq"]) {
            const anchor = SIDE_ANCHOR[side];
            const tint = side === "host" ? "#0a2736" : "#2c1030";
            const g = ctx2d.createRadialGradient(anchor.x, anchor.y, 10, anchor.x, anchor.y, 210);
            g.addColorStop(0, tint);
            g.addColorStop(1, "#00000000");
            ctx2d.fillStyle = g;
            ctx2d.beginPath();
            ctx2d.arc(anchor.x, anchor.y, 210, 0, Math.PI * 2);
            ctx2d.fill();
          }

          // 先画边
          for (const e of sim.edges) {
            const st = EDGE_STYLE[e.kind] || EDGE_STYLE.cooccur;
            const hot = hover !== null && (e.s.id === hover || e.t.id === hover);
            if (e.bridge) {
              // 姐妹桥：最亮最粗，连接两个核心
              ctx2d.globalAlpha = hot ? 1 : 0.85;
              ctx2d.strokeStyle = "#ffd27f";
              ctx2d.lineWidth = 2.4;
              ctx2d.setLineDash([]);
            } else if (e.shared) {
              // 老大连两边的共享边：虚线
              ctx2d.globalAlpha = hot ? 0.7 : 0.34;
              ctx2d.strokeStyle = "#b8a6ff";
              ctx2d.lineWidth = 1.3;
              ctx2d.setLineDash([3, 4]);
            } else {
              ctx2d.globalAlpha = hot ? Math.min(0.85, st.alpha * 2.6) : st.alpha;
              ctx2d.strokeStyle = hot ? "#8fe6ff" : "#3f7f9e";
              ctx2d.lineWidth = hot ? st.width * 1.6 : st.width;
              ctx2d.setLineDash(st.dash || []);
            }
            ctx2d.beginPath();
            ctx2d.moveTo(e.s.x, e.s.y);
            ctx2d.lineTo(e.t.x, e.t.y);
            ctx2d.stroke();
          }
          ctx2d.setLineDash([]);
          ctx2d.globalAlpha = 1;

          // 再画节点
          for (const node of sim.nodes) {
            const color = node.core
              ? CORE_COLOR[node.side] || "#ffffff"
              : TYPE_COLOR[node.type] || TYPE_COLOR.thing;
            const dim = hover !== null && !highlight.has(node.id);
            const isHover = node.id === hover;
            const isSelected = selected && selected.id === node.id;

            ctx2d.globalAlpha = dim ? 0.18 : 1;
            // 光晕（核心更大）
            const glowMul = node.core ? 5 : isHover ? 4.2 : 2.6;
            const glowR = node.r * glowMul;
            const glow = ctx2d.createRadialGradient(node.x, node.y, 0, node.x, node.y, glowR);
            glow.addColorStop(0, color + (isHover || node.core ? "cc" : "77"));
            glow.addColorStop(0.45, color + "22");
            glow.addColorStop(1, color + "00");
            ctx2d.fillStyle = glow;
            ctx2d.beginPath();
            ctx2d.arc(node.x, node.y, glowR, 0, Math.PI * 2);
            ctx2d.fill();

            // 实心核
            ctx2d.fillStyle = color;
            ctx2d.beginPath();
            ctx2d.arc(node.x, node.y, node.r * (isHover ? 1.25 : 1), 0, Math.PI * 2);
            ctx2d.fill();

            // 核心加白色描边
            if (node.core) {
              ctx2d.globalAlpha = dim ? 0.18 : 0.85;
              ctx2d.strokeStyle = "#ffffff";
              ctx2d.lineWidth = 1.6;
              ctx2d.beginPath();
              ctx2d.arc(node.x, node.y, node.r + 3, 0, Math.PI * 2);
              ctx2d.stroke();
            }

            // 选中描边
            if (isSelected) {
              ctx2d.globalAlpha = 0.9;
              ctx2d.strokeStyle = "#ffffff";
              ctx2d.lineWidth = 1.4;
              ctx2d.beginPath();
              ctx2d.arc(node.x, node.y, node.r * 1.9, 0, Math.PI * 2);
              ctx2d.stroke();
            }

            // 名字：核心常显，其余够大或悬停时显示
            if (!dim && (node.core || node.r > 6.5 || isHover || view.scale > 1.35)) {
              ctx2d.globalAlpha = isHover || node.core ? 1 : 0.72;
              ctx2d.fillStyle = node.core ? "#ffffff" : "#cfe9f7";
              ctx2d.font = (node.core ? "bold 13px" : "11px") + " 'Microsoft YaHei', sans-serif";
              ctx2d.textAlign = "center";
              ctx2d.textBaseline = "top";
              ctx2d.fillText(node.name, node.x, node.y + node.r + 3);
            }
          }

          ctx2d.globalAlpha = 1;
          ctx2d.restore();

          frame++;
          // 前 ~220 帧全力模拟，之后降速保温（省电，又能轻微呼吸）
          if (frame > 220) energy = Math.max(0.06, energy * 0.985);
          tick(sim, energy);
          raf = requestAnimationFrame(draw);
        }

        function screenToWorld(clientX, clientY) {
          const rect = canvas.getBoundingClientRect();
          const view = viewRef.current;
          return {
            x: (clientX - rect.left - rect.width / 2 - view.ox) / view.scale,
            y: (clientY - rect.top - rect.height / 2 - view.oy) / view.scale,
          };
        }

        function pick(clientX, clientY) {
          if (!sim) return null;
          const p = screenToWorld(clientX, clientY);
          let best = null;
          let bestD = Infinity;
          for (const node of sim.nodes) {
            const d = Math.hypot(node.x - p.x, node.y - p.y);
            const hitR = Math.max(12, node.r * 2.2);
            if (d < hitR && d < bestD) {
              best = node;
              bestD = d;
            }
          }
          return best;
        }

        let dragging = null;
        let moved = false;
        let downX = 0;
        let downY = 0;
        // 空白区域拖拽平移
        let panning = false;
        let panStartX = 0;
        let panStartY = 0;
        let panStartOx = 0;
        let panStartOy = 0;

        function onPointerDown(ev) {
          const node = pick(ev.clientX, ev.clientY);
          if (node) {
            // 点在节点上 → 拖这个节点
            dragging = node;
            sim.dragging = node;
            moved = false;
            downX = ev.clientX;
            downY = ev.clientY;
            canvas.setPointerCapture(ev.pointerId);
          } else {
            // 点在空白处 → 平移整张图
            panning = true;
            panStartX = ev.clientX;
            panStartY = ev.clientY;
            const view = viewRef.current;
            panStartOx = view.ox;
            panStartOy = view.oy;
            canvas.setPointerCapture(ev.pointerId);
            canvas.style.cursor = "grabbing";
          }
        }

        function onPointerMove(ev) {
          if (dragging) {
            const p = screenToWorld(ev.clientX, ev.clientY);
            dragging.x = p.x;
            dragging.y = p.y;
            dragging.vx = 0;
            dragging.vy = 0;
            // 移动超过 6 像素才算拖动，避免点击时的轻微抖动被误判成拖动
            if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 6) moved = true;
            return;
          }
          if (panning) {
            const view = viewRef.current;
            view.ox = panStartOx + (ev.clientX - panStartX);
            view.oy = panStartOy + (ev.clientY - panStartY);
            return;
          }
          const node = pick(ev.clientX, ev.clientY);
          hoverRef.current = node ? node.id : null;
          canvas.style.cursor = node ? "pointer" : "grab";
        }

        function onPointerUp(ev) {
          if (dragging) {
            const wasDragging = moved;
            sim.dragging = null;
            if (!wasDragging) {
              // 没拖动就是点击 → 选中并弹详情（含这个节点关联的记忆列表）
              const related = (sim.memories || []).filter((m) => (m.entities || []).includes(dragging.id));
              setSelected({ id: dragging.id, name: dragging.name, type: dragging.type, degree: dragging.degree, side: dragging.side, core: dragging.core, contextFile: dragging.contextFile, content: dragging.content, category: dragging.category, memories: related });
            }
            dragging = null;
            try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
            return;
          }
          if (panning) {
            panning = false;
            canvas.style.cursor = "grab";
            try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
          }
        }

        function onWheel(ev) {
          ev.preventDefault();
          const view = viewRef.current;
          const rect = canvas.getBoundingClientRect();
          const mx = ev.clientX - rect.left;
          const my = ev.clientY - rect.top;
          const factor = ev.deltaY < 0 ? 1.12 : 0.89;
          const newScale = Math.min(3.2, Math.max(0.35, view.scale * factor));
          if (newScale === view.scale) return;
          // 围绕鼠标位置缩放：保持鼠标下的世界坐标不动
          const worldX = (mx - rect.width / 2 - view.ox) / view.scale;
          const worldY = (my - rect.height / 2 - view.oy) / view.scale;
          view.scale = newScale;
          view.ox = mx - rect.width / 2 - worldX * newScale;
          view.oy = my - rect.height / 2 - worldY * newScale;
        }

        canvas.addEventListener("pointerdown", onPointerDown);
        canvas.addEventListener("pointermove", onPointerMove);
        canvas.addEventListener("pointerup", onPointerUp);
        canvas.addEventListener("wheel", onWheel, { passive: false });

        // 异步加载图数据，加载完成后启动动画循环
        (async () => {
          let graph;
          try {
            const r = await fetch("/nebula/graph", { cache: "no-store" });
            if (!r.ok) throw new Error("HTTP " + r.status);
            graph = await r.json();
          } catch (e) {
            if (alive) setStats({ error: String((e && e.message) || e) });
            return;
          }
          if (!alive) return;
          sim = buildSimulation(graph);
          simRef.current = sim;
          const hostN = sim.nodes.filter((n) => n.side === "host").length;
          const qqN = sim.nodes.filter((n) => n.side === "qq").length;
          setStats({ nodes: sim.nodes.length, edges: sim.edges.length, memories: (graph.memories || []).length, hostN, qqN });
          raf = requestAnimationFrame(draw);
        })();

        return () => {
          alive = false;
          cancelAnimationFrame(raf);
          canvas.removeEventListener("pointerdown", onPointerDown);
          canvas.removeEventListener("pointermove", onPointerMove);
          canvas.removeEventListener("pointerup", onPointerUp);
          canvas.removeEventListener("wheel", onWheel);
        };
      }, []);

      // 不可见时暂停渲染（切到别的 tab 就不烧 GPU）
      react.useEffect(() => {
        // requestAnimationFrame 在不可见标签页本来也会节流，这里只做标记
      }, [visible]);

      const selectedColor = selected
        ? selected.core
          ? CORE_COLOR[selected.side] || "#ffffff"
          : TYPE_COLOR[selected.type] || TYPE_COLOR.thing
        : "#62ddff";

      return h(
        "div",
        { style: { position: "relative", width: "100%", height: "100%", overflow: "hidden", background: "#03070d" } },
        h("canvas", {
          ref: canvasRef,
          style: { display: "block", width: "100%", height: "100%", touchAction: "none" },
        }),
        // 空状态提示（插件只提供框架，内容需要自己写入）
        stats && !stats.error && stats.nodes === 0 && h(
          "div",
          {
            style: {
              position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
              textAlign: "center", pointerEvents: "none",
              font: "13px/2 'Microsoft YaHei', sans-serif", color: "#3d6478", maxWidth: 460,
            },
          },
          h("div", { style: { fontSize: 16, color: "#4e8299", marginBottom: 10, letterSpacing: "2px" } }, "星云还是空的"),
          h("div", null, "这个插件只提供框架，内容需要自己写入："),
          h("div", { style: { marginTop: 6 } }, "① memory_write 写一条记忆"),
          h("div", null, "② nebula_extract 抽取实体"),
          h("div", null, "③ 刷新本图 —— 节点就长出来了"),
          stats.memories > 0 && h(
            "div",
            { style: { marginTop: 10, color: "#5e8aa3" } },
            `（当前已有 ${stats.memories} 条记忆，但还没抽取实体）`
          )
        ),
        // 左上统计
        h(
          "div",
          {
            style: {
              position: "absolute", left: 12, top: 10, pointerEvents: "none",
              font: "11px/1.7 Consolas, monospace", color: "#4e758a", letterSpacing: ".5px",
            },
          },
          stats && stats.error
            ? "图数据加载失败：" + stats.error
            : stats
              ? `主工作区 ${stats.hostN} · 次工作区 ${stats.qqN} · 边 ${stats.edges} · 记忆 ${stats.memories}`
              : "正在加载…"
        ),
        // 右上品牌
        h(
          "div",
          {
            style: {
              position: "absolute", right: 14, top: 9, pointerEvents: "none",
              font: "12px/1.6 'Microsoft YaHei', sans-serif", color: "#2f5d78", letterSpacing: "3px",
            },
          },
          "记忆星云"
        ),
        // 底部提示
        h(
          "div",
          {
            style: {
              position: "absolute", left: 12, bottom: 8, pointerEvents: "none",
              font: "10px/1.6 Consolas, monospace", color: "#2b4658",
            },
          },
          "拖拽节点 · 滚轮缩放 · 点节点看详情"
        ),
        // 详情卡
        selected &&
          h(
            "div",
            {
              style: {
                position: "absolute", right: 12, bottom: 26, maxWidth: 320,
                padding: "10px 14px", borderRadius: 10,
                background: "rgba(6,18,30,.9)",
                border: "1px solid rgba(84,231,255,.22)",
                boxShadow: "0 0 24px rgba(84,231,255,.10)",
                font: "12px/1.7 'Microsoft YaHei', sans-serif", color: "#a9d7ea",
              },
            },
            h("div", { style: { fontSize: 14, color: selectedColor, marginBottom: 2 } }, selected.name),
            h("div", { style: { color: "#4e758a", fontSize: 11 } }, `${SIDE_CN[selected.side] || ""}${selected.core ? " · 核心" : ""} · ${TYPE_CN[selected.type] || selected.type} · 连接 ${selected.degree}`),
            selected.type === "persona" && selected.content && h(
              "div",
              { style: { marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(255,224,138,.22)" } },
              h("div", { style: { color: "#ffe08a", fontSize: 10, marginBottom: 3 } }, "人格内容" + (selected.category ? " · " + selected.category : "")),
              h("div", { style: { color: "#a9d7ea", fontSize: 12, lineHeight: 1.6 } }, selected.content)
            ),
            selected.contextFile && h(
              "div",
              { style: { color: "#3a5a70", fontSize: 9, marginTop: 3, fontFamily: "Consolas, monospace", wordBreak: "break-all" } },
              "目录：" + selected.contextFile
            ),
            selected.memories && selected.memories.length > 0 && h(
              "div",
              { style: { marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(84,231,255,.14)" } },
              h("div", { style: { color: "#62ddff", fontSize: 11, marginBottom: 4 } }, `关联记忆 ${selected.memories.length} 条`),
              h(
                "div",
                { style: { maxHeight: 210, overflowY: "auto", paddingRight: 2 } },
                selected.memories.map((m) =>
                  h(
                    "div",
                    { key: m.id, style: { marginBottom: 8, padding: "6px 8px", borderRadius: 6, background: "rgba(84,231,255,.05)" } },
                    h("div", { style: { color: "#a9d7ea", fontSize: 12, lineHeight: 1.5 } }, m.text),
                    h("div", { style: { color: "#5e8aa3", fontSize: 10, marginTop: 3, fontFamily: "Consolas, monospace", wordBreak: "break-all" } }, m.name),
                    h("div", { style: { color: "#3a5a70", fontSize: 9, marginTop: 1, fontFamily: "Consolas, monospace", wordBreak: "break-all" } }, m.file)
                  )
                )
              )
            ),
            h(
              "button",
              {
                onClick: () => setSelected(null),
                style: {
                  marginTop: 8, background: "transparent", border: "1px solid rgba(84,231,255,.28)",
                  color: "#62ddff", borderRadius: 6, padding: "2px 10px", cursor: "pointer", fontSize: 11,
                },
              },
              "关闭"
            )
          )
      );
    }

    // ── 注册入口（侧栏 tab + 侧栏面板列表 + 全屏主面板）─────────────
    const inject = ["betterSidebar", "slots"];
    const PANEL_ID = "memory-nebula";

    // 侧栏面板列表的图标（星云：中心球 + 卫星 + 连线）
    function NebulaPanelIcon() {
      return h("svg", {
        width: 18, height: 18, viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round",
      },
        h("circle", { cx: 12, cy: 12, r: 2.6, fill: "currentColor", stroke: "none" }),
        h("circle", { cx: 5.5, cy: 7, r: 1.5 }),
        h("circle", { cx: 18.5, cy: 6.5, r: 1.3 }),
        h("circle", { cx: 18, cy: 18, r: 1.4 }),
        h("circle", { cx: 6, cy: 17.5, r: 1.2 }),
        h("line", { x1: 7.1, y1: 7.7, x2: 9.8, y2: 10 }),
        h("line", { x1: 17.5, y1: 7.3, x2: 14.3, y2: 10.4 }),
        h("line", { x1: 17.2, y1: 17.1, x2: 14.1, y2: 14 }),
        h("line", { x1: 7.2, y1: 16.9, x2: 9.9, y2: 14 })
      );
    }

    function apply(ctx) {
      // 1. 侧栏「+」菜单里的 tab（保留：侧栏内小窗打开）
      ctx.effect(
        () =>
          ctx.betterSidebar.registerTab({
            id: "memory-nebula",
            title: "记忆星云",
            description: "把记忆画成一张会呼吸的星云",
            order: 40,
            single: true,
            component: (props) => h(NebulaView, props),
          }),
        "dsh-memory-nebula: sidebar tab"
      );

      // 2. 侧栏面板列表入口（DSH 原生，像 auto-memory 那样直接在侧栏显示）
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register({
          name: "sidebar.panellist",
          id: PANEL_ID,
          order: 40,
          label: () => "记忆星云",
        }, NebulaPanelIcon)
      );

      // 3. 全屏主面板（点侧栏入口后打开）
      ctx.slots.inject("main", () =>
        ctx.slots.register({
          name: "main",
          key: PANEL_ID,
        }, (props) => h(NebulaView, props))
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
