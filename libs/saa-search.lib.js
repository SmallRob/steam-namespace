/* =====================================================================
 * Steam AI Agent —— 关键字搜索浮窗（saa-search.lib.js）
 * =====================================================================
 * 职责：在面板头部提供一个「搜索」入口，打开一个居中弹窗，对**本机已有的
 *       结构化数据**做关键字匹配，结果分组展示，点「用 AI 深入分析」把
 *       选中的条目带进对话。
 *
 * 设计原则（与 saa-game-news.lib.js 保持一致）：
 *   · **与主脚本的 AI Agent 逻辑完全解耦** —— 本库不引用主脚本任何变量，
 *     只通过 window.SAASearch 暴露 API；主脚本侧仅做 loader + 注入 provider。
 *   · **数据由宿主注入**（setProviders）—— 库不知道游戏库从哪来、新闻从哪来，
 *     因此宿主不注入时本库只是空壳，不会报错。
 *   · **库缺失时优雅降级** —— 主脚本不挂入口按钮，其余功能完全不受影响。
 *
 * 试点范围（Phase 1）：两个源
 *   ① 我的游戏库（宿主注入 getLibrary）
 *   ② 新闻 / 热点（宿主注入 getNews，底层走 SAAGameNews.getDigest）
 *
 * 导出 API（window.SAASearch）：
 *   VERSION          库版本
 *   setProviders(p)  注入数据源 { getLibrary, getNews }（返回 Promise）
 *   setHandlers(h)   注入交互回调 { onAnalyze(item, kind) }
 *   search(q, opts)  关键字搜索 → { library:{...}, news:{...} }
 *   openWindow()     打开浮窗
 *   closeWindow()    关闭浮窗
 *   unmount()        卸载浮窗与样式
 *   CSS              样式表文本
 *
 * 依赖：仅需宿主提供 GM_xmlhttpRequest（同沙箱）+ 注入的数据源函数。
 * ===================================================================== */
