import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// lib/collection.js
/** 中文 bigram + ASCII 词 */
function tokenize(text) {
	const norm = text.toLowerCase();
	const tokens = [];
	for (const w of norm.match(/[a-z0-9]+/g) ?? []) tokens.push(w);
	for (const run of norm.match(/[\u4e00-\u9fff]+/g) ?? []) if (run.length === 1) tokens.push(run);
	else for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
	return tokens;
}
/** 内置法律概念同义表：检索时自动补齐相关表述，提升召回。仅本地静态映射，零网络。 */
const LEGAL_CONCEPTS = [
	["合同无效", [
		"效力性强制性规定",
		"无效后果",
		"合同效力",
		"自始无效"
	]],
	["效力性强制性规定", [
		"强制性规定",
		"合同无效",
		"规范性质",
		"管理性强制性规定"
	]],
	["管理性强制性规定", [
		"强制性规定",
		"规范性质",
		"合同效力",
		"效力性强制性规定"
	]],
	["合同效力", [
		"合同有效",
		"无效",
		"可撤销",
		"效力待定"
	]],
	["情势变更", [
		"不可抗力",
		"继续履行",
		"再交涉",
		"公平原则",
		"解除合同"
	]],
	["不可抗力", [
		"情势变更",
		"免责事由",
		"解除合同",
		"不能预见"
	]],
	["合同解除", [
		"解除权",
		"通知解除",
		"解除后果",
		"违约方解除",
		"根本违约"
	]],
	["根本违约", ["合同解除", "不能实现合同目的"]],
	["违约责任", [
		"损害赔偿",
		"违约金",
		"继续履行",
		"可预见性规则"
	]],
	["违约金", [
		"违约金调整",
		"过分高于损失",
		"实际损失",
		"违约责任"
	]],
	["定金", [
		"定金罚则",
		"违约金",
		"定金返还"
	]],
	["表见代理", [
		"无权代理",
		"善意相对人",
		"合理信赖",
		"越权代理"
	]],
	["善意取得", [
		"无权处分",
		"善意第三人",
		"合理价格",
		"不动产物权"
	]],
	["侵权责任", [
		"过错责任",
		"因果关系",
		"损害赔偿",
		"归责原则"
	]],
	["共同侵权", [
		"连带责任",
		"意思联络",
		"帮助侵权"
	]],
	["格式条款", [
		"提示说明义务",
		"格式条款无效",
		"不利解释",
		"免责条款"
	]],
	["保证", [
		"保证期间",
		"连带责任保证",
		"一般保证",
		"保证合同"
	]],
	["抵押", [
		"抵押权",
		"抵押登记",
		"优先受偿",
		"动产抵押"
	]],
	["股权", [
		"股东资格",
		"股权转让",
		"股东出资",
		"公司决议"
	]],
	["股东出资", [
		"出资不实",
		"抽逃出资",
		"股东资格",
		"发起人责任"
	]],
	["法人人格否认", [
		"刺破公司面纱",
		"财产混同",
		"滥用法人独立地位",
		"连带责任"
	]],
	["劳动合同", [
		"劳动关系",
		"经济补偿",
		"违法解除",
		"竞业限制"
	]],
	["电子合同", [
		"电子签名",
		"要约承诺",
		"数据电文",
		"电子证据"
	]],
	["诉讼时效", [
		"时效抗辩",
		"时效中断",
		"时效中止",
		"普通诉讼时效"
	]],
	["举证责任", [
		"证明责任",
		"举证责任倒置",
		"高度盖然性",
		"证据规则"
	]]
];
/**
* 概念扩展：query 命中概念表中的主词时，补充其同义表述。
* @returns {string[]} 需要追加进检索词的扩展词（不含 query 原有内容）
*/
function expandQuery(query) {
	const norm = query.toLowerCase();
	const extras = [];
	for (const [term, syns] of LEGAL_CONCEPTS) if (norm.includes(term)) {
		for (const s of syns) if (!norm.includes(s) && !extras.includes(s)) extras.push(s);
	}
	return extras;
}
function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** 把 terms 在 text 中的出现用【】标出（长词优先，单遍替换不嵌套） */
function highlightTerms(text, terms) {
	const uniq = [...new Set((terms ?? []).filter((t) => t && t.length >= 2))].sort((a, b) => b.length - a.length);
	if (!uniq.length) return text;
	const re = new RegExp(uniq.map(escapeRe).join("|"), "g");
	return text.replace(re, (m) => `【${m}】`);
}
/** 提取 query 的展示词：按空白切分、去首尾标点、取长度 >=2 的词 */
function queryTerms(query) {
	return (query.match(/[^\s]+/g) ?? []).map((t) => t.replace(/^[^\u4e00-\u9fffA-Za-z0-9]+|[^\u4e00-\u9fffA-Za-z0-9]+$/g, "")).filter((t) => t.length >= 2);
}
/** 在文本中选一个覆盖命中词最多的窗口 */
function pickSnippet(text, terms, width = 200) {
	if (text.length <= width) return text;
	const uniq = [...new Set(terms.filter(Boolean))];
	if (!uniq.length) return text.slice(0, width) + "…";
	let best = {
		pos: 0,
		hits: -1
	};
	for (const term of uniq) {
		let idx = text.indexOf(term);
		while (idx >= 0) {
			const start = Math.max(0, idx - Math.floor(width / 3));
			const win = text.slice(start, start + width);
			const hits = uniq.reduce((s, t) => s + (win.includes(t) ? 1 : 0), 0);
			if (hits > best.hits) best = {
				pos: start,
				hits
			};
			idx = text.indexOf(term, idx + 1);
		}
	}
	const start = best.pos;
	return (start > 0 ? "…" : "") + text.slice(start, start + width) + (start + width < text.length ? "…" : "");
}

