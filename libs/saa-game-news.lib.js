/* =====================================================================
 * Steam AI Agent —— 游戏热点模块（saa-game-news.lib.js）
 * =====================================================================
 * 职责：聚合专业游戏资讯站头条 + 热点浮窗 UI（居中弹窗，入口按钮由宿主面板头部提供）
 *       + **浮窗顶部标题栏右侧的增强搜索框**（v1.3.0 新增）。
 *
 * 增强搜索框（v1.3.0）：标题栏右侧输入关键字 → 一次请求产出三组结果，
 *   以**条目化下拉列表**展示，点条目在浏览器新标签打开原始页面：
 *   ① 本地热点匹配 —— 零成本，命中已聚合到内存的条目
 *   ② 网页检索     —— 宿主注入 webSearch（DeepSeek /v1/tools/search），联网拿实时新闻
 *   ③ AI 速览      —— 宿主注入 chat（模型 API），**以②的检索结果为上下文**做总结并挑页面
 *                      （把检索结果喂进去，是为了压住模型凭空编造链接）
 *
 * 设计原则：**与主脚本的 AI Agent 逻辑完全解耦**——本库不引用主脚本任何变量，
 *          只通过 window.SAAGameNews 暴露 API；主脚本侧仅做 loader + 薄工具注册。
 *          检索能力同样靠注入（setSearchProviders）：宿主不注入时搜索框退化为
 *          「仅本地匹配」，不报错、不影响其余功能（按能力降级，不整体拒绝挂载）。
 *
 * 导出 API（window.SAAGameNews）：
 *   SOURCES            当前启用的源定义（可运行时增删，便于扩展）
 *   addSource(src)     运行时追加一个源（无需改主脚本）
 *   fetchSource(src)   抓取单个源 → {id,label,items,error}
 *   getDigest(opts)    聚合全部源（带 TTL 缓存 + 并发去重）
 *   clearCache()       清空聚合缓存
 *   setFetcher(fn)     注入模型侧抓取能力（dsfetch 型源用）
 *   setSearchProviders(p) 注入检索能力 { webSearch, chat }（标题栏搜索框用）
 *   search(q, opts)    执行一次增强搜索 → { query, groups[], local[], errors[] }
 *   runHeaderSearch(q) 跑一次搜索并渲染下拉（UI 层）
 *   mountButton()      [已弃用 v1.1.0] 旧版页面悬浮入口，保留仅为兼容；入口现由宿主面板头部按钮提供
 *   unmountButton()    卸载入口与浮窗
 *   VERSION            库版本
 *
 * 依赖：仅需宿主提供 GM_xmlhttpRequest（与主脚本同一沙箱）。
 * ===================================================================== */
