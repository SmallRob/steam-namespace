/* =====================================================================
 * Steam AI Agent —— 游戏热点模块（saa-game-news.lib.js）
 * =====================================================================
 * 职责：聚合专业游戏资讯站头条 + 热点浮窗 UI（居中弹窗，入口按钮由宿主面板头部提供）。
 * 设计原则：**与主脚本的 AI Agent 逻辑完全解耦**——本库不引用主脚本任何变量，
 *          只通过 window.SAAGameNews 暴露 API；主脚本侧仅做 loader + 薄工具注册。
 *
 * 导出 API（window.SAAGameNews）：
 *   SOURCES            当前启用的源定义（可运行时增删，便于扩展）
 *   addSource(src)     运行时追加一个源（无需改主脚本）
 *   fetchSource(src)   抓取单个源 → {id,label,items,error}
 *   getDigest(opts)    聚合全部源（带 TTL 缓存 + 并发去重）
 *   clearCache()       清空聚合缓存
 *   mountButton()      [已弃用 v1.1.0] 旧版页面悬浮入口，保留仅为兼容；入口现由宿主面板头部按钮提供
 *   unmountButton()    卸载入口与浮窗
 *   VERSION            库版本
 *
 * 依赖：仅需宿主提供 GM_xmlhttpRequest（与主脚本同一沙箱）。
 * ===================================================================== */
(function (root) {
    'use strict';

    const VERSION = '1.2.0';
    const STORAGE_KEY = 'saa_game_news_sources_v1';   // 用户自定义源（GM 存储键，宿主注入）

    const DEFAULTS = {
        TTL: 30 * 60 * 1000,          // 直连型源（RSS/HTML）聚合缓存 30 分钟
        FETCH_TTL: 24 * 60 * 60 * 1000, // dsfetch 型源（走模型侧 fetch）缓存 24 小时——每天抓一次即可
        FETCH_TIMEOUT: 15000,
        DS_FETCH_TIMEOUT: 45000,
        PER_SOURCE: 8,
        CACHE_MAX_SOURCES: 32,        // 自定义源上限，防刷
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

/* ---- 窄屏：全屏化 ---- */
@media (max-width:640px){
.sa-news-overlay{padding:0}
.sa-news-modal{width:100%;height:100%;max-height:none;border-radius:0;border:none}
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
    }

    // Esc 关闭（捕获阶段，先于页面自身处理，且只在浮窗可见时拦截）
    function bindEsc() {
        if (typeof document === 'undefined' || bindEsc._done) return;
        bindEsc._done = true;
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && _overlay && _overlay.classList.contains('sa-show')) closeWindow();
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
        CSS,
        mountButton,
        unmountButton,
        openWindow,
        closeWindow,
        bindEsc,
    };
})(typeof window !== 'undefined' ? window : globalThis);