// src/host/libstore.ts
var LawLibraryStore = class {
	dir;
	data = null;
	loadedAt = 0;
	constructor(dir) {
		this.dir = dir;
	}
	async load(force = false) {
		if (this.data && !force && Date.now() - this.loadedAt < 2e3) return this.data;
		try {
			const raw = await readFile(join(this.dir, "library.json"), "utf8");
			this.data = JSON.parse(raw);
		} catch {
			this.data = {
				version: 2,
				nextId: 1,
				papers: []
			};
		}
		for (const p of this.data.papers) {
			if (!Array.isArray(p.notes)) p.notes = [];
			if (p.progress === void 0) p.progress = null;
		}
		this.loadedAt = Date.now();
		return this.data;
	}
	/** 回写前强制重读，减小与 cnki-assist 工具侧并发写互覆的窗口 */
	async mutate(fn) {
		const lib = await this.load(true);
		const result = await fn(lib);
		lib.version = 2;
		if (!lib.nextNoteId) lib.nextNoteId = 1;
		await mkdir(this.dir, { recursive: true });
		await writeFile(join(this.dir, "library.json"), JSON.stringify(lib), "utf8");
		return result;
	}
	async state() {
		const lib = await this.load(true);
		return {
			library_dir: this.dir,
			count: lib.papers.length,
			papers: lib.papers.map((p) => ({
				id: p.id,
				title: p.title,
				pages: p.pages ?? null,
				chars: p.text.length,
				chunks: p.chunks.length,
				added_at: p.addedAt,
				notes: (p.notes ?? []).length,
				progress: p.progress ? {
					offset: p.progress.offset,
					pct: Math.round(p.progress.offset / Math.max(1, p.text.length) * 100)
				} : null
			}))
		};
	}
	async search(query, topK = 8, opts = {}) {
		const lib = await this.load();
		const expand = opts.expand !== false;
		const highlight = opts.highlight !== false;
		const extras = expand ? expandQuery(query) : [];
		const qt = tokenize(query + (extras.length ? " " + extras.join(" ") : ""));
		if (!qt.length) return {
			expanded: extras,
			results: []
		};
		const terms = [.../* @__PURE__ */ new Set([...queryTerms(query), ...extras])];
		const chunkTokens = [];
		const refs = [];
		for (const p of lib.papers) {
			if (opts.paper_id && p.id !== opts.paper_id && p.title !== opts.paper_id) continue;
			p.chunks.forEach((_, i) => {
				chunkTokens.push(tokenize(p.chunks[i]));
				refs.push({
					paper: p,
					chunkIndex: i
				});
			});
		}
		const N = chunkTokens.length;
		const avgLen = chunkTokens.reduce((s, t) => s + t.length, 0) / (N || 1) || 1;
		const df = /* @__PURE__ */ new Map();
		for (const tokens of chunkTokens) for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
		const k1 = 1.5;
		const b = .75;
		const scores = new Array(N).fill(0);
		for (const q of new Set(qt)) {
			const d = df.get(q);
			if (!d) continue;
			const idf = Math.log(1 + (N - d + .5) / (d + .5));
			for (let i = 0; i < N; i++) {
				let tf = 0;
				for (const t of chunkTokens[i]) if (t === q) tf++;
				if (!tf) continue;
				scores[i] += idf * (tf * 2.5) / (tf + k1 * (.25 + b * chunkTokens[i].length / avgLen));
			}
		}
		return {
			expanded: extras,
			results: scores.map((score, i) => ({
				i,
				score
			})).filter((x) => x.score > 0).sort((a, b2) => b2.score - a.score).slice(0, topK).map(({ i, score }) => {
				const raw = pickSnippet(refs[i].paper.chunks[refs[i].chunkIndex], terms);
				return {
					paper_id: refs[i].paper.id,
					title: refs[i].paper.title,
					chunk_index: refs[i].chunkIndex,
					score: Math.round(score * 100) / 100,
					snippet: highlight ? highlightTerms(raw, terms) : raw
				};
			})
		};
	}
	async read(paperId, offset = 0, limit = 6e3) {
		const p = (await this.load()).papers.find((x) => x.id === paperId || x.title === paperId);
		if (!p) return null;
		return {
			id: p.id,
			title: p.title,
			total_chars: p.text.length,
			offset,
			limit,
			text: p.text.slice(offset, offset + limit),
			has_more: offset + limit < p.text.length,
			progress: p.progress ?? null
		};
	}
	async outline(paperId, maxItems = 30) {
		const p = (await this.load()).papers.find((x) => x.id === paperId || x.title === paperId);
		if (!p) return null;
		const heads = p.text.split("\n").map((l) => l.trim()).filter((l) => /^[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十]+[)）]|第[一二三四五六七八九十\d]+[部分章节章]|^\d+[、.．]\s*\S/.test(l) && l.length < 60);
		return {
			id: p.id,
			title: p.title,
			headings: heads.slice(0, maxItems)
		};
	}
	async addNote(paperId, fields) {
		if (!fields.comment || !String(fields.comment).trim()) return { error: "批注内容不能为空" };
		return this.mutate((lib) => {
			const p = lib.papers.find((x) => x.id === paperId || x.title === paperId);
			if (!p) return { error: "未找到该文献" };
			if (!Array.isArray(p.notes)) p.notes = [];
			if (!lib.nextNoteId) lib.nextNoteId = 1;
			const note = {
				id: "n" + lib.nextNoteId++,
				quote: String(fields.quote ?? "").slice(0, 500),
				comment: String(fields.comment).slice(0, 2e3),
				chunk_index: Number.isInteger(fields.chunk_index) ? fields.chunk_index : null,
				created_at: (/* @__PURE__ */ new Date()).toISOString()
			};
			p.notes.push(note);
			return {
				note,
				paper: {
					id: p.id,
					title: p.title
				}
			};
		});
	}
	async removeNote(paperId, noteId) {
		return this.mutate((lib) => {
			const p = lib.papers.find((x) => x.id === paperId || x.title === paperId);
			if (!p || !Array.isArray(p.notes)) return { removed: false };
			const i = p.notes.findIndex((n) => n.id === noteId);
			if (i < 0) return { removed: false };
			p.notes.splice(i, 1);
			return { removed: true };
		});
	}
	async listNotes(paperId) {
		const lib = await this.load();
		const papers = paperId ? lib.papers.filter((p) => p.id === paperId || p.title === paperId) : lib.papers;
		const out = [];
		for (const p of papers) for (const n of p.notes ?? []) out.push({
			paper_id: p.id,
			title: p.title,
			...n
		});
		return { notes: out };
	}
	async setProgress(paperId, offset) {
		return this.mutate((lib) => {
			const p = lib.papers.find((x) => x.id === paperId || x.title === paperId);
			if (!p) return { error: "未找到该文献" };
			p.progress = {
				offset: Math.max(0, Math.min(Number(offset) || 0, p.text.length)),
				updated_at: (/* @__PURE__ */ new Date()).toISOString()
			};
			return { progress: p.progress };
		});
	}
};
function resolveLibraryDir(config) {
	return config?.libraryDir || join(homedir(), ".dsh", "law-library");
}