(function (root) {
    'use strict';

    const VERSION = '1.3.0';
    const STORAGE_KEY = 'saa_game_news_sources_v1';   // 用户自定义源（GM 存储键，宿主注入）

    const DEFAULTS = {
        TTL: 30 * 60 * 1000,          // 直连型源（RSS/HTML）聚合缓存 30 分钟
        FETCH_TTL: 24 * 60 * 60 * 1000, // dsfetch 型源（走模型侧 fetch）缓存 24 小时——每天抓一次即可
        FETCH_TIMEOUT: 15000,
        DS_FETCH_TIMEOUT: 45000,
        PER_SOURCE: 8,
        CACHE_MAX_SOURCES: 32,        // 自定义源上限，防刷
        // ---- v1.3.0 标题栏增强搜索 ----
        SEARCH_DEBOUNCE_MS: 420,      // 输入防抖（联网检索很贵，别每敲一个字就打一次接口）
        SEARCH_TOP_N: 10,             // 向下游检索接口要的条数
        SEARCH_ITEM_LIMIT: 8,         // 下拉列表每组最多展示条数
        SEARCH_CACHE_TTL: 10 * 60 * 1000, // 同 query 结果缓存 10 分钟（省 Key 额度）
        SEARCH_CACHE_MAX: 16,         // 缓存条目上限（LRU 近似：超出丢最老的）
        SEARCH_CTX_MAX: 8,            // 送给模型当上下文的结果条数
        SEARCH_CTX_CHARS: 400,        // 送给模型时单条摘要裁剪上限
        SEARCH_AI_CHARS: 1200,        // 模型速览文本展示上限
    };

    /* ---------------- 源注册表 ---------------- */
    // type: 'rss'      解析 <item> 里的 title/link/pubDate/description
    // type: 'html'     用 linkRe 从页面 HTML 抓「链接 + 锚文本」对（标题即锚文本）
    // type: 'dsfetch'  走模型侧 webFetch 拿渲染后的 markdown，再由 parseXhhMarkdown 解析
    //
    // ⚠️ 为什么前两类不走模型侧 webFetch：
    //    实测抓 gamersky 首页能返回内容，但**所有标题都丢了**（只剩导航文字与时间戳），
    //    因为标题包在 <a> 里而 markdown 抽取会剥掉链接文字。
    // ⚠️ 为什么小黑盒必须走 webFetch：
    //    小黑盒是 SPA，直连拿到的只有 3.4KB 的空壳（所有 URL 返回完全相同的 HTML），
    //    但**模型侧 webFetch 会执行 JS**，/app/news 能拿到真实头条。
    const BUILTIN_SOURCES = [
        { id: 'heybox', label: '小黑盒', type: 'dsfetch', url: 'https://www.xiaoheihe.cn/app/news', parser: 'xhh' },
        { id: 'gcores', label: '机核', type: 'rss', url: 'https://www.gcores.com/rss' },
        { id: '3dm', label: '3DM', type: 'html', url: 'https://www.3dmgame.com/news/', linkRe: /<a\s+href="([^"]*\/news\/\d+\/\d+\.html)"[^>]*>([^<]{4,80})<\/a>/g },
        { id: 'gamersky', label: '游民星空', type: 'html', url: 'https://www.gamersky.com/news/', linkRe: /<a\s+href="([^"]*\/news\/\d{6}\/\d+\.shtml)"[^>]*>([^<]{4,80})<\/a>/g },
    ];
    // 注：Steam 官方 feed 实测为中英混杂且比例随时间波动（一次 3/10、一次 0/8 全英文），
    // 与「要中文」的目标冲突，默认已移除。需要时可自行 addSource 追加：
    //   { id:'steam', label:'Steam 官方', type:'rss', url:'https://store.steampowered.com/feeds/news/?l=schinese' }

    /* ---------------- 运行时源管理 ---------------- */
    let _custom = [];
    function loadCustom(gmGetValue) {
        try {
            const raw = typeof gmGetValue === 'function' ? gmGetValue(STORAGE_KEY, '') : '';
            const arr = raw ? JSON.parse(raw) : [];
            _custom = Array.isArray(arr) ? arr.filter(s => s && s.id && s.url && (s.type === 'rss' || s.type === 'html')).slice(0, DEFAULTS.CACHE_MAX_SOURCES) : [];
        } catch (e) { _custom = []; }
    }
    function getSources() { return BUILTIN_SOURCES.concat(_custom); }
    function addSource(src) {
        if (!src || !src.id || !src.url || !src.linkRe) return { ok: false, error: '源定义需含 id/url/type/linkRe' };
        if (getSources().some(s => s.id === src.id)) return { ok: false, error: `来源 ${src.id} 已存在` };
        _custom.push(src);
        return { ok: true, total: getSources().length };
    }

    /* ---------------- 文本工具 ---------------- */
    function decodeHtmlEntities(s) {
        return String(s || '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
            .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
    }
    function absUrl(u, base) {
        const s = String(u || '').trim();
        if (!s || s.startsWith('#') || /^javascript:/i.test(s)) return '';
        try { return new URL(s, base).href; } catch { return ''; }
    }
    /** 是否含中日韩统一表意文字 —— 用于中文优先排序 */
    function isChinese(s) {
        const t = String(s || '');
        const cjk = (t.match(/[一-鿿㐀-䶿]/g) || []).length;
        // 阈值：少量汉字（如 "Steam Deck OLED 512GB" 里带一个"版"）不算中文条目
        return cjk >= 2 || (t.length >= 6 && cjk >= 1 && cjk / t.length >= 0.2);
    }

    /* ---------------- 解析 ---------------- */
    function parseRssItems(xml, base, limit) {
        const out = [];
        const items = String(xml).match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
        for (const raw of items) {
            if (out.length >= limit) break;
            const pick = (tag) => {
                const m = raw.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
                return m ? m[1] : '';
            };
            const strip = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
            const title = decodeHtmlEntities(strip(pick('title')).trim());
            let link = strip(pick('link')).trim();
            if (!link) {
                const m2 = raw.match(/<link[^>]*href="([^"]+)"/i) || raw.match(/<guid[^>]*>([^<]+)<\/guid>/i);
                link = m2 ? m2[1] : '';
            }
            const url = absUrl(link, base);
            if (!title || !url) continue;
            const descRaw = strip(pick('description'));
            out.push({
                title,
                url,
                date: pick('pubDate').trim() || pick('dc:date').trim() || '',
                summary: decodeHtmlEntities(descRaw.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 200),
            });
        }
        return out;
    }

    function parseHtmlNews(html, base, linkRe, limit) {
        const out = [];
        const seen = new Set();
        const re = new RegExp(linkRe.source, linkRe.flags.indexOf('g') >= 0 ? linkRe.flags : linkRe.flags + 'g');
        let m;
        while ((m = re.exec(html)) !== null) {
            if (out.length >= limit) break;
            const url = absUrl(m[1], base);
            const title = decodeHtmlEntities(m[2] || '').replace(/\s+/g, ' ').trim();
            if (!url || !title || seen.has(url)) continue;
            seen.add(url);
            out.push({ title, url, date: '', summary: '' });
        }
        return out;
    }

    /** 中文优先：中文条目整体排在前面，组内保持原始顺序（不打乱源的排序逻辑） */
    function sortChineseFirst(items) {
        const zh = [], other = [];
        for (const it of items) (isChinese(it.title) ? zh : other).push(it);
        return zh.concat(other);
    }

    /* ---------------- 小黑盒 markdown 解析 ----------------
     * webFetch 返回的是渲染后的 markdown，实测结构为「空行分隔」的段落序列：
     *   【10\.19】标题
     *   （空行）
     *   【10\.19】标题又是新的一周…正文…      ← 抽取器会把标题重复拼在正文前
     *   （空行）
     *   共6张 / 热点第2位 / 页脚导航…         ← 噪声，需按 JUNK 过滤
     * 判定规则：8~120 字视为标题；>120 字视为上一条的正文；其余（过短/噪声）丢弃。
     */
    const XHH_JUNK = /^(共\d+张|热点第\d+位|立即下载|3亿steam|小黑盒加速器|黑盒语音|黑盒工坊|开放平台|加入我们|登录|返回|首页|社区|联系我们|关于我们|违法和不良信息|举报邮箱|清枫|尝试太多了|\d+s后自动|三角洲行动|计划入手的游戏|京公网|京ICP|京网文)/;
    const unescapeMd = (s) => String(s || '').replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, '$1');

    function parseXhhMarkdown(md, limit) {
        const paras = String(md || '').split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
        const items = [];
        let cur = null;
        // 标题在正文里会被重复一次，但有时标点被清洗（如 『她说…』→「她说…」），
        // 故比较前先去掉首尾标点再判断前缀。
        const bare = (s) => String(s || '').replace(/^[【『「\[（(【\s"'“‘]+/, '').replace(/[】』」\]）)】\s"'”’…]+$/, '');
        for (const p of paras) {
            if (XHH_JUNK.test(p)) continue;
            // 正文判定：以上一条标题开头（原始或去标点后），或长度明显超出标题区间
            const isBody = cur && (p.indexOf(cur.rawTitle) === 0 || p.indexOf(bare(cur.rawTitle)) === 0 || p.length > 120);
            if (isBody) {
                let body = p;
                if (body.indexOf(cur.rawTitle) === 0) body = body.slice(cur.rawTitle.length).trim();
                else if (body.indexOf(bare(cur.rawTitle)) === 0) body = body.slice(bare(cur.rawTitle).length).trim();
                cur.summary = unescapeMd(body).slice(0, 200);
                items.push(cur);
                cur = null;
                continue;
            }
            if (p.length < 8) continue;               // 过短，多为栏目标题
            cur = { title: unescapeMd(p), rawTitle: p, summary: '', url: '', date: '' };
        }
        if (cur) items.push(cur);
        return items.slice(0, limit || DEFAULTS.PER_SOURCE).map(it => ({
            title: it.title, url: it.url, date: it.date, summary: it.summary,
        }));
    }

    /* ---------------- 抓取 ---------------- */
    function request(url, headers, timeout) {
        return new Promise((resolve) => {
            const done = (text, status, err) => resolve({ text, status, error: err || null });
            try {
                if (typeof GM_xmlhttpRequest !== 'function') { done('', 0, 'GM_xmlhttpRequest 不可用'); return; }
                GM_xmlhttpRequest({
                    method: 'GET', url, headers: headers || {}, timeout,
                    onload(res) { done(res.responseText || '', res.status, null); },
                    onerror: () => done('', 0, '网络错误'),
                    ontimeout: () => done('', 0, '超时'),
                });
            } catch (e) { done('', 0, e && e.message ? e.message : '请求异常'); }
        });
    }

    function fetchSource(src) {
        // dsfetch 型：走注入的模型侧 fetcher（渲染 SPA），24 小时缓存一次
        if (src.type === 'dsfetch') {
            if (typeof _dsFetcher !== 'function') {
                return Promise.resolve({ id: src.id, label: src.label, items: [], error: '未注入模型侧 fetcher（需主脚本调用 setFetcher）' });
            }
            return Promise.resolve(_dsFetcher(src.url, DEFAULTS.DS_FETCH_TIMEOUT)).then(res => {
                if (!res || !res.ok) {
                    return { id: src.id, label: src.label, items: [], error: (res && res.error) || '抓取失败' };
                }
                const md = res.text || '';
                if (!md.trim()) return { id: src.id, label: src.label, items: [], error: '响应为空（页面可能改版或需验证码）' };
                const items = src.parser === 'xhh'
                    ? parseXhhMarkdown(md, DEFAULTS.PER_SOURCE)
                    : [];
                if (!items.length) return { id: src.id, label: src.label, items: [], error: '未解析到条目（页面结构可能已变更）' };
                return { id: src.id, label: src.label, items, error: null };
            });
        }
        return request(
            src.url,
            { 'Accept': src.type === 'rss' ? 'application/rss+xml, application/xml, text/xml' : 'text/html' },
            DEFAULTS.FETCH_TIMEOUT
        ).then(res => {
            if (res.error) return { id: src.id, label: src.label, items: [], error: res.error };
            if (res.status < 200 || res.status >= 300) return { id: src.id, label: src.label, items: [], error: `HTTP ${res.status}` };
            const text = res.text || '';
            if (!text) return { id: src.id, label: src.label, items: [], error: '响应为空' };
            if (src.type === 'rss' && !/<item[\s>]/i.test(text)) {
                return { id: src.id, label: src.label, items: [], error: '响应不含 RSS 条目（页面结构可能已变更）' };
            }
            const items = src.type === 'rss'
                ? parseRssItems(text, src.url, DEFAULTS.PER_SOURCE)
                : parseHtmlNews(text, src.url, src.linkRe, DEFAULTS.PER_SOURCE);
            if (!items.length) return { id: src.id, label: src.label, items: [], error: '未解析到条目（页面结构可能已变更）' };
            return { id: src.id, label: src.label, items, error: null };
        });
    }

    /* ---------------- 聚合缓存 ---------------- */
    // 两级缓存：
    //   _srcCache  按源独立缓存并各自计时 —— dsfetch 源 24h 一次，直连源 30min 一次。
    //              这样"每天抓几条小黑盒、不定期 fetch"与"RSS 频繁刷新"可以共存。
    //   _cache     聚合结果快照，供 UI 秒开；force 时按各源 TTL 决定是否重抓。
    let _srcCache = new Map();   // srcId → { at, result }
    let _cache = null;           // { at, sources }
    let _inflight = null;
    let _dsFetcher = null;       // 由主脚本注入：(url, timeout) => Promise<{ok,text,error}>

    /** 注入模型侧抓取能力（主脚本的 webFetch），供 dsfetch 型源使用 */
    function setFetcher(fn) { _dsFetcher = typeof fn === 'function' ? fn : null; }

    function srcTtl(src) { return src.type === 'dsfetch' ? DEFAULTS.FETCH_TTL : DEFAULTS.TTL; }

    function fetchSourceCached(src, force) {
        const hit = _srcCache.get(src.id);
        if (!force && hit && (Date.now() - hit.at) < srcTtl(src)) return Promise.resolve(hit.result);
        return fetchSource(src).then(result => {
            _srcCache.set(src.id, { at: Date.now(), result });
            return result;
        });
    }

    function getDigest(opts) {
        opts = opts || {};
        const force = !!opts.force;
        if (!force && _cache && (Date.now() - _cache.at) < DEFAULTS.TTL) {
            return Promise.resolve({ at: _cache.at, sources: _cache.sources, cached: true });
        }
        if (_inflight) return _inflight;
        _inflight = (async () => {
            const results = await Promise.all(getSources().map(s => fetchSourceCached(s, force)));
            _cache = { at: Date.now(), sources: results };
            _inflight = null;
            return { at: _cache.at, sources: _cache.sources, cached: false };
        })();
        return _inflight;
    }
    function clearCache() { _cache = null; _srcCache.clear(); }

    /* ============================================================
     *  v1.3.0 增强搜索：浮窗顶部标题栏右侧的搜索框
     * ============================================================
     * 与主脚本依旧完全解耦：宿主通过 setSearchProviders 注入两种能力——
     *   webSearch(query, { topN }) → { ok, items:[{title,url,site,date,summary}], error? }
     *   chat(prompt, { query })     → { ok, text, error? }
     * 两者都可缺省：缺 webSearch → 本地匹配 + 模型解读；缺 chat → 本地匹配 + 网页检索。
     * 宿主两种都不注入 → 搜索框只匹配本地热点，不报错。
     *
     * 产出三组结果（渐进渲染，先出快的后出慢的）：
     *   local 本地热点匹配 → 0ms      （命中已聚合的内存数据）
     *   web   网页检索      → ~1~3s   （联网，拿实时新闻/页面）
     *   ai    AI 速览       → ~3~8s   （模型读检索结果做总结 + 挑页面）
     */

    let _searchProviders = { webSearch: null, chat: null };
    let _searchCache = new Map();   // query → { at, result }（10 分钟，省 Key 额度）
    let _searchSeq = 0;             // 竞态守卫：只渲染最后一次请求
    let _searchTimer = null;
    let _lastBundle = null;         // 最近一次聚合结果（本地匹配用）

    let _searchAnchor = null;       // .sa-news-hs（下拉的定位上下文）
    let _searchInput = null;
    let _searchClear = null;
    let _searchDrop = null;
    let _searchActiveIdx = -1;      // 键盘上下键选中的条目下标
    let _searchOutsideBound = false;

    const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';

    /** 注入检索能力（宿主调用）。p = { webSearch, chat }，均可缺省 */
    function setSearchProviders(p) {
        _searchProviders = Object.assign({}, _searchProviders, p || {});
    }

    /* ---------------- 小工具 ---------------- */
    /** 只放行 http/https —— 模型输出 / 外部数据里的 javascript: 等一律丢弃 */
    function safeHttpUrl(u) {
        const s = String(u == null ? '' : u).trim();
        if (!s) return '';
        let p;
        try { p = new URL(s); } catch { return ''; }
        return (p.protocol === 'http:' || p.protocol === 'https:') ? p.href : '';
    }

    /** 在浏览器新标签打开原始页面（弹窗被拦时用隐藏 a 标签兜底） */
    function openExternal(url) {
        const href = safeHttpUrl(url);
        if (!href) return false;
        try {
            if (typeof window !== 'undefined' && typeof window.open === 'function') {
                const w = window.open(href, '_blank', 'noopener,noreferrer');
                if (w) { try { w.opener = null; } catch (e) { /* ignore */ } return true; }
            }
        } catch (e) { /* ignore */ }
        try {
            const a = document.createElement('a');
            a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { if (a.parentNode) a.parentNode.removeChild(a); }, 0);
            return true;
        } catch (e) { return false; }
    }

    function _tryJson(s) { try { return JSON.parse(s); } catch { return null; } }

    /** 补齐被截断的 JSON（括号计数 + 字符串态识别） */
    function _salvageJson(s) {
        const stack = [];
        let inStr = false, escaped = false;
        for (const ch of String(s)) {
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{' || ch === '[') stack.push(ch);
            else if (ch === '}' || ch === ']') stack.pop();
        }
        let out = inStr ? s + '"' : s;
        out = out.replace(/,\s*$/, '');
        while (stack.length) out += stack.pop() === '{' ? '}' : ']';
        return out;
    }

    /** 从模型自由文本里抠出 JSON（容忍代码围栏 / 前后解释 / 被截断） */
    function extractJson(text) {
        const raw = String(text == null ? '' : text).trim();
        if (!raw) return null;
        const s = raw.replace(/^```(?:json|JSON)?\s*/i, '').replace(/\s*```\s*$/, '');
        let obj = _tryJson(s);
        if (obj && typeof obj === 'object') return obj;
        const i = s.indexOf('{'), j = s.lastIndexOf('}');
        if (i >= 0 && j > i) {
            obj = _tryJson(s.slice(i, j + 1)) || _tryJson(_salvageJson(s.slice(i, j + 1)));
            if (obj && typeof obj === 'object') return obj;
        }
        if (i >= 0) {
            obj = _tryJson(_salvageJson(s.slice(i)));
            if (obj && typeof obj === 'object') return obj;
        }
        return null;
    }

    /** 关键字切分（与 saa-search.lib.js 同一套语义：空格/逗号分隔，需全部命中） */
    function splitQuery(q) {
        return String(q || '').toLowerCase().split(/[\s,，、]+/).map(s => s.trim()).filter(Boolean);
    }
    function matchTokens(text, tokens) {
        const t = String(text == null ? '' : text).toLowerCase();
        if (!tokens.length) return true;
        for (const tok of tokens) if (t.indexOf(tok) < 0) return false;
        return true;
    }

    /** 本地热点匹配：命中的条目已经聚合在内存里，零成本、零请求 */
    function matchLocal(query) {
        const tokens = splitQuery(query);
        if (!tokens.length || !_lastBundle) return [];
        const out = [];
        for (const s of (_lastBundle.sources || [])) {
            for (const it of (s.items || [])) {
                if (!it || !it.title) continue;
                if (!matchTokens(`${it.title} ${it.summary || ''}`, tokens)) continue;
                const url = safeHttpUrl(it.url);
                if (!url) continue;
                out.push({
                    title: it.title,
                    url,
                    site: s.label || '',
                    date: it.date || '',
                    summary: it.summary || '',
                });
                if (out.length >= DEFAULTS.SEARCH_ITEM_LIMIT) return out;
            }
        }
        return out;
    }

    /** 统一条目清洗：去重 + 只留 http(s) + 用上下文补齐站点/日期/摘要 */
    function normalizeItems(list, ctxItems) {
        const out = [];
        const seen = new Set();
        for (const it of (list || [])) {
            if (!it || typeof it !== 'object') continue;
            const url = safeHttpUrl(it.url || it.link || it.href || '');
            const title = String(it.title || it.name || '').replace(/\s+/g, ' ').trim();
            if (!url || !title || seen.has(url)) continue;
            seen.add(url);
            let site = String(it.site || it.site_name || '').trim();
            let date = String(it.date || '').trim();
            let summary = String(it.summary || it.snippet || it.content || '').replace(/\s+/g, ' ').trim();
            if (ctxItems && ctxItems.length) {
                for (const c of ctxItems) {
                    if (c && c.url === url) {
                        if (!site) site = c.site || '';
                        if (!date) date = c.date || '';
                        if (!summary) summary = c.summary || '';
                        break;
                    }
                }
            }
            out.push({ title, url, site, date, summary });
        }
        return out;
    }

    /** 给模型的提示词：把检索结果当上下文，压住模型编造链接 */
    function buildSearchPrompt(query, ctxItems) {
        const lines = [];
        for (let i = 0; i < (ctxItems || []).length; i++) {
            const it = ctxItems[i];
            lines.push(`[${i + 1}] ${it.title || '(无标题)'}`);
            lines.push(`    来源：${it.site || '未知'}｜日期：${it.date || '未知'}`);
            lines.push(`    链接：${it.url || ''}`);
            const sum = String(it.summary || '').replace(/\s+/g, ' ').trim().slice(0, DEFAULTS.SEARCH_CTX_CHARS);
            if (sum) lines.push(`    摘要：${sum}`);
        }
        return [
            '你是游戏资讯检索助手。请依据下方「网页检索结果」回答用户查询。',
            '',
            `用户查询：${query}`,
            '',
            '网页检索结果：',
            lines.length ? lines.join('\n') : '（本次没有检索到任何网页结果）',
            '',
            '输出要求：',
            '1. 只输出一个 JSON 对象，不要任何解释文字，不要用代码围栏包裹。',
            '2. answer：中文总结，3~6 句，直接回答查询；结果不足以回答时写明「未找到足够信息」。',
            '3. items：从上面结果里挑出与查询最相关的 0~5 条；url 必须原样复制，不可编造或改写。',
            '4. title 可以改写得更易读；summary 一句话；site / date 沿用原值。',
            '',
            '格式：{"answer":"...","items":[{"title":"...","url":"...","site":"...","date":"...","summary":"..."}]}',
        ].join('\n');
    }

    /** 解析模型输出 → { answer, items }（JSON 失败就整段当答案，并从文本里刮链接） */
    function parseModelResult(text, ctxItems) {
        const raw = String(text || '').trim();
        if (!raw) return null;
        const obj = extractJson(raw);
        let answer = '';
        let rawItems = [];
        if (obj && typeof obj === 'object') {
            answer = String(obj.answer || obj.summary || obj.text || '');
            rawItems = Array.isArray(obj.items) ? obj.items
                : (Array.isArray(obj.results) ? obj.results : (Array.isArray(obj.links) ? obj.links : []));
        }
        if (!answer && !rawItems.length) answer = raw;   // 不是 JSON → 整段当速览
        let items = normalizeItems(rawItems, ctxItems);
        if (!items.length && !obj) {
            // 非 JSON 输出：从自由文本里刮出链接，至少还能点开原文
            const urls = raw.match(/https?:\/\/[^\s<>"'）)，。、]+/g) || [];
            items = normalizeItems(urls.map(u => ({ title: u, url: u })), ctxItems);
        }
        answer = answer.replace(/\s+$/, '');
        if (!answer && !items.length) return null;
        return {
            key: 'ai', type: 'ai', title: 'AI 速览',
            answer: answer.slice(0, DEFAULTS.SEARCH_AI_CHARS),
            items,
        };
    }

    /* ---------------- 搜索执行 ---------------- */
    /**
     * 执行一次增强搜索。
     * @param {string} q  查询词
     * @param {object} opts { force, onStage(stage, partial) }
     *   onStage 会在 local / web / ai / done 四个阶段回调，实现渐进渲染。
     * @returns {Promise<{query,groups,local,errors,cached,at}>}
     */
    async function search(q, opts) {
        opts = opts || {};
        const query = String(q || '').trim();
        const out = { query, groups: [], local: [], errors: [], cached: false, at: Date.now() };
        if (!query) return out;

        // 同 query 命中 10 分钟缓存（省 Key 额度，也避免重复检索同一问题）
        const ck = query.toLowerCase().replace(/\s+/g, ' ').trim();
        const hit = _searchCache.get(ck);
        if (!opts.force && hit && (Date.now() - hit.at) < DEFAULTS.SEARCH_CACHE_TTL) {
            out.groups = hit.result.groups;
            out.errors = hit.result.errors;
            out.cached = true;
            out.at = hit.at;
            // 本地匹配零成本，每次都重算（不受缓存影响：热点列表可能刚刷新过）
            out.local = matchLocal(query);
            if (opts.onStage) opts.onStage('done', out);
            return out;
        }

        const hasWeb = typeof _searchProviders.webSearch === 'function';
        const hasChat = typeof _searchProviders.chat === 'function';

        // ① 本地热点匹配（零成本，先出结果）
        out.local = matchLocal(query);
        if (opts.onStage) opts.onStage('local', out);

        if (!hasWeb && !hasChat) {
            out.errors.push('当前宿主未注入检索能力（webSearch / 模型接口）——仅可匹配本地热点');
            if (opts.onStage) opts.onStage('done', out);
            return out;
        }

        // ② 联网检索
        let webItems = [];
        if (hasWeb) {
            try {
                const r = await _searchProviders.webSearch(query, { topN: DEFAULTS.SEARCH_TOP_N });
                if (!r || r.ok === false) {
                    out.errors.push(String((r && r.error) || '联网检索失败'));
                } else {
                    webItems = normalizeItems((r && r.items) || []);
                    if (webItems.length) {
                        out.groups.push({ key: 'web', type: 'web', title: '网页检索', items: webItems });
                    }
                }
            } catch (e) {
                out.errors.push(String((e && e.message) || e));
            }
            if (opts.onStage) opts.onStage('web', out);
        }

        // ③ 模型解读（以②的检索结果为上下文）
        if (hasChat) {
            try {
                const prompt = buildSearchPrompt(query, webItems.slice(0, DEFAULTS.SEARCH_CTX_MAX));
                const r = await _searchProviders.chat(prompt, { query, stage: 'model' });
                if (!r || r.ok === false) {
                    out.errors.push(String((r && r.error) || '模型解读失败'));
                } else {
                    const ai = parseModelResult(r.text || r.content || '', webItems);
                    if (ai) out.groups.push(ai);
                }
            } catch (e) {
                out.errors.push(String((e && e.message) || e));
            }
            if (opts.onStage) opts.onStage('ai', out);
        }

        // 只缓存「没有报错」的结果，避免把一次偶发失败缓存住 10 分钟
        if (out.groups.length && !out.errors.length) {
            if (_searchCache.size >= DEFAULTS.SEARCH_CACHE_MAX && !_searchCache.has(ck)) {
                const oldest = _searchCache.keys().next().value;
                if (oldest !== undefined) _searchCache.delete(oldest);
            }
            _searchCache.set(ck, { at: Date.now(), result: { groups: out.groups, local: out.local, errors: out.errors } });
        }
        if (opts.onStage) opts.onStage('done', out);
        return out;
    }

    /* ---------------- 下拉渲染 ---------------- */
    /** 把速览正文里的裸 URL 变成可点链接（先转义再匹配，链接本身已是安全 HTML） */
    function linkify(text) {
        const t = esc(text);
        return t.replace(/https?:\/\/[^\s<>"'）)，。、]+/g, (m) => {
            const tail = m.match(/[.,;:!?。，、）]+$/);
            const core = tail ? m.slice(0, m.length - tail[0].length) : m;
            if (!core || !/^https?:\/\//i.test(core)) return m;
            return `<a href="${core}" target="_blank" rel="noopener noreferrer">${core}</a>${tail ? tail[0] : ''}`;
        });
    }

    function searchItemHtml(it, idx) {
        const url = safeHttpUrl(it.url);
        const meta = [];
        if (it.site) meta.push(`<span class="sa-news-sr-site">${esc(it.site)}</span>`);
        if (it.date) meta.push(`<span>${esc(it.date)}</span>`);
        const inner = `
            <span class="sa-news-sr-idx">${idx}</span>
            <span class="sa-news-sr-main">
                <span class="sa-news-sr-title">${esc(it.title)}</span>
                ${meta.length ? `<span class="sa-news-sr-meta">${meta.join('')}</span>` : ''}
                ${it.summary ? `<span class="sa-news-sr-sum">${esc(it.summary)}</span>` : ''}
            </span>
            <span class="sa-news-sr-go" aria-hidden="true">↗</span>`;
        if (!url) return `<div class="sa-news-sr-item is-nourl">${inner}</div>`;
        return `<a class="sa-news-sr-item" href="${esc(url)}" target="_blank" rel="noopener noreferrer"`
            + ` data-sa-news-url="${esc(url)}" title="${esc(it.title)}">${inner}</a>`;
    }

    function searchGroupHtml(g) {
        const head = `<div class="sa-news-sr-gh"><span class="sa-news-sr-gt">${esc(g.title)}</span>`
            + `<span class="sa-news-sr-gn">${g.items.length} 条</span></div>`;
        let body = '';
        if (g.type === 'ai' && g.answer) body += `<div class="sa-news-sr-ai">${linkify(g.answer)}</div>`;
        if (g.items.length) {
            body += `<div class="sa-news-sr-gi">${g.items.map((it, i) => searchItemHtml(it, i + 1)).join('')}</div>`;
        }
        return `<div class="sa-news-sr-g">${head}${body}</div>`;
    }

    function renderSearchDrop(st) {
        if (!_searchDrop) return;
        const parts = [];
        if (st.status === 'loading') {
            parts.push(`<div class="sa-news-sr-status"><span class="sa-news-sr-spin"></span>正在检索「${esc(st.query)}」…</div>`);
        }
        if (st.errors && st.errors.length) {
            parts.push(`<div class="sa-news-sr-status sa-news-sr-err">${st.errors.map(e => esc(e)).join('<br>')}</div>`);
        }
        if (st.local && st.local.length) {
            parts.push(searchGroupHtml({ type: 'local', title: '本地热点匹配', items: st.local }));
        }
        for (const g of (st.groups || [])) parts.push(searchGroupHtml(g));

        const total = (st.local || []).length
            + (st.groups || []).reduce((a, g) => a + (g.items ? g.items.length : 0), 0);
        if (st.status === 'ready') {
            if (!total && !(st.errors || []).length) {
                parts.push(`<div class="sa-news-sr-status">未找到与「${esc(st.query)}」相关的结果</div>`);
            } else if (total) {
                parts.push(`<div class="sa-news-sr-note">共 ${total} 条 · 点条目在浏览器新标签打开原文`
                    + `${st.cached ? ' · 命中 10 分钟缓存' : ''}</div>`);
            }
        }
        _searchDrop.innerHTML = parts.join('');
        _searchDrop.classList.add('sa-show');
        _searchActiveIdx = -1;
    }

    function closeSearchDrop() {
        if (_searchDrop) _searchDrop.classList.remove('sa-show');
        _searchActiveIdx = -1;
    }

    /** 跑一次搜索并渲染下拉（渐进渲染：先本地、再网页检索、最后 AI 速览） */
    async function runHeaderSearch(q, opts) {
        opts = opts || {};
        const query = String(q || '').trim();
        if (!query) { closeSearchDrop(); return null; }
        const seq = ++_searchSeq;
        const paint = (st) => { if (seq === _searchSeq) renderSearchDrop(st); };
        paint({ status: 'loading', query, groups: [], local: [], errors: [] });
        const res = await search(query, {
            force: opts.force === true,
            onStage: (stage, partial) => {
                if (seq !== _searchSeq) return;
                paint({
                    status: stage === 'done' ? 'ready' : 'loading',
                    query,
                    groups: partial.groups,
                    local: partial.local,
                    errors: partial.errors,
                    cached: partial.cached,
                });
            },
        });
        if (seq !== _searchSeq) return res;
        paint({ status: 'ready', query, groups: res.groups, local: res.local, errors: res.errors, cached: res.cached });
        return res;
    }

    /* ---------------- 下拉交互 ---------------- */
    function searchDropItems() {
        if (!_searchDrop || typeof _searchDrop.querySelectorAll !== 'function') return [];
        return Array.prototype.slice.call(_searchDrop.querySelectorAll('a[data-sa-news-url]'));
    }

    function setActiveSearchItem(idx) {
        const items = searchDropItems();
        if (!items.length) { _searchActiveIdx = -1; return; }
        let i = idx;
        if (i < 0) i = items.length - 1;
        if (i >= items.length) i = 0;
        for (let k = 0; k < items.length; k++) {
            if (items[k].classList && items[k].classList.remove) items[k].classList.remove('is-active');
        }
        _searchActiveIdx = i;
        const el = items[i];
        if (el && el.classList && el.classList.add) el.classList.add('is-active');
        try { if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ }
    }

    function onSearchDropClick(e) {
        const t = e && e.target;
        const a = t && t.closest ? t.closest('a[data-sa-news-url]') : null;
        if (!a) return;
        const url = safeHttpUrl(a.getAttribute('data-sa-news-url'));
        if (!url) { e.preventDefault(); return; }
        e.preventDefault();          // 自己开，避免被 Steam 页面的点击拦截吞掉
        openExternal(url);
        closeSearchDrop();
    }

    function onSearchKeydown(e) {
        if (!e) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); setActiveSearchItem(_searchActiveIdx + 1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); setActiveSearchItem(_searchActiveIdx - 1); return; }
        if (e.key === 'Enter') {
            e.preventDefault();
            clearTimeout(_searchTimer);
            const items = searchDropItems();
            if (_searchActiveIdx >= 0 && items[_searchActiveIdx]) {
                const url = safeHttpUrl(items[_searchActiveIdx].getAttribute('data-sa-news-url'));
                if (url) { openExternal(url); closeSearchDrop(); return; }
            }
            runHeaderSearch(_searchInput ? _searchInput.value : '');
            return;
        }
        if (e.key === 'Escape') {
            // document 捕获阶段的 Esc 处理会先跑（先关下拉，别把浮窗也关了）；这里只是兜底
            e.stopPropagation();
            closeSearchDrop();
        }
    }

    /** 点浮窗外部关下拉（捕获阶段，绑一次即可） */
    function bindSearchOutside() {
        if (_searchOutsideBound || typeof document === 'undefined') return;
        _searchOutsideBound = true;
        document.addEventListener('click', (e) => {
            if (!_searchDrop || !_searchDrop.classList.contains('sa-show')) return;
            const t = e && e.target;
            if (_searchAnchor && t && _searchAnchor.contains && _searchAnchor.contains(t)) return;
            closeSearchDrop();
        }, true);
    }

    /** 把标题栏搜索框接到浮窗骨架上（openWindow 建遮罩时调用一次） */
    function bindSearchBox(overlay) {
        if (!overlay) return;
        _searchAnchor = overlay.querySelector('.sa-news-hs');
        _searchInput = overlay.querySelector('.sa-news-hs-input');
        _searchClear = overlay.querySelector('.sa-news-hs-clear');
        _searchDrop = overlay.querySelector('.sa-news-hs-drop');
        if (_searchInput) {
            _searchInput.addEventListener('input', () => {
                const v = _searchInput.value;
                const box = _searchInput.parentNode;
                if (box && box.classList && box.classList.toggle) {
                    box.classList.toggle('has-value', !!String(v).trim());
                }
                clearTimeout(_searchTimer);
                if (!String(v).trim()) { closeSearchDrop(); return; }
                _searchTimer = setTimeout(() => runHeaderSearch(v), DEFAULTS.SEARCH_DEBOUNCE_MS);
            });
            _searchInput.addEventListener('keydown', onSearchKeydown);
        }
        if (_searchClear) {
            _searchClear.addEventListener('click', () => {
                if (_searchInput) {
                    _searchInput.value = '';
                    _searchInput.focus();
                    const box = _searchInput.parentNode;
                    if (box && box.classList && box.classList.remove) box.classList.remove('has-value');
                }
                clearTimeout(_searchTimer);
                closeSearchDrop();
            });
        }
        if (_searchDrop) _searchDrop.addEventListener('click', onSearchDropClick);
        bindSearchOutside();
    }

    /* ---------------- 浮窗 UI ---------------- */
    // 滚动链要点：overlay(遮罩,居中) → modal(flex column,定高) → body-holder(flex:1,min-height:0)
    //   → body(flex:1,min-height:0,overflow-y:auto)。
    // 旧版「不能滚动」的根因：holder 是无约束 block，内容把 modal 撑爆后被 overflow:hidden 裁切，
    //   内层 overflow-y:auto 因高度不受限而永远不触发。
    const CSS = `
#sa-news-btn{position:fixed;top:80px;right:16px;z-index:1000002!important;display:flex;align-items:center;gap:6px;
padding:7px 13px;border-radius:20px;cursor:pointer;background:linear-gradient(135deg,rgba(139,92,246,.9),rgba(59,130,246,.9))!important;
color:#fff!important;font-size:12px;font-weight:600;border:1px solid rgba(255,255,255,.18);box-shadow:0 4px 18px rgba(139,92,246,.35);
transition:transform .15s ease,box-shadow .15s ease;user-select:none}
#sa-news-btn:hover{transform:scale(1.05);box-shadow:0 6px 24px rgba(139,92,246,.5)}
#sa-news-btn svg{width:15px!important;height:15px!important;pointer-events:none}
#sa-news-btn .sa-news-dot{width:7px;height:7px;border-radius:50%;background:#f87171;box-shadow:0 0 8px #f87171;animation:sa-news-pulse 1.8s ease-in-out infinite}
@keyframes sa-news-pulse{0%,100%{opacity:1}50%{opacity:.25}}

/* ---- 遮罩：全屏居中 ---- */
.sa-news-overlay{position:fixed;inset:0;z-index:1000006!important;background:rgba(2,6,23,.62)!important;display:none;
align-items:center;justify-content:center;padding:28px;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
.sa-news-overlay.sa-show{display:flex}

/* ---- 弹窗：定高 + flex column，滚动才有稳定高度 ---- */
.sa-news-modal{background:#0b1120!important;border:1px solid rgba(139,92,246,.28)!important;
border-radius:16px;width:min(800px,94vw);height:min(780px,90vh);display:flex;flex-direction:column;overflow:hidden;
box-shadow:0 32px 90px rgba(0,0,0,.65),0 0 0 1px rgba(0,0,0,.4),0 0 46px rgba(139,92,246,.14)!important;
animation:sa-news-in .2s cubic-bezier(.16,1,.3,1)}
@keyframes sa-news-in{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}

/* ---- 头部 ---- */
.sa-news-head{display:flex;align-items:center;gap:10px;padding:14px 16px 12px;flex-shrink:0;
background:linear-gradient(180deg,rgba(139,92,246,.14),rgba(139,92,246,0));
border-bottom:1px solid rgba(139,92,246,.18)}
.sa-news-head-badge{width:34px;height:34px;border-radius:10px;flex-shrink:0;display:flex;align-items:center;justify-content:center;
background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:#fff;box-shadow:0 4px 14px rgba(139,92,246,.4)}
.sa-news-head-badge svg{width:18px!important;height:18px!important}
.sa-news-head-title{font-size:15px;font-weight:700;color:#f1f5f9;flex:1;display:flex;flex-direction:column;gap:1px;min-width:0}
.sa-news-head-title small{font-size:11px;font-weight:400;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sa-news-refresh{display:flex;align-items:center;gap:5px;padding:6px 12px;border-radius:9px;cursor:pointer;flex-shrink:0;
font-size:12px;font-weight:600;color:#c4b5fd;background:rgba(139,92,246,.12);border:1px solid rgba(139,92,246,.3);
transition:background .15s ease,border-color .15s ease,color .15s ease}
.sa-news-refresh:hover{background:rgba(139,92,246,.24);border-color:rgba(139,92,246,.5);color:#ede9fe}
.sa-news-refresh svg{width:13px!important;height:13px!important;transition:transform .3s ease}
.sa-news-refresh.is-loading{opacity:.65;pointer-events:none}
.sa-news-refresh.is-loading svg{animation:sa-news-spin .8s linear infinite}
@keyframes sa-news-spin{to{transform:rotate(360deg)}}
.sa-news-close{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;
background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.15);color:#94a3b8;cursor:pointer;
transition:background .15s ease,color .15s ease,border-color .15s ease}
.sa-news-close:hover{background:rgba(248,113,113,.15);border-color:rgba(248,113,113,.4);color:#f87171}
.sa-news-close svg{width:14px!important;height:14px!important}

/* ---- 滚动区骨架：holder 接管剩余高度并分配 ---- */
.sa-news-body-holder{display:flex;flex-direction:column;flex:1;min-height:0}
.sa-news-meta{padding:9px 16px;font-size:11px;color:#64748b;border-bottom:1px solid rgba(139,92,246,.1);flex-shrink:0;
display:flex;align-items:center;gap:6px}
.sa-news-meta svg{width:11px!important;height:11px!important;flex-shrink:0}
.sa-news-warn{margin:10px 14px 0;padding:7px 10px;border-radius:8px;font-size:11px;flex-shrink:0;line-height:1.5;
background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.2);color:#fbbf24}

/* ---- 列表体：唯一滚动容器 ---- */
.sa-news-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px 14px 16px;scrollbar-width:thin;scrollbar-color:rgba(139,92,246,.35) transparent}
.sa-news-body::-webkit-scrollbar{width:6px}
.sa-news-body::-webkit-scrollbar-track{background:transparent}
.sa-news-body::-webkit-scrollbar-thumb{background:rgba(139,92,246,.3);border-radius:3px}
.sa-news-body::-webkit-scrollbar-thumb:hover{background:rgba(139,92,246,.5)}

/* ---- 来源分组（标题可点击折叠） ---- */
.sa-news-src{margin-bottom:16px}
.sa-news-src:last-child{margin-bottom:2px}
.sa-news-src-title{font:inherit;font-size:12px;font-weight:700;color:#a78bfa;margin-bottom:7px;width:100%;
display:flex;align-items:center;gap:7px;background:none;border:none;padding:0;cursor:pointer;text-align:left;
border-radius:6px;transition:color .13s ease}
.sa-news-src-title:hover{color:#c4b5fd}
.sa-news-src-title::before{content:'';width:3px;height:12px;border-radius:2px;background:linear-gradient(180deg,#8b5cf6,#3b82f6);flex-shrink:0}
.sa-news-src-title .sa-news-src-n{font-size:10px;font-weight:600;color:#94a3b8;padding:1px 7px;border-radius:9px;
background:rgba(148,163,184,.12)}
.sa-news-src-title .sa-news-lang{font-size:9px;padding:1px 6px;border-radius:8px;background:rgba(148,163,184,.14);color:#94a3b8;font-weight:400}
.sa-news-src-title .sa-news-chev{width:13px!important;height:13px!important;margin-left:auto;color:#64748b;
transition:transform .18s ease;flex-shrink:0}
.sa-news-src-title:hover .sa-news-chev{color:#a78bfa}
.sa-news-src.collapsed .sa-news-src-title{margin-bottom:0;color:#64748b}
.sa-news-src.collapsed .sa-news-chev{transform:rotate(-90deg)}
.sa-news-src.collapsed .sa-news-src-items{display:none}

/* ---- 条目卡片 ---- */
.sa-news-item{display:block;padding:9px 11px;margin-bottom:5px;border-radius:10px;color:#cbd5e1;text-decoration:none!important;
font-size:12.5px;line-height:1.55;background:rgba(148,163,184,.05);border:1px solid rgba(148,163,184,.08);
transition:background .13s ease,border-color .13s ease,transform .13s ease}
.sa-news-item:hover{background:rgba(139,92,246,.1);border-color:rgba(139,92,246,.35);color:#f1f5f9;transform:translateX(2px)}
.sa-news-item-title{display:block;font-weight:500}
.sa-news-item-sum{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
font-size:11px;color:#64748b;margin-top:4px;line-height:1.5}

/* ---- 空态 / 加载态 ---- */
.sa-news-empty,.sa-news-loading{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
padding:40px 16px;text-align:center;color:#64748b;font-size:12.5px}
.sa-news-loading .sa-news-loader{width:26px;height:26px;border-radius:50%;
border:2.5px solid rgba(139,92,246,.2);border-top-color:#8b5cf6;animation:sa-news-spin .8s linear infinite}

/* ---- 顶部标题栏右侧：增强搜索框 ---- */
.sa-news-hs{position:relative;flex-shrink:0;width:clamp(168px,24vw,288px)}
.sa-news-hs-box{display:flex;align-items:center;gap:6px;height:32px;padding:0 7px 0 10px;border-radius:16px;
background:rgba(15,23,42,.62)!important;border:1px solid rgba(139,92,246,.26);
transition:border-color .15s ease,box-shadow .15s ease,background .15s ease}
.sa-news-hs-box:focus-within{border-color:rgba(139,92,246,.75);box-shadow:0 0 0 3px rgba(139,92,246,.14);background:rgba(15,23,42,.88)!important}
.sa-news-hs-ic{display:flex;align-items:center;color:#7c8aa5;flex-shrink:0;transition:color .15s ease}
.sa-news-hs-box:focus-within .sa-news-hs-ic{color:#a78bfa}
.sa-news-hs-ic svg{width:13px!important;height:13px!important;pointer-events:none}
.sa-news-hs-input{flex:1;min-width:0;height:100%;border:none!important;outline:none!important;background:transparent!important;
color:#e2e8f0!important;font-size:12px!important;line-height:1;padding:0!important;margin:0!important;
box-shadow:none!important;font-family:inherit!important;appearance:none!important;-webkit-appearance:none!important}
.sa-news-hs-input::placeholder{color:#5b6b85!important;opacity:1}
.sa-news-hs-input::-webkit-search-cancel-button,.sa-news-hs-input::-webkit-search-decoration{display:none!important}
.sa-news-hs-clear{width:19px;height:19px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;
background:rgba(148,163,184,.14);border:none!important;color:#94a3b8;cursor:pointer;padding:0;opacity:0;pointer-events:none;
transition:opacity .15s ease,background .15s ease,color .15s ease}
.sa-news-hs-box.has-value .sa-news-hs-clear{opacity:1;pointer-events:auto}
.sa-news-hs-clear:hover{background:rgba(248,113,113,.2)!important;color:#f87171!important}
.sa-news-hs-clear svg{width:9px!important;height:9px!important;pointer-events:none}

/* ---- 检索下拉面板 ---- */
.sa-news-hs-drop{position:absolute;top:calc(100% + 8px);right:0;width:min(470px,calc(100vw - 40px));
max-height:min(460px,54vh);overflow-y:auto;overscroll-behavior:contain;display:none;z-index:40;
background:#0c1425!important;border:1px solid rgba(139,92,246,.3);border-radius:12px;
box-shadow:0 20px 52px rgba(0,0,0,.6),0 0 0 1px rgba(0,0,0,.35)!important;
scrollbar-width:thin;scrollbar-color:rgba(139,92,246,.35) transparent}
.sa-news-hs-drop.sa-show{display:block;animation:sa-news-drop .14s cubic-bezier(.16,1,.3,1)}
@keyframes sa-news-drop{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
.sa-news-hs-drop::-webkit-scrollbar{width:6px}
.sa-news-hs-drop::-webkit-scrollbar-track{background:transparent}
.sa-news-hs-drop::-webkit-scrollbar-thumb{background:rgba(139,92,246,.3);border-radius:3px}
.sa-news-hs-drop::-webkit-scrollbar-thumb:hover{background:rgba(139,92,246,.5)}

/* ---- 下拉里的分组 / 条目 ---- */
.sa-news-sr-g{border-bottom:1px solid rgba(148,163,184,.08)}
.sa-news-sr-g:last-child{border-bottom:none}
.sa-news-sr-gh{display:flex;align-items:center;gap:7px;padding:6px 10px;font-size:10.5px;font-weight:700;color:#a78bfa;
letter-spacing:.3px;background:rgba(139,92,246,.09)}
.sa-news-sr-gt{display:flex;align-items:center;gap:6px}
.sa-news-sr-gt::before{content:'';width:3px;height:11px;border-radius:2px;background:linear-gradient(180deg,#8b5cf6,#3b82f6);flex-shrink:0}
.sa-news-sr-gn{margin-left:auto;font-size:9.5px;font-weight:600;color:#94a3b8;padding:1px 7px;border-radius:9px;background:rgba(148,163,184,.14)}
.sa-news-sr-item{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;text-decoration:none!important;color:#cbd5e1;
border-bottom:1px solid rgba(148,163,184,.06);transition:background .12s ease,color .12s ease}
.sa-news-sr-item:last-child{border-bottom:none}
.sa-news-sr-item:hover,.sa-news-sr-item.is-active{background:rgba(139,92,246,.13);color:#f1f5f9}
.sa-news-sr-idx{flex-shrink:0;width:17px;height:17px;border-radius:5px;display:flex;align-items:center;justify-content:center;
font-size:9.5px;font-weight:700;color:#94a3b8;background:rgba(148,163,184,.12);margin-top:1px}
.sa-news-sr-main{flex:1;min-width:0}
.sa-news-sr-title{display:block;font-size:12px;font-weight:600;color:inherit;line-height:1.45;
white-space:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sa-news-sr-meta{display:flex;gap:8px;flex-wrap:wrap;font-size:10px;color:#64748b;margin-top:3px}
.sa-news-sr-site{color:#7c8aa5}
.sa-news-sr-sum{display:block;font-size:10.5px;color:#64748b;margin-top:3px;line-height:1.5;
white-space:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sa-news-sr-go{flex-shrink:0;font-size:11px;color:#64748b;opacity:0;transition:opacity .12s ease;margin-top:2px}
.sa-news-sr-item:hover .sa-news-sr-go,.sa-news-sr-item.is-active .sa-news-sr-go{opacity:1;color:#a78bfa}
.sa-news-sr-ai{padding:9px 10px;font-size:11.5px;line-height:1.65;color:#cbd5e1;white-space:pre-wrap;word-break:break-word;
background:rgba(139,92,246,.07)}
.sa-news-sr-ai a{color:#a78bfa;text-decoration:none}
.sa-news-sr-ai a:hover{text-decoration:underline}
.sa-news-sr-note{padding:7px 10px;font-size:10px;color:#64748b;background:rgba(2,6,23,.5)}
.sa-news-sr-status{display:flex;align-items:center;gap:8px;padding:12px 10px;font-size:11.5px;color:#94a3b8;line-height:1.6}
.sa-news-sr-err{color:#fca5a5}
.sa-news-sr-spin{width:13px;height:13px;border-radius:50%;border:2px solid rgba(139,92,246,.2);border-top-color:#8b5cf6;
animation:sa-news-spin .8s linear infinite;flex-shrink:0}

/* ---- 窄屏：全屏化 ---- */
@media (max-width:640px){
.sa-news-overlay{padding:0}
.sa-news-modal{width:100%;height:100%;max-height:none;border-radius:0;border:none}
.sa-news-head{flex-wrap:wrap}
.sa-news-hs{order:10;flex:1 0 100%;width:auto;margin-top:9px}
.sa-news-hs-drop{width:100%;max-height:min(420px,46vh)}
}
`;

    let _btn = null, _overlay = null, _styleInjected = false;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    const ICON_GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>';
    const ICON_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
    const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    const ICON_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';

    function ensureStyle() {
        if (_styleInjected) return;
        try {
            const st = document.createElement('style');
            st.id = 'saa-game-news-style';
            st.textContent = CSS;
            (document.head || document.documentElement).appendChild(st);
        } catch (e) { /* 忽略：样式失败不影响数据 */ }
        _styleInjected = true;
    }

    function renderBody(holder, bundle) {
        const ageMin = Math.max(0, Math.round((Date.now() - bundle.at) / 60000));
        const total = bundle.sources.reduce((n, s) => n + (s.items ? s.items.length : 0), 0);
        const failed = bundle.sources.filter(s => s.error);
        const zhTotal = bundle.sources.reduce((n, s) => n + (s.items || []).filter(i => isChinese(i.title)).length, 0);
        holder.innerHTML = `
            <div class="sa-news-meta">${ICON_CLOCK}<span>${total} 条（中文 ${zhTotal}） · ${new Date(bundle.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新${ageMin > 0 ? `（${ageMin} 分钟前）` : ''}</span></div>
            ${failed.length ? `<div class="sa-news-warn">${failed.map(s => `${esc(s.label)}：${esc(s.error)}`).join('；')}</div>` : ''}
            <div class="sa-news-body">
                ${bundle.sources.filter(s => s.items && s.items.length).map(s => {
                    const items = sortChineseFirst(s.items);
                    const zhN = items.filter(i => isChinese(i.title)).length;
                    return `
                    <div class="sa-news-src" data-src="${esc(s.id)}">
                        <button type="button" class="sa-news-src-title" aria-expanded="true" title="点击折叠/展开该来源">
                            <span>${esc(s.label)}</span><span class="sa-news-src-n">${items.length} 条</span>
                            ${zhN < items.length ? `<span class="sa-news-lang">中文 ${zhN}</span>` : ''}
                            <svg class="sa-news-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                        </button>
                        <div class="sa-news-src-items">${items.map(it => `
                            <a class="sa-news-item" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">
                                <span class="sa-news-item-title">${esc(it.title)}</span>
                                ${it.summary ? `<span class="sa-news-item-sum">${esc(it.summary)}</span>` : ''}
                            </a>`).join('')}</div>
                    </div>`;
                }).join('')}
                ${total ? '' : '<div class="sa-news-empty">暂未取到任何资讯，请稍后刷新重试</div>'}
            </div>`;
    }

    async function refreshWindow(force) {
        if (!_overlay) return;
        const holder = _overlay.querySelector('.sa-news-body-holder');
        if (holder) holder.innerHTML = '<div class="sa-news-loading"><span class="sa-news-loader"></span>正在聚合游戏资讯站…</div>';
        const refreshBtn = _overlay.querySelector('.sa-news-refresh');
        if (force && refreshBtn) refreshBtn.classList.add('is-loading');
        try {
            const bundle = await getDigest({ force });
            // 记下最近一次聚合结果 —— 标题栏搜索框的「本地热点匹配」用得到
            _lastBundle = bundle;
            if (!_overlay || !_overlay.classList.contains('sa-show')) return;
            renderBody(holder, bundle);
            if (_btn && !force) { const dot = _btn.querySelector('.sa-news-dot'); if (dot) dot.style.display = 'none'; }
        } finally {
            if (refreshBtn) refreshBtn.classList.remove('is-loading');
        }
    }

    function openWindow() {
        if (!document.body) return;
        ensureStyle();
        if (!_overlay) {
            _overlay = document.createElement('div');
            _overlay.className = 'sa-news-overlay';
            _overlay.innerHTML = `
                <div class="sa-news-modal">
                    <div class="sa-news-head">
                        <div class="sa-news-head-badge">${ICON_GLOBE}</div>
                        <div class="sa-news-head-title">游戏热点<small>${esc(getSources().map(s => s.label).join(' / '))}</small></div>
                        <div class="sa-news-hs">
                            <div class="sa-news-hs-box">
                                <span class="sa-news-hs-ic">${ICON_SEARCH}</span>
                                <input class="sa-news-hs-input" type="search" placeholder="搜索游戏新闻 / 网页…" autocomplete="off" spellcheck="false" aria-label="搜索游戏新闻与网页">
                                <button class="sa-news-hs-clear" type="button" title="清空" aria-label="清空">${ICON_CLOSE}</button>
                            </div>
                            <div class="sa-news-hs-drop" role="listbox" aria-label="搜索结果"></div>
                        </div>
                        <button class="sa-news-refresh" title="跳过 30 分钟缓存，强制重新抓取">${ICON_REFRESH} 刷新</button>
                        <button class="sa-news-close" title="关闭 (Esc)">${ICON_CLOSE}</button>
                    </div>
                    <div class="sa-news-body-holder"><div class="sa-news-loading"><span class="sa-news-loader"></span>正在聚合游戏资讯站…</div></div>
                </div>`;
            _overlay.addEventListener('click', (e) => {
                if (e.target === _overlay) { closeWindow(); return; }
                // 来源分组折叠（事件委托：renderBody 重建 innerHTML 后依然有效）
                const titleBtn = e.target.closest && e.target.closest('.sa-news-src-title');
                if (titleBtn && _overlay.contains(titleBtn)) {
                    const group = titleBtn.closest('.sa-news-src');
                    if (group) {
                        const collapsed = group.classList.toggle('collapsed');
                        titleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
                    }
                }
            });
            _overlay.querySelector('.sa-news-close').addEventListener('click', closeWindow);
            _overlay.querySelector('.sa-news-refresh').addEventListener('click', () => refreshWindow(true));
            // v1.3.0：标题栏右侧增强搜索框（联网检索 + 模型速览 + 本地匹配）
            bindSearchBox(_overlay);
            document.body.appendChild(_overlay);
        }
        _overlay.classList.add('sa-show');
        refreshWindow(false);
    }
    function closeWindow() { if (_overlay) _overlay.classList.remove('sa-show'); }

    /** [已弃用 v1.1.0] 旧版把入口挂成页面右上角悬浮胶囊，现入口由宿主面板头部按钮提供。
     *  保留仅为向后兼容（第三方调用不受影响）。 */
    function mountButton() {
        if (!document.body) return false;
        ensureStyle();
        if (_btn && document.contains(_btn)) return true;
        _btn = document.createElement('div');
        _btn.id = 'sa-news-btn';
        _btn.title = '游戏热点 · ' + getSources().map(s => s.label).join('/');
        _btn.innerHTML = `${ICON_GLOBE}<span>热点</span><span class="sa-news-dot"></span>`;
        _btn.addEventListener('click', openWindow);
        document.body.appendChild(_btn);
        return true;
    }
    function unmountButton() {
        if (_btn && _btn.parentNode) _btn.parentNode.removeChild(_btn);
        if (_overlay && _overlay.parentNode) _overlay.parentNode.removeChild(_overlay);
        _btn = null; _overlay = null;
        // 搜索框的 DOM 随遮罩一起被移除，这里同步断开引用，避免下次重建时用到旧节点
        _searchAnchor = null; _searchInput = null; _searchClear = null; _searchDrop = null;
        _searchActiveIdx = -1;
    }

    // Esc 关闭（捕获阶段，先于页面自身处理，且只在浮窗可见时拦截）
    function bindEsc() {
        if (typeof document === 'undefined' || bindEsc._done) return;
        bindEsc._done = true;
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !_overlay || !_overlay.classList.contains('sa-show')) return;
            // v1.3.0：检索下拉开着时，Esc 只关下拉（否则在搜索框里按 Esc 会把整个浮窗也关掉）
            if (_searchDrop && _searchDrop.classList.contains('sa-show')) {
                closeSearchDrop();
                e.stopPropagation();
                e.preventDefault();
                return;
            }
            closeWindow();
        }, true);
    }

    root.SAAGameNews = {
        VERSION,
        DEFAULTS,
        BUILTIN_SOURCES,
        get sources() { return getSources(); },
        loadCustom,
        addSource,
        fetchSource,
        getDigest,
        clearCache,
        parseRssItems,
        parseHtmlNews,
        parseXhhMarkdown,
        isChinese,
        sortChineseFirst,
        setFetcher,
        srcTtl,
        // ---- v1.3.0 增强搜索 ----
        setSearchProviders,
        get searchProviders() { return Object.assign({}, _searchProviders); },
        search,
        runHeaderSearch,
        matchLocal,
        normalizeItems,
        buildSearchPrompt,
        parseModelResult,
        extractJson,
        safeHttpUrl,
        openExternal,
        clearSearchCache() { _searchCache.clear(); },
        CSS,
        mountButton,
        unmountButton,
        openWindow,
        closeWindow,
        bindEsc,
    };
})(typeof window !== 'undefined' ? window : globalThis);