(function (root) {
    'use strict';

    const VERSION = '1.0.0';

    const DEFAULTS = {
        LIB_LIMIT: 50,          // 游戏库最多扫描条数（内存过滤，防大库卡顿）
        NEWS_LIMIT: 40,         // 新闻最多扫描条数
        RESULT_LIMIT: 20,       // 每组最多展示条数
        DEBOUNCE_MS: 180,       // 输入防抖
    };

    // -----------------------------------------------------------------
    // 状态
    // -----------------------------------------------------------------
    let _providers = { getLibrary: null, getNews: null };
    let _handlers = { onAnalyze: null };
    let _overlay = null;
    let _inputEl = null;
    let _bodyEl = null;
    let _hintEl = null;
    let _debounceTimer = null;
    let _lastQuery = '';
    let _searchSeq = 0;          // 竞态守卫：只渲染最后一次请求的结果
    let _styleEl = null;

    // -----------------------------------------------------------------
    // 工具
    // -----------------------------------------------------------------
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function normalize(s) {
        return String(s == null ? '' : s).toLowerCase();
    }

    /** 关键字命中：忽略大小写；多关键词取「全部命中」 */
    function matchTokens(text, tokens) {
        const t = normalize(text);
        if (!tokens.length) return true;
        for (const tok of tokens) {
            if (t.indexOf(tok) < 0) return false;
        }
        return true;
    }

    function splitQuery(q) {
        return normalize(q).split(/[\s,，、]+/).map((s) => s.trim()).filter(Boolean);
    }

    function fmtHours(h) {
        const n = Number(h);
        if (!Number.isFinite(n) || n <= 0) return '';
        return (Math.round(n * 10) / 10) + 'h';
    }

    // -----------------------------------------------------------------
    // 样式
    // -----------------------------------------------------------------
    const CSS = `
/* v1.26.0 AI 搜索浮窗 */
.sa-search-overlay{position:fixed;inset:0;z-index:10060;display:none;align-items:center;justify-content:center;
  background:rgba(8,10,18,.62);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);}
.sa-search-overlay.sa-show{display:flex;animation:saSearchFade .16s ease-out;}
@keyframes saSearchFade{from{opacity:0}to{opacity:1}}
.sa-search-modal{width:min(660px,calc(100vw - 32px));max-height:min(76vh,720px);display:flex;flex-direction:column;
  background:linear-gradient(180deg,#141726 0%,#0f1220 100%);border:1px solid rgba(139,92,246,.28);
  border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.55);overflow:hidden;}
.sa-search-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.07);
  background:linear-gradient(90deg,rgba(139,92,246,.16),rgba(59,130,246,.08));}
.sa-search-title{font-size:14px;font-weight:700;color:#e2e8f0;display:flex;align-items:center;gap:7px;}
.sa-search-title-icon{color:#a78bfa;display:flex;align-items:center;}
.sa-search-sub{font-size:11px;color:#7c8aa5;margin-left:auto;}
.sa-search-close{width:26px;height:26px;border-radius:50%;border:1px solid rgba(255,255,255,.1);
  background:rgba(255,255,255,.04);color:#94a3b8;cursor:pointer;display:flex;align-items:center;justify-content:center;
  transition:background .15s,color .15s;flex-shrink:0;}
.sa-search-close:hover{background:rgba(239,68,68,.18);color:#fca5a5;}
.sa-search-bar{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.05);}
.sa-search-input{flex:1;height:36px;border-radius:10px;border:1px solid rgba(139,92,246,.3);
  background:rgba(255,255,255,.04);color:#e2e8f0;font-size:13px;padding:0 12px;outline:none;transition:border-color .15s,box-shadow .15s;}
.sa-search-input:focus{border-color:rgba(139,92,246,.65);box-shadow:0 0 0 3px rgba(139,92,246,.14);}
.sa-search-input::placeholder{color:#5b6b85;}
.sa-search-clear{height:30px;padding:0 10px;border-radius:8px;border:1px solid rgba(255,255,255,.1);
  background:rgba(255,255,255,.03);color:#94a3b8;font-size:11px;cursor:pointer;white-space:nowrap;}
.sa-search-clear:hover{background:rgba(255,255,255,.07);color:#cbd5e1;}
.sa-search-hint{padding:9px 16px;font-size:11px;color:#64748b;border-bottom:1px solid rgba(255,255,255,.05);}
.sa-search-body{flex:1;overflow-y:auto;padding:12px 16px 16px;min-height:180px;}
.sa-search-body::-webkit-scrollbar{width:8px;}
.sa-search-body::-webkit-scrollbar-track{background:transparent;}
.sa-search-body::-webkit-scrollbar-thumb{background:rgba(139,92,246,.28);border-radius:4px;}
.sa-search-group{margin-bottom:16px;}
.sa-search-group-head{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:700;color:#94a3b8;
  letter-spacing:.4px;margin-bottom:7px;text-transform:uppercase;}
.sa-search-group-head .sa-search-count{font-size:10px;font-weight:600;color:#64748b;margin-left:auto;text-transform:none;letter-spacing:0;}
.sa-search-item{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:10px;
  background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.05);margin-bottom:5px;
  transition:background .15s,border-color .15s;}
.sa-search-item:hover{background:rgba(139,92,246,.09);border-color:rgba(139,92,246,.26);}
.sa-search-item-main{flex:1;min-width:0;}
.sa-search-item-title{font-size:12.5px;color:#e2e8f0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sa-search-item-meta{font-size:10.5px;color:#7c8aa5;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  display:flex;gap:8px;flex-wrap:wrap;}
.sa-search-item-meta span{white-space:nowrap;}
.sa-search-item-tag{font-size:9.5px;padding:1px 6px;border-radius:99px;font-weight:600;flex-shrink:0;}
.sa-search-tag-lib{background:rgba(34,197,94,.16);color:#4ade80;}
.sa-search-tag-played{background:rgba(59,130,246,.16);color:#60a5fa;}
.sa-search-tag-unplayed{background:rgba(148,163,184,.16);color:#94a3b8;}
.sa-search-item-link{font-size:10.5px;color:#a78bfa;text-decoration:none;white-space:nowrap;flex-shrink:0;}
.sa-search-item-link:hover{text-decoration:underline;}
.sa-search-btn{font-size:10.5px;padding:4px 10px;border-radius:7px;border:1px solid rgba(139,92,246,.4);
  background:rgba(139,92,246,.14);color:#c4b5fd;cursor:pointer;white-space:nowrap;flex-shrink:0;
  transition:background .15s,color .15s;}
.sa-search-btn:hover{background:rgba(139,92,246,.28);color:#ede9fe;}
.sa-search-empty{padding:28px 12px;text-align:center;color:#5b6b85;font-size:12px;}
.sa-search-empty b{display:block;color:#94a3b8;font-size:13px;margin-bottom:6px;}
.sa-search-err{padding:9px 11px;border-radius:9px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.28);
  color:#fca5a5;font-size:11.5px;margin-bottom:9px;}
.sa-search-loading{text-align:center;padding:26px 0;color:#7c8aa5;font-size:12px;}
@media (max-width:640px){
  .sa-search-modal{width:100vw;max-width:100vw;max-height:100vh;height:100vh;border-radius:0;border:none;}
}
`;

    function ensureStyle() {
        if (_styleEl && document.contains(_styleEl)) return;
        _styleEl = document.createElement('style');
        _styleEl.id = 'sa-search-style';
        _styleEl.textContent = CSS;
        (document.head || document.documentElement).appendChild(_styleEl);
    }

    // -----------------------------------------------------------------
    // 骨架
    // -----------------------------------------------------------------
    const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
    const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

    function buildSkeleton() {
        ensureStyle();
        if (_overlay && document.contains(_overlay)) return;
        _overlay = document.createElement('div');
        _overlay.className = 'sa-search-overlay';
        _overlay.innerHTML = `
            <div class="sa-search-modal" role="dialog" aria-modal="true" aria-label="搜索">
                <div class="sa-search-head">
                    <span class="sa-search-title"><span class="sa-search-title-icon">${ICON_SEARCH}</span>搜索</span>
                    <span class="sa-search-sub">我的游戏库 · 新闻热点</span>
                    <button class="sa-search-close" title="关闭" aria-label="关闭">${ICON_CLOSE}</button>
                </div>
                <div class="sa-search-bar">
                    <input class="sa-search-input" type="search" placeholder="输入游戏名 / 关键词…" autocomplete="off" spellcheck="false">
                    <button class="sa-search-clear" type="button">清空</button>
                </div>
                <div class="sa-search-hint">输入关键字即时匹配；点「用 AI 深入分析」把选中条目带进对话。</div>
                <div class="sa-search-body"><div class="sa-search-empty"><b>开始输入</b>关键字会同时匹配「我的游戏库」与「新闻热点」。</div></div>
            </div>`;
        document.body.appendChild(_overlay);

        _inputEl = _overlay.querySelector('.sa-search-input');
        _bodyEl = _overlay.querySelector('.sa-search-body');
        _hintEl = _overlay.querySelector('.sa-search-hint');

        _overlay.querySelector('.sa-search-close').addEventListener('click', closeWindow);
        _overlay.addEventListener('click', (e) => { if (e.target === _overlay) closeWindow(); });
        _overlay.querySelector('.sa-search-clear').addEventListener('click', () => {
            if (_inputEl) { _inputEl.value = ''; _inputEl.focus(); }
            _lastQuery = '';
            renderIdle();
        });
        _bodyEl.addEventListener('click', onBodyClick);
        _inputEl.addEventListener('input', () => {
            clearTimeout(_debounceTimer);
            _debounceTimer = setTimeout(() => runSearch(_inputEl.value), DEFAULTS.DEBOUNCE_MS);
        });
        _inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { clearTimeout(_debounceTimer); runSearch(_inputEl.value); }
            if (e.key === 'Escape') { e.stopPropagation(); closeWindow(); }
        });
        bindEsc();
    }

    function bindEsc() {
        if (typeof document === 'undefined' || bindEsc._done) return;
        bindEsc._done = true;
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && _overlay && _overlay.classList.contains('sa-show')) closeWindow();
        }, true);
    }

    // -----------------------------------------------------------------
    // 渲染
    // -----------------------------------------------------------------
    function renderIdle() {
        if (!_bodyEl) return;
        _bodyEl.innerHTML = `<div class="sa-search-empty"><b>开始输入</b>关键字会同时匹配「我的游戏库」与「新闻热点」。</div>`;
    }

    function renderLoading(q) {
        if (!_bodyEl) return;
        _bodyEl.innerHTML = `<div class="sa-search-loading">正在搜索「${escapeHtml(q)}」…</div>`;
    }

    function itemRow(it, kind) {
        const meta = [];
        if (it.year) meta.push(`<span>${escapeHtml(String(it.year))} 年</span>`);
        if (it.playtimeHours) meta.push(`<span>已玩 ${escapeHtml(String(it.playtimeHours))}h</span>`);
        if (it.storyHours) meta.push(`<span>主线 ${escapeHtml(fmtHours(it.storyHours))}</span>`);
        if (it.source) meta.push(`<span>${escapeHtml(String(it.source))}</span>`);
        if (it.date) meta.push(`<span>${escapeHtml(String(it.date))}</span>`);
        if (it.summary) meta.push(`<span>${escapeHtml(String(it.summary).slice(0, 90))}</span>`);

        const tag = kind === 'library'
            ? (it.playtimeHours
                ? '<span class="sa-search-item-tag sa-search-tag-played">已玩</span>'
                : '<span class="sa-search-item-tag sa-search-tag-unplayed">未玩</span>')
            : '<span class="sa-search-item-tag sa-search-tag-lib">新闻</span>';

        let right = '';
        if (kind === 'news' && it.url) {
            right = `<a class="sa-search-item-link" href="${escapeHtml(it.url)}" target="_blank" rel="noopener noreferrer">原文 ↗</a>`;
        } else if (kind === 'library') {
            right = `<button class="sa-search-btn" data-analyze="1" data-kind="${escapeHtml(kind)}" data-appid="${escapeHtml(String(it.appid || ''))}">用 AI 深入分析</button>`;
        }

        return `<div class="sa-search-item">
            ${tag}
            <div class="sa-search-item-main">
                <div class="sa-search-item-title">${escapeHtml(it.title || it.name || '')}</div>
                <div class="sa-search-item-meta">${meta.join('')}</div>
            </div>
            ${right}
        </div>`;
    }

    function renderResults(res, q) {
        if (!_bodyEl) return;
        const lib = res.library || { items: [] };
        const news = res.news || { items: [] };
        const parts = [];

        if (lib.error) parts.push(`<div class="sa-search-err">游戏库：${escapeHtml(lib.error)}</div>`);
        if (news.error) parts.push(`<div class="sa-search-err">新闻：${escapeHtml(news.error)}</div>`);

        const libItems = (lib.items || []).slice(0, DEFAULTS.RESULT_LIMIT);
        if (libItems.length) {
            parts.push(`<div class="sa-search-group">
                <div class="sa-search-group-head">我的游戏库<span class="sa-search-count">${libItems.length} / ${lib.total || libItems.length}</span></div>
                ${libItems.map((it) => itemRow(it, 'library')).join('')}
            </div>`);
        }
        const newsItems = (news.items || []).slice(0, DEFAULTS.RESULT_LIMIT);
        if (newsItems.length) {
            parts.push(`<div class="sa-search-group">
                <div class="sa-search-group-head">新闻热点<span class="sa-search-count">${newsItems.length} / ${news.total || newsItems.length}</span></div>
                ${newsItems.map((it) => itemRow(it, 'news')).join('')}
            </div>`);
        }

        if (!libItems.length && !newsItems.length && !lib.error && !news.error) {
            parts.push(`<div class="sa-search-empty"><b>没有匹配「${escapeHtml(q)}」的结果</b>换个关键字，或先在商店页打开「游戏库展示」插件。</div>`);
        }
        _bodyEl.innerHTML = parts.join('');
    }

    // -----------------------------------------------------------------
    // 搜索
    // -----------------------------------------------------------------
    async function search(q, opts) {
        const query = String(q || '').trim();
        const tokens = splitQuery(query);
        const out = { library: { items: [], total: 0, error: '' }, news: { items: [], total: 0, error: '' } };
        if (!tokens.length) return out;

        // ① 我的游戏库
        if (typeof _providers.getLibrary === 'function') {
            try {
                const raw = await _providers.getLibrary();
                const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.games) ? raw.games : []);
                const hits = arr.filter((g) => g && matchTokens(g.name, tokens)).slice(0, DEFAULTS.LIB_LIMIT);
                out.library.total = hits.length;
                out.library.items = hits.map((g) => ({
                    appid: g.appid,
                    title: g.name || `App ${g.appid}`,
                    year: g.year || null,
                    playtimeHours: (Number(g.playtime_forever) || 0) > 0 ? Math.round((Number(g.playtime_forever) / 6)) / 10 : 0,
                    storyHours: g.storyHours || null,
                }));
            } catch (e) {
                out.library.error = String(e && e.message || e);
            }
        } else {
            out.library.error = '未注入游戏库数据源';
        }

        // ② 新闻热点
        if (typeof _providers.getNews === 'function') {
            try {
                const raw = await _providers.getNews();
                const arr = Array.isArray(raw) ? raw : [];
                const hits = arr.filter((n) => n && matchTokens(n.title, tokens)).slice(0, DEFAULTS.NEWS_LIMIT);
                out.news.total = hits.length;
                out.news.items = hits.map((n) => ({
                    title: n.title,
                    url: n.url || n.link || '',
                    source: n.source || n.label || '',
                    date: n.date || n.pubDate || '',
                    summary: n.summary || n.description || '',
                }));
            } catch (e) {
                out.news.error = String(e && e.message || e);
            }
        } else {
            out.news.error = '未注入新闻数据源';
        }

        return out;
    }

    async function runSearch(q) {
        const query = String(q || '').trim();
        _lastQuery = query;
        if (!query) { renderIdle(); return; }
        renderLoading(query);
        const seq = ++_searchSeq;
        const res = await search(query);
        if (seq !== _searchSeq) return;   // 竞态：丢弃过期结果
        renderResults(res, query);
    }

    // -----------------------------------------------------------------
    // 交互
    // -----------------------------------------------------------------
    function onBodyClick(e) {
        const btn = e.target.closest('[data-analyze]');
        if (!btn) return;
        const kind = btn.getAttribute('data-kind');
        const appid = Number(btn.getAttribute('data-appid'));
        if (typeof _handlers.onAnalyze === 'function') {
            _handlers.onAnalyze({ kind, appid, query: _lastQuery, title: _lastTitleOf(btn) }, kind);
        }
    }

    function _lastTitleOf(btn) {
        const row = btn.closest('.sa-search-item');
        const el = row && row.querySelector('.sa-search-item-title');
        return el ? el.textContent : '';
    }

    // -----------------------------------------------------------------
    // 浮窗开关
    // -----------------------------------------------------------------
    function openWindow(initialQuery) {
        buildSkeleton();
        if (_overlay) _overlay.classList.add('sa-show');
        if (!initialQuery && _bodyEl) renderIdle();
        if (_inputEl) {
            _inputEl.value = initialQuery || '';
            _inputEl.focus();
            if (initialQuery) _inputEl.select();
        }
        if (initialQuery) runSearch(initialQuery);
    }
    function closeWindow() { if (_overlay) _overlay.classList.remove('sa-show'); }
    function unmount() {
        if (_overlay && _overlay.parentNode) _overlay.parentNode.removeChild(_overlay);
        if (_styleEl && _styleEl.parentNode) _styleEl.parentNode.removeChild(_styleEl);
        _overlay = null; _styleEl = null; _inputEl = null; _bodyEl = null; _hintEl = null;
    }

    // -----------------------------------------------------------------
    // 导出
    // -----------------------------------------------------------------
    root.SAASearch = {
        VERSION,
        DEFAULTS,
        CSS,
        setProviders(p) {
            _providers = Object.assign({}, _providers, p || {});
        },
        setHandlers(h) {
            _handlers = Object.assign({}, _handlers, h || {});
        },
        get providers() { return Object.assign({}, _providers); },
        search,
        runSearch,
        openWindow,
        closeWindow,
        unmount,
        matchTokens,
        splitQuery,
    };
})(typeof window !== 'undefined' ? window : globalThis);