// src/host/index.ts
const name = "law-workbench";
function apply(ctx, config = {}) {
	const store = new LawLibraryStore(resolveLibraryDir(config));
	const json = (body, status = 200) => new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" }
	});
	const routes = [
		{
			path: "/api/law-workbench/state",
			fetch: async () => json(await store.state())
		},
		{
			path: "/api/law-workbench/search",
			fetch: async (request) => {
				const body = await request.json().catch(() => ({}));
				if (!body.query) return json({ error: "缺少 query" }, 400);
				return json(await store.search(body.query, body.top_k ?? 8, {
					expand: body.expand,
					highlight: body.highlight,
					paper_id: body.paper_id
				}));
			}
		},
		{
			path: "/api/law-workbench/read",
			fetch: async (request) => {
				const body = await request.json().catch(() => ({}));
				if (!body.paper_id) return json({ error: "缺少 paper_id" }, 400);
				const r = await store.read(body.paper_id, body.offset ?? 0, body.limit ?? 6e3);
				if (!r) return json({ error: "未找到该文献" }, 404);
				return json(r);
			}
		},
		{
			path: "/api/law-workbench/outline",
			fetch: async (request) => {
				const body = await request.json().catch(() => ({}));
				if (!body.paper_id) return json({ error: "缺少 paper_id" }, 400);
				const r = await store.outline(body.paper_id);
				if (!r) return json({ error: "未找到该文献" }, 404);
				return json(r);
			}
		},
		{
			path: "/api/law-workbench/notes",
			fetch: async (request) => {
				const body = await request.json().catch(() => ({}));
				return json(await store.listNotes(body.paper_id));
			}
		},
		{
			path: "/api/law-workbench/note",
			fetch: async (request) => {
				const body = await request.json().catch(() => ({}));
				if (body.action === "remove") {
					if (!body.paper_id || !body.note_id) return json({ error: "删除笔记需要 paper_id 与 note_id" }, 400);
					return json(await store.removeNote(body.paper_id, body.note_id));
				}
				if (!body.paper_id) return json({ error: "添加笔记需要 paper_id" }, 400);
				const r = await store.addNote(body.paper_id, {
					quote: body.quote,
					comment: body.comment,
					chunk_index: body.chunk_index ?? null
				});
				if ("error" in r) return json(r, 400);
				return json(r);
			}
		},
		{
			path: "/api/law-workbench/progress",
			fetch: async (request) => {
				const body = await request.json().catch(() => ({}));
				if (!body.paper_id) return json({ error: "缺少 paper_id" }, 400);
				const r = await store.setProgress(body.paper_id, body.offset ?? 0);
				if ("error" in r) return json(r, 404);
				return json(r);
			}
		}
	];
	const connection = ctx.get("connection");
	const register = connection?.fetch?.register?.bind(connection.fetch);
	if (typeof register === "function") for (const route of routes) try {
		ctx.effect(() => register({
			path: route.path,
			methods: ["POST"],
			requestBody: "buffered",
			fetch: route.fetch
		}), `law-workbench: ${route.path}`);
	} catch {}
	else ctx.logger?.warn?.("[law-workbench] connection.fetch.register 不可用，面板将无数据");
}

export { apply, name };