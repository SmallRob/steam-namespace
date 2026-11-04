// ==UserScript==
// @name         Nexus Mods 增强
// @name:en      Nexus Mods Enhancer
// @namespace    nexusmods-enhancer
// @version      1.2.2
// @description  Nexus Mods 列表/搜索页增强：每页条数 20→80、无限滚动、快捷中文筛选（简中/繁中/翻译）、下载量·点赞·文件大小区间、9 种排序、关键词检索、中文游戏名转英文并直达游戏页、界面中文化、模组语言徽章；模组页支持 AI 翻译描述、AI 分析模组、AI 解读当前列表。v1.2.2 新增视图状态明确指示：右下角常驻模式开关（增强/原生）、切换提示，菜单项直接显示当前状态与勾选。
// @description:en  Nexus Mods listing/search enhancer: 20→80 items per page, infinite scroll, one-click Chinese filters, range filters, 9 sort modes, keyword search, Chinese→English game resolution, Chinese UI, language badges, AI translation/analysis, download tools (one-click file download, interstitial skip, collection batch download), and an explicit enhanced/native view indicator with a persistent mode switch and state-aware menu entries.
// @author       SmallRob
// @match        https://www.nexusmods.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_deleteValue
// @connect      api.nexusmods.com
// @connect      store.steampowered.com
// @connect      api.deepseek.com
// @connect      api.openai.com
// @run-at       document-start
// @license      MIT
// @tag          NexusMods
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '1.2.2';
    const API = 'https://api.nexusmods.com/v2/graphql';
    const LOG_PREFIX = '[N网增强]';
    const AI_DEFAULT_URL = 'https://api.deepseek.com/v1/chat/completions';
    const AI_DEFAULT_MODEL = 'deepseek-chat';
    const AI_MAX_DESC = 12000;      // 送给 AI 的描述正文上限（字符）
    const AI_TIMEOUT = 120000;

    // ==================== 配置 ====================

    const DEFAULTS = {
        pageSize: 80,      // 每页条数：20 / 40 / 60 / 80（服务端硬上限 80）
        view: 'enhanced',  // enhanced | native
        zhUI: true,        // 界面中文化
        badges: true,      // 模组语言徽章
        sortBy: 'createdAt',
        sortDir: 'DESC',
        minDownloads: 0,   // 下载量下限
        minEndorsements: 0,// 点赞数下限
        maxSizeMB: 0,      // 文件大小上限（MB）
        keyword: '',       // 关键词
        skipWait: true,    // 下载等待页自动跳过
        dlGap: 5           // 合集批量下载间隔（秒）
    };

    let CFG = Object.assign({}, DEFAULTS);
    try {
        const saved = JSON.parse(GM_getValue('nme.cfg', '{}') || '{}');
        if (saved && typeof saved === 'object') Object.assign(CFG, saved);
    } catch (e) { /* 配置损坏则用默认值 */ }

    function saveCfg() {
        try { GM_setValue('nme.cfg', JSON.stringify(CFG)); } catch (e) { /* 忽略 */ }
    }

    const DEBUG = false;
    function dbg(...args) { if (DEBUG) console.log(LOG_PREFIX, ...args); }

    // ==================== 通用工具 ====================

    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

    function fmtNum(n) {
        if (n === null || n === undefined) return '—';
        return Number(n).toLocaleString('en-US');
    }

    function fmtSize(bytes) {
        if (!bytes && bytes !== 0) return '—';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let v = Number(bytes), i = 0;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return (i === 0 ? v : v.toFixed(1)) + units[i];
    }

    /** 相对时间（中文） */
    function fmtRelative(iso) {
        if (!iso) return '—';
        const t = new Date(iso).getTime();
        if (!isFinite(t)) return '—';
        const diff = Date.now() - t;
        const min = Math.floor(diff / 60000);
        if (min < 1) return '刚刚';
        if (min < 60) return min + ' 分钟前';
        const hr = Math.floor(min / 60);
        if (hr < 24) return hr + ' 小时前';
        const day = Math.floor(hr / 24);
        if (day < 30) return day + ' 天前';
        const mo = Math.floor(day / 30);
        if (mo < 12) return mo + ' 个月前';
        return Math.floor(mo / 12) + ' 年前';
    }

    /** 日期（中文） */
    function fmtDate(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        if (isFinite(d.getTime())) return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
        return '—';
    }

    function debounce(fn, ms) {
        let t = null;
        return function () {
            const args = arguments, self = this;
            clearTimeout(t);
            t = setTimeout(() => fn.apply(self, args), ms);
        };
    }

    // ==================== 中文字典 ====================
    // 只做「整段文本完全匹配」的替换，避免误伤句子内部单词。

    const ZH = {
        'Show filters': '显示筛选',
        'Hide filters': '隐藏筛选',
        'Filter': '筛选',
        'Sort': '排序',
        'All time': '全部时间',
        'Date Published': '发布日期',
        'Desc': '降序',
        'Asc': '升序',
        'Endorsements': '点赞数',
        'Downloads': '下载量',
        'Unique Downloads': '独立下载量',
        'Last Updated': '最近更新',
        'Mod Name': '模组名称',
        'File Size': '文件大小',
        'Last Comment': '最近评论',
        'Surprise': '随机惊喜',
        'Category': '分类',
        'Tags': '标签',
        'Search parameters': '搜索参数',
        'Title': '标题',
        'Description': '描述',
        'Author': '作者',
        'Uploader': '上传者',
        'Includes': '包含',
        'Excludes': '排除',
        'Apply': '应用',
        'Show Tags': '显示标签',
        'Language support': '语言支持',
        'Content options': '内容选项',
        'File size': '文件大小',
        'No min': '最小值',
        'No max': '最大值',
        'Mod options': '模组选项',
        'Previous page': '上一页',
        'Next page': '下一页',
        'Go': '跳转',
        'Log in': '登录',
        'Sign up': '注册',
        'Download App': '下载客户端',
        'Search': '搜索',
        'Files': '文件',
        'Images': '图片',
        'Videos': '视频',
        'Posts': '帖子',
        'Bugs': '问题',
        'Logs': '日志',
        'Stats': '统计',
        'My mods': '我的模组',
        'My media': '我的媒体',
        'My collections': '我的合集',
        'News': '新闻',
        'Support': '支持',
        'Community': '社区',
        'Media': '媒体',
        'Collections': '合集',
        'Games': '游戏',
        'Mods': '模组',
        'Account': '账户',
        'Messages': '消息',
        'Notifications': '通知',
        'Premium': '高级会员',
        'Get more': '获取更多',
        'Learn more': '了解更多',
        'Edit': '编辑',
        'Remove': '移除',
        'Download': '下载',
        'Install': '安装',
        'Update': '更新',
        'Loading': '加载中',
        'Error': '错误',
        'Retry': '重试',
        'Close': '关闭',
        'Cancel': '取消',
        'Save': '保存',
        'Done': '完成',
        'Enabled': '启用',
        'Disabled': '禁用',
        'Followers': '关注者',
        'Posts ': '帖子 ',
        // —— 站点公共区域 ——
        'Page': '页',
        'to': '至',
        'Home': '首页',
        'Clear game filter': '清除游戏筛选',
        'Skip to content': '跳到正文',
        "Browse the internet's best mods": '浏览全网最好的模组',
        'Premium features': '高级功能',
        'Mod faster with premium': '开通高级会员，下载更快',
        'Discover': '发现',
        'All games': '所有游戏',
        'All mods': '所有模组',
        'New mods': '最新模组',
        'Popular mods': '热门模组',
        'Trending mods': '趋势模组',
        'All collections': '所有合集',
        'All images': '所有图片',
        'Help': '帮助',
        'Wiki': 'Wiki',
        'API': 'API',
        'Feedback': '反馈',
        'Report a bug': '报告缺陷',
        'Unban requests': '解封申请',
        'DMCA': 'DMCA',
        'Forums': '论坛',
        'Discord': 'Discord',
        'Support authors': '支持作者',
        'Contact us': '联系我们',
        'Manage cookie settings': '管理 Cookie 设置',
        'News': '新闻',
        'Statistics': '统计',
        'Careers': '加入我们',
        'About us': '关于我们',
        'Terms of Service': '服务条款',
        'Privacy Policy': '隐私政策',
        'Members': '会员',
        'Kudos': 'Kudos 积分',
        'Server info': '服务器信息',
        'Network stats': '网络状态',
        'Make mods. Earn rewards.': '创作模组，赚取奖励。',
        'Learn More': '了解更多',
        // —— 筛选面板 ——
        'Hide translations': '隐藏翻译',
        'Hide adult content': '隐藏成人内容',
        'Show only adult content': '仅显示成人内容',
        'Supported by Vortex': '支持 Vortex',
        'Show only updated mods': '仅显示有更新的模组',
        'Minimum': '最小值',
        'Maximum': '最大值',
        // —— 模组详情页 ——
        'Requirements': '依赖',
        'Conflicts': '冲突',
        'Installation': '安装',
        'Manual': '手动',
        'Automatic': '自动',
        'Mod ID': '模组 ID',
        'File ID': '文件 ID',
        'Created': '创建于',
        'Updated': '更新于',
        'Size': '大小',
        'Type': '类型',
        'Version': '版本',
        'Game version': '游戏版本',
        'Preview': '预览',
        'Report': '举报',
        'Comments': '评论',
        'Leave a comment': '发表评论',
        'Moderator': '管理员',
        'Views': '浏览量',
        'Replies': '回复',
        // —— 搜索参数占位符 ——
        'Title contains': '标题包含',
        'Description contains': '描述包含',
        'Author contains': '作者包含',
        'Uploader contains': '上传者包含',
        // —— 模组分类（Nexus 全站统一分类表）——
        'Alchemy': '炼金',
        'Animation': '动画',
        'Armour': '护甲',
        'Armour - Shields': '护甲 - 盾牌',
        'Audio': '音频',
        'Body, Face, and Hair': '身体、面部与发型',
        'Bug Fixes': '缺陷修复',
        'Buildings': '建筑',
        'Cheats and God items': '作弊与神器',
        'Cities, Towns, Villages, and Hamlets': '城镇与村庄',
        'Clothing and Accessories': '服装与配饰',
        'Collectables, Treasure Hunts, and Puzzles': '收藏品、寻宝与解谜',
        'Combat': '战斗',
        'Crafting': '制作',
        'Creatures and Mounts': '生物与坐骑',
        'Dungeons': '地下城',
        'Environmental': '环境',
        'Followers & Companions': '随从与同伴',
        'Followers & Companions - Creatures': '随从与同伴 - 生物',
        'Gameplay': '玩法',
        'Guilds/Factions': '公会/阵营',
        'Immersion': '沉浸',
        'Items and Objects - Player': '物品与物件 - 玩家',
        'Items and Objects - World': '物品与物件 - 世界',
        'Locations - New': '地点 - 新增',
        'Locations - Vanilla': '地点 - 原版',
        'Magic - Gameplay': '魔法 - 玩法',
        'Magic - Spells & Enchantments': '魔法 - 法术与附魔',
        'Miscellaneous': '杂项',
        'Modders Resources': '创作者资源',
        'Models and Textures': '模型与材质',
        'NPC': 'NPC',
        'Overhauls': '全面重制',
        'Patches': '补丁',
        'Player homes': '玩家住宅',
        'Presets - ENB and ReShade': '预设 - ENB 与 ReShade',
        'Quests and Adventures': '任务与冒险',
        'Races, Classes, and Birthsigns': '种族、职业与命星',
        'Save Games': '存档',
        'Shouts': '吼叫',
        'Skills and Leveling': '技能与升级',
        'Stealth': '潜行',
        'User Interface': '用户界面',
        'Utilities': '工具',
        'Visuals and Graphics': '视觉与画面',
        'VR': 'VR',
        'Weapons': '武器',
        'Weapons and Armour': '武器与护甲',
        // —— 语言（筛选面板 / 标签）——
        'Simplified Chinese': '简体中文',
        'Traditional Chinese': '繁体中文',
        'English': '英语',
        'German': '德语',
        'French': '法语',
        'Spanish': '西班牙语',
        'Russian': '俄语',
        'Japanese': '日语',
        'Korean': '韩语',
        'Polish': '波兰语',
        'Portuguese': '葡萄牙语',
        'Italian': '意大利语',
        'Turkish': '土耳其语',
        'Czech': '捷克语',
        'Hungarian': '匈牙利语',
        'Ukrainian': '乌克兰语',
        'Dutch': '荷兰语',
        'Arabic': '阿拉伯语',
        'Vietnamese': '越南语',
        'Indonesian': '印尼语',
        'Afrikaans': '南非荷兰语',
        'Chinese': '中文'
    };

    const RE_RESULTS = /^([\d,]+)\s+results$/;
    const RE_ITEMS = /^(\d+)\s+Items$/;
    // 「名称 (1,234)」形式：分类 / 语言 / 标签的计数行
    const RE_COUNTED = /^([^()]+?)\s*\(\s*[\d,]+\s*\)$/;

    function translateTree(root) {
        if (!root) return;
        const skipTags = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, OPTION: 1, NOSCRIPT: 1 };
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                const p = node.parentElement;
                if (!p) return NodeFilter.FILTER_REJECT;
                if (skipTags[p.tagName]) return NodeFilter.FILTER_REJECT;
                if (p.closest('#nme-panel')) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);

        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            const raw = n.nodeValue;
            const trimmed = raw.trim();
            if (!trimmed) continue;
            if (Object.prototype.hasOwnProperty.call(ZH, trimmed)) {
                n.nodeValue = raw.replace(trimmed, ZH[trimmed]);
                continue;
            }
            let m = RE_RESULTS.exec(trimmed);
            if (m) { n.nodeValue = raw.replace(trimmed, '共 ' + m[1] + ' 条结果'); continue; }
            m = RE_ITEMS.exec(trimmed);
            if (m) { n.nodeValue = raw.replace(trimmed, m[1] + ' 条'); continue; }
            m = RE_COUNTED.exec(trimmed);
            if (m) {
                const base = m[1].trim();
                if (Object.prototype.hasOwnProperty.call(ZH, base)) {
                    n.nodeValue = raw.replace(base, ZH[base]);
                }
            }
        }

        const attrs = ['aria-label', 'title', 'placeholder'];
        const els = root.querySelectorAll ? root.querySelectorAll('[aria-label],[title],[placeholder]') : [];
        for (let i = 0; i < els.length; i++) {
            const el = els[i];
            if (el.closest('#nme-panel')) continue;
            for (let j = 0; j < attrs.length; j++) {
                const v = el.getAttribute(attrs[j]);
                if (v && Object.prototype.hasOwnProperty.call(ZH, v)) el.setAttribute(attrs[j], ZH[v]);
            }
        }
    }

    // ==================== 语言徽章 ====================

    const SUFFIX_HANS = /[-_](CHS|CH|简中|简体中文|CN|中文)\s*(?:v?\d[\d.]*)?\s*$/i;
    const SUFFIX_HANT = /[-_](CHT|繁中|繁体中文|TC)\s*(?:v?\d[\d.]*)?\s*$/i;

    /**
     * 从模组名后缀 + 作者打的标签推断语言徽章。
     * 注意：Nexus 的语言标签只有「Chinese」而没有区分简/繁，
     * 因此带标签时只能给「中文」，简繁区分仅靠名称后缀（社区惯例 -CHS / -CHT）。
     */
    function detectBadges(mod) {
        const badges = [];
        const name = mod.name || '';
        const tags = (mod.tags || []).map(t => t.name);

        if (SUFFIX_HANT.test(name)) badges.push({ cls: 'nme-badge-hant', text: '繁中' });
        else if (SUFFIX_HANS.test(name)) badges.push({ cls: 'nme-badge-hans', text: '简中' });
        else if (tags.indexOf('Chinese') >= 0) badges.push({ cls: 'nme-badge-zh', text: '中文' });

        if (tags.indexOf('Translation') >= 0) badges.push({ cls: 'nme-badge-tr', text: '翻译' });
        if (mod.directDownloadEnabled === true) badges.push({ cls: 'nme-badge-direct', text: '直链' });
        return badges;
    }

    // ==================== GraphQL 客户端 ====================

    const Q_MODS = `query ModsListing($count: Int = 0, $facets: ModsFacet, $filter: ModsFilter, $offset: Int, $postFilter: ModsFilter, $sort: [ModsSort!]) {
  mods(count: $count, facets: $facets, filter: $filter, offset: $offset, postFilter: $postFilter, sort: $sort, viewUserBlockedContent: false) {
    facetsData
    nodes {
      modId
      name
      summary
      downloads
      endorsements
      fileSize
      createdAt
      updatedAt
      thumbnailUrl
      game { domainName name }
      modCategory { categoryId name }
      uploader { name memberId avatar }
      tags { name }
      directDownloadEnabled
      viewerDownloaded
      viewerEndorsed
      viewerTracked
      viewerUpdateAvailable
    }
    totalCount
  }
}`;

    async function queryMods(variables) {
        const res = await fetch(API, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-graphql-operationname': 'ModsListing'
            },
            credentials: 'include',
            body: JSON.stringify({ query: Q_MODS, variables: variables, operationName: 'ModsListing' })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (json.errors && json.errors.length) {
            throw new Error(json.errors[0].message || 'GraphQL error');
        }
        return json.data.mods;
    }

    // ==================== AI 配置与通用请求 ====================

    const aiCfg = {
        url: AI_DEFAULT_URL,
        key: '',
        model: AI_DEFAULT_MODEL
    };
    try {
        const savedAi = JSON.parse(GM_getValue('nme.ai', '{}') || '{}');
        if (savedAi && typeof savedAi === 'object') Object.assign(aiCfg, savedAi);
    } catch (e) { /* 忽略 */ }

    function saveAiCfg() {
        try { GM_setValue('nme.ai', JSON.stringify(aiCfg)); } catch (e) { /* 忽略 */ }
    }

    function aiConfigured() { return !!(aiCfg.key && aiCfg.url && aiCfg.model); }

    /**
     * 通用 HTTP 请求：优先 GM_xmlhttpRequest（可跨域、可读 Steam 页面），
     * 缺失时回退 fetch。返回 { status, text }。
     */
    function request(opts) {
        const method = opts.method || 'GET';
        const timeout = opts.timeout || 30000;
        if (typeof GM_xmlhttpRequest === 'function') {
            return new Promise(function (resolve, reject) {
                GM_xmlhttpRequest({
                    method: method,
                    url: opts.url,
                    headers: opts.headers || {},
                    data: opts.body,
                    timeout: timeout,
                    onload: function (r) { resolve({ status: r.status, text: r.responseText || '' }); },
                    onerror: function () { reject(new Error('网络请求失败')); },
                    ontimeout: function () { reject(new Error('请求超时')); }
                });
            });
        }
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeout);
        return fetch(opts.url, {
            method: method,
            headers: opts.headers || {},
            body: opts.body,
            signal: ctrl ? ctrl.signal : undefined
        }).then(function (r) {
            clearTimeout(timer);
            return r.text().then(function (t) { return { status: r.status, text: t }; });
        }, function (e) { clearTimeout(timer); throw e; });
    }

    /** 调用 OpenAI / DeepSeek 兼容接口，返回纯文本内容 */
    async function callAi(prompt, opts) {
        opts = opts || {};
        if (!aiConfigured()) throw new Error('未配置 AI 接口，请点「AI 配置」填写');
        let res;
        try {
            res = await request({
                method: 'POST',
                url: aiCfg.url,
                timeout: opts.timeout || AI_TIMEOUT,
                headers: {
                    'content-type': 'application/json',
                    'authorization': 'Bearer ' + aiCfg.key
                },
                body: JSON.stringify({
                    model: aiCfg.model,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: opts.temperature != null ? opts.temperature : 0.3,
                    max_tokens: opts.maxTokens || 4096
                })
            });
        } catch (e) {
            throw new Error('AI 请求失败：' + (e && e.message || e));
        }
        if (res.status < 200 || res.status >= 300) {
            let detail = '';
            try {
                const j = JSON.parse(res.text);
                detail = (j.error && (j.error.message || j.error)) || j.message || '';
                if (typeof detail === 'object') detail = JSON.stringify(detail);
            } catch (e) { detail = (res.text || '').slice(0, 160); }
            throw new Error('AI HTTP ' + res.status + (detail ? '：' + detail : ''));
        }
        let json;
        try { json = JSON.parse(res.text); } catch (e) { throw new Error('AI 返回不是合法 JSON'); }
        const choice = (json.choices && json.choices[0]) || {};
        const content = (choice.message && choice.message.content) || '';
        if (!content) throw new Error('AI 返回内容为空');
        return content;
    }

    /** 从 AI 文本里提取第一个 JSON 对象 */
    function parseAiJson(text) {
        if (!text) throw new Error('AI 返回为空');
        let s = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        const start = s.indexOf('{');
        if (start < 0) throw new Error('AI 返回中找不到 JSON');
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < s.length; i++) {
            const ch = s[i];
            if (esc) { esc = false; continue; }
            if (ch === '\\') { esc = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    return JSON.parse(s.slice(start, i + 1));
                }
            }
        }
        throw new Error('AI 返回 JSON 未闭合（可能被截断）');
    }

    // —— AI 结果缓存（按 modId / 页面指纹，最多保留 40 条）——

    function aiCacheGet(key) {
        try {
            const raw = GM_getValue('nme.ai.' + key, '');
            if (!raw) return null;
            const rec = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!rec || !rec.v) return null;
            return rec;
        } catch (e) { return null; }
    }

    function aiCacheSet(key, value) {
        try {
            GM_setValue('nme.ai.' + key, JSON.stringify({ t: Date.now(), v: value }));
            let idx = [];
            try { idx = JSON.parse(GM_getValue('nme.ai.idx', '[]') || '[]'); } catch (e) { idx = []; }
            idx = idx.filter(function (k) { return k !== key; });
            idx.push(key);
            while (idx.length > 40) {
                const drop = idx.shift();
                try { GM_deleteValue('nme.ai.' + drop); } catch (e) { GM_setValue('nme.ai.' + drop, ''); }
            }
            GM_setValue('nme.ai.idx', JSON.stringify(idx));
        } catch (e) { /* 忽略缓存失败 */ }
    }


    // ==================== 中文游戏名 → Nexus 游戏 ====================
    //
    // 背景：Nexus 的游戏名/域名只有英文，中文关键词在它的搜索里必然 0 结果。
    // 链路：中文输入 →（本地常见别名表）→（Steam 国区搜索拿 appid）→ appdetails 取英文名
    //       → Nexus games(WILDCARD) → 游戏域名 → /games/<domain>/mods
    //
    // 说明：SGLV 的「中英文别名」是 appid → 中文名（小黑盒），方向相反且必须先有 appid，
    // 不能直接回答「中文→英文」；这里改用 Steam 国区搜索作为 appid 解析器，本地别名表兜底。

    const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

    /** 常见模组游戏的中文叫法。domain 均已在 Nexus 实测存在（2026-11-04）。 */
    const ZH_GAME_ALIASES = [
        { cn: ['上古卷轴5', '上古卷轴5天际', '老滚5', 'skyrim'], items: [{ name: 'Skyrim Special Edition', domain: 'skyrimspecialedition' }, { name: 'Skyrim', domain: 'skyrim' }] },
        { cn: ['辐射4', '异尘余生4', 'fallout4'], items: [{ name: 'Fallout 4', domain: 'fallout4' }] },
        { cn: ['赛博朋克2077', '赛博朋克', 'cyberpunk'], items: [{ name: 'Cyberpunk 2077', domain: 'cyberpunk2077' }] },
        { cn: ['艾尔登法环', '老头环', 'elden ring'], items: [{ name: 'Elden Ring', domain: 'eldenring' }] },
        { cn: ['博德之门3', '博德3', 'bg3'], items: [{ name: "Baldur's Gate 3", domain: 'baldursgate3' }] },
        { cn: ['巫师3', '巫师三', 'witcher3'], items: [{ name: 'The Witcher 3: Wild Hunt', domain: 'witcher3' }] },
        { cn: ['剑星', 'stellar blade'], items: [{ name: 'Stellar Blade', domain: 'stellarblade' }] },
        { cn: ['影之刃零', 'phantom blade zero', '影之刃'], items: [{ name: 'Phantom Blade Zero', domain: 'phantombladezero' }] },
        { cn: ['黑神话悟空', '黑神话', 'wukong'], items: [{ name: 'Black Myth: Wukong', domain: 'blackmythwukong' }] },
        { cn: ['怪物猎人荒野', '怪物猎人：荒野'], items: [{ name: 'Monster Hunter Wilds', domain: 'monsterhunterwilds' }] },
        { cn: ['怪物猎人世界', '怪物猎人：世界'], items: [{ name: 'Monster Hunter: World', domain: 'monsterhunterworld' }] },
        { cn: ['怪物猎人崛起', '怪物猎人：崛起'], items: [{ name: 'Monster Hunter Rise', domain: 'monsterhunterrise' }] },
        { cn: ['只狼'], items: [{ name: 'Sekiro: Shadows Die Twice', domain: 'sekiro' }] },
        { cn: ['最终幻想7重制版', '最终幻想7remake', 'ff7重制版'], items: [{ name: 'Final Fantasy VII Remake', domain: 'finalfantasy7remake' }] },
        { cn: ['最终幻想7重生', 'ff7重生'], items: [{ name: 'Final Fantasy VII Rebirth', domain: 'finalfantasy7rebirth' }] },
        { cn: ['星空', 'starfield'], items: [{ name: 'Starfield', domain: 'starfield' }] },
        { cn: ['霍格沃茨之遗', '霍格沃茨'], items: [{ name: 'Hogwarts Legacy', domain: 'hogwartslegacy' }] },
        { cn: ['龙之信条2'], items: [{ name: "Dragon's Dogma 2", domain: 'dragonsdogma2' }] },
        { cn: ['尼尔机械纪元', '尼尔自动人形'], items: [{ name: 'NieR: Automata', domain: 'nierautomata' }] },
        { cn: ['女神异闻录5', 'p5r'], items: [{ name: 'Persona 5 Royal', domain: 'persona5royal' }] },
        { cn: ['天国拯救2', '天国：拯救2'], items: [{ name: 'Kingdom Come: Deliverance II', domain: 'kingdomcomedeliverance2' }] },
        { cn: ['幻兽帕鲁', '帕鲁'], items: [{ name: 'Palworld', domain: 'palworld' }] },
        { cn: ['侠盗猎车手5', 'gta5', 'gta v'], items: [{ name: 'Grand Theft Auto V', domain: 'gta5' }] },
        { cn: ['荒野大镖客2', '大表哥2', 'rdr2'], items: [{ name: 'Red Dead Redemption 2', domain: 'reddeadredemption2' }] },
        { cn: ['泰拉瑞亚'], items: [{ name: 'Terraria', domain: 'terraria' }] },
        { cn: ['星露谷物语'], items: [{ name: 'Stardew Valley', domain: 'stardewvalley' }] },
        { cn: ['英灵神殿'], items: [{ name: 'Valheim', domain: 'valheim' }] },
        { cn: ['环世界', 'rimworld'], items: [{ name: 'Rimworld', domain: 'rimworld' }] },
        { cn: ['城市天际线2'], items: [{ name: 'Cities: Skylines II', domain: 'citiesskylines2' }] },
        { cn: ['模拟人生4'], items: [{ name: 'The Sims 4', domain: 'thesims4' }] },
        { cn: ['刺客信条起源'], items: [{ name: "Assassin's Creed Origins", domain: 'assassinscreedorigins' }] },
        { cn: ['战神5', '战神诸神黄昏'], items: [{ name: 'God of War Ragnarok', domain: 'godofwarragnarok' }] },
        { cn: ['战神4', '战神'], items: [{ name: 'God of War', domain: 'godofwar' }] },
        { cn: ['漫威蜘蛛侠2', '蜘蛛侠2'], items: [{ name: "Marvel's Spider-Man 2", domain: 'marvelsspiderman2' }] },
        { cn: ['地平线零之曙光'], items: [{ name: 'Horizon Zero Dawn', domain: 'horizonzerodawn' }] },
        { cn: ['死亡搁浅'], items: [{ name: 'Death Stranding', domain: 'deathstranding' }] },
        { cn: ['匹诺曹的谎言'], items: [{ name: 'Lies of P', domain: 'liesofp' }] },
        { cn: ['黑暗之魂3', '黑魂3'], items: [{ name: 'Dark Souls 3', domain: 'darksouls3' }] },
        { cn: ['黑暗之魂重制版', '黑魂1'], items: [{ name: 'Dark Souls Remastered', domain: 'darksoulsremastered' }] },
        { cn: ['幽浮2', 'xcom2'], items: [{ name: 'XCOM 2', domain: 'xcom2' }] },
        { cn: ['暗黑破坏神2重制版', '暗黑2重制版'], items: [{ name: 'Diablo II: Resurrected', domain: 'diablo2resurrected' }] },
        { cn: ['龙珠电光炸裂zero', '电光炸裂'], items: [{ name: 'Dragon Ball: Sparking ZERO', domain: 'dragonballsparkingzero' }] },
        { cn: ['铁拳8'], items: [{ name: 'Tekken 8', domain: 'tekken8' }] },
        { cn: ['街霸6', '街头霸王6'], items: [{ name: 'Street Fighter 6', domain: 'streetfighter6' }] },
        { cn: ['剑与魔法', 'blade and sorcery'], items: [{ name: 'Blade & Sorcery', domain: 'bladeandsorcery' }] },
        { cn: ['僵尸毁灭工程'], items: [{ name: 'Project Zomboid', domain: 'projectzomboid' }] },
        { cn: ['七日杀'], items: [{ name: '7 Days To Die', domain: '7daystodie' }] },
        { cn: ['孤岛惊魂6'], items: [{ name: 'Far Cry 6', domain: 'farcry6' }] },
        { cn: ['消逝的光芒2'], items: [{ name: 'Dying Light 2', domain: 'dyinglight2' }] },
        { cn: ['死亡岛2'], items: [{ name: 'Dead Island 2', domain: 'deadisland2' }] },
        { cn: ['深海迷航'], items: [{ name: 'Subnautica', domain: 'subnautica' }] },
        { cn: ['空洞骑士'], items: [{ name: 'Hollow Knight', domain: 'hollowknight' }] },
        { cn: ['传说之下'], items: [{ name: 'Undertale', domain: 'undertale' }] },
        { cn: ['亿万僵尸'], items: [{ name: 'They Are Billions', domain: 'theyarebillions' }] },
        { cn: ['幸福工厂'], items: [{ name: 'Satisfactory', domain: 'satisfactory' }] },
        { cn: ['异星工厂'], items: [{ name: 'Factorio', domain: 'factorio' }] },
        { cn: ['矮人要塞'], items: [{ name: 'Dwarf Fortress', domain: 'dwarffortress' }] }
    ];

    function normKey(s) {
        return String(s == null ? '' : s).toLowerCase()
            .replace(/[\s:：,，.。·'’"“”《》()（）\-—_]/g, '');
    }

    /** 本地别名表命中（按中文键长度降序，支持「上古卷轴5天际」这类包含式输入） */
    function matchLocalAliases(term) {
        const key = normKey(term);
        if (!key) return [];
        const hits = [];
        for (let i = 0; i < ZH_GAME_ALIASES.length; i++) {
            const entry = ZH_GAME_ALIASES[i];
            for (let j = 0; j < entry.cn.length; j++) {
                const k = normKey(entry.cn[j]);
                if (!k) continue;
                if (key === k || key.indexOf(k) >= 0 || (key.length >= 2 && k.indexOf(key) >= 0)) {
                    hits.push({ entry: entry, len: k.length });
                    break;
                }
            }
        }
        hits.sort(function (a, b) { return b.len - a.len; });
        const out = [];
        const seen = {};
        for (let i = 0; i < hits.length; i++) {
            const items = hits[i].entry.items || [];
            for (let j = 0; j < items.length; j++) {
                if (seen[items[j].domain]) continue;
                seen[items[j].domain] = 1;
                out.push({ name: items[j].name, domain: items[j].domain, modCount: null, source: '本地别名' });
            }
        }
        return out;
    }

    /** Steam 国区搜索（中文关键词）：返回 [{ appid, cn }] */
    async function steamSearchCn(term) {
        const url = 'https://store.steampowered.com/search/?term=' + encodeURIComponent(term) + '&l=schinese&cc=CN';
        const res = await request({ url: url, timeout: 20000, headers: { 'accept-language': 'zh-CN,zh;q=0.9' } });
        if (res.status !== 200) throw new Error('Steam 搜索 HTTP ' + res.status);
        const rows = [];
        const parts = res.text.split('data-ds-appid="');
        for (let i = 1; i < parts.length && rows.length < 8; i++) {
            const block = parts[i];
            const idm = block.match(/^(\d+)/);
            if (!idm) continue;
            const tm = block.match(/<span class="title">([^<]*)<\/span>/);
            if (!tm) continue;
            rows.push({ appid: idm[1], cn: tm[1] });
        }
        return rows;
    }

    /** Steam appdetails：取英文名 */
    async function steamEnglishName(appid) {
        const url = 'https://store.steampowered.com/api/appdetails?appids=' + appid + '&l=english&filters=basic';
        const res = await request({ url: url, timeout: 20000 });
        if (res.status !== 200) return '';
        let j;
        try { j = JSON.parse(res.text); } catch (e) { return ''; }
        const d = j && j[appid] && j[appid].data;
        return (d && d.name) || '';
    }

    /** 英文名候选：去商标符号 / 去版本后缀，逐级收缩 */
    function gameNameVariants(raw) {
        const base = String(raw || '').replace(/[™®©]/g, '').trim();
        const list = [];
        const add = function (s) {
            s = String(s || '').trim().replace(/\s+/g, ' ');
            if (s && list.indexOf(s) < 0) list.push(s);
        };
        add(base);
        add(base.split(/\s+[-—]\s+/)[0]);
        add(base.split(':')[0]);
        const words = base.split(/\s+/);
        if (words.length > 3) add(words.slice(0, 3).join(' '));
        if (words.length > 2) add(words.slice(0, 2).join(' '));
        return list;
    }

    /** Nexus games 名称模糊查询 */
    async function nexusGamesByName(name) {
        const q = 'query GameSearch($filter: GamesSearchFilter) { games(count: 6, filter: $filter) { nodes { id name domainName modCount } } }';
        const res = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-graphql-operationname': 'GameSearch' },
            credentials: 'include',
            body: JSON.stringify({
                query: q,
                variables: { filter: { name: [{ op: 'WILDCARD', value: name }] } },
                operationName: 'GameSearch'
            })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (json.errors && json.errors.length) throw new Error(json.errors[0].message || 'GraphQL error');
        return (json.data && json.data.games && json.data.games.nodes) || [];
    }

    /**
     * 解析用户的输入 → 候选游戏列表。
     * 中文：本地别名优先，再 Steam 国区搜索；英文/域名：直接 Nexus games 模糊查。
     */
    async function resolveGame(term) {
        const raw = String(term || '').trim();
        if (!raw) return [];
        const cacheKey = 'cn.' + normKey(raw);
        const cached = aiCacheGet(cacheKey);
        if (cached && Date.now() - cached.t < 7 * 24 * 3600 * 1000) return cached.v;

        const out = [];
        const seen = {};
        const push = function (g) {
            const d = String(g.domain || g.domainName || '').toLowerCase();
            if (!d || seen[d]) return;
            seen[d] = 1;
            out.push({
                name: g.name || d,
                domain: d,
                modCount: g.modCount == null ? null : g.modCount,
                source: g.source || 'Nexus'
            });
        };

        matchLocalAliases(raw).forEach(push);
        // 本地别名命中就不必再走 Steam/GraphQL（快且稳定）
        if (out.length) {
            aiCacheSet(cacheKey, out);
            return out;
        }

        if (CJK_RE.test(raw)) {
            let rows = [];
            try { rows = await steamSearchCn(raw); } catch (e) { rows = []; }
            for (let i = 0; i < Math.min(rows.length, 3); i++) {
                let en = '';
                try { en = await steamEnglishName(rows[i].appid); } catch (e) { en = ''; }
                if (!en) continue;
                const variants = gameNameVariants(en);
                for (let v = 0; v < variants.length; v++) {
                    let games = [];
                    try { games = await nexusGamesByName(variants[v]); } catch (e) { games = []; }
                    if (games.length) {
                        for (let k = 0; k < games.length && k < 3; k++) {
                            games[k].source = 'Steam→Nexus';
                            push(games[k]);
                        }
                        break;
                    }
                }
            }
        } else {
            let games = [];
            try { games = await nexusGamesByName(raw); } catch (e) { games = []; }
            games.forEach(push);
        }

        if (out.length) aiCacheSet(cacheKey, out);
        return out;
    }

    // ==================== 模组详情：AI 翻译 / 分析 ====================

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    const Q_GAME_BY_DOMAIN = `query GameByDomain($domain: String!) { game(domainName: $domain) { id name domainName modCount } }`;
    const Q_MOD_DETAIL = `query ModDetail($modId: ID!, $gameId: ID!) {
  mod(modId: $modId, gameId: $gameId) {
    modId name summary description version author createdAt updatedAt downloads endorsements fileSize
    game { id domainName name }
    modCategory { name }
    tags { name }
  }
}`;

    async function gqlRequest(query, variables, operationName) {
        const res = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-graphql-operationname': operationName },
            credentials: 'include',
            body: JSON.stringify({ query: query, variables: variables, operationName: operationName })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (json.errors && json.errors.length) throw new Error(json.errors[0].message || 'GraphQL error');
        return json.data;
    }

    /** 拉取模组详情：先用 domain 换 gameId（mod 查询必须 gameId + modId） */
    async function fetchModDetail(domain, modId) {
        const g = await gqlRequest(Q_GAME_BY_DOMAIN, { domain: domain }, 'GameByDomain');
        const game = g && g.game;
        if (!game) throw new Error('未找到游戏：' + domain);
        const d = await gqlRequest(Q_MOD_DETAIL, { modId: modId, gameId: game.id }, 'ModDetail');
        if (!d || !d.mod) throw new Error('未找到模组 #' + modId);
        return d.mod;
    }

    /** Nexus 描述是 BBCode，转成适合喂给 AI 的纯文本 */
    function bbcodeToText(src) {
        let s = String(src || '');
        s = s.replace(/<br\s*\/?>/gi, '\n');
        s = s.replace(/\[img\][\s\S]*?\[\/img\]/gi, '');
        s = s.replace(/\[img=[^\]]*\][\s\S]*?\[\/img\]/gi, '');
        s = s.replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1');
        s = s.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, '$1');
        s = s.replace(/\[\*\]/g, '- ');
        s = s.replace(/\[\/(?:b|i|u|s|size|color|center|left|right|quote|spoiler|code|font|list|indent|caption)\]/gi, '');
        s = s.replace(/\[(?:b|i|u|s|size=[^\]]*|color=[^\]]*|center|left|right|quote|spoiler|code|font=[^\]]*|list(?:=[^\]]*)?|indent|caption)\]/gi, '');
        s = s.replace(/&nbsp;/g, ' ');
        s = s.replace(/&amp;/g, '&');
        s = s.replace(/&#92;/g, '\\');
        s = s.replace(/[ \t]+\n/g, '\n');
        s = s.replace(/\n{3,}/g, '\n\n');
        return s.trim();
    }

    function modMetaLine(mod) {
        const parts = [];
        if (mod.version) parts.push('版本 ' + mod.version);
        if (mod.author) parts.push('作者 ' + mod.author);
        if (mod.modCategory && mod.modCategory.name) parts.push('分类 ' + mod.modCategory.name);
        if (mod.tags && mod.tags.length) parts.push('标签 ' + mod.tags.map(function (t) { return t.name; }).join('、'));
        if (mod.downloads != null) parts.push('下载 ' + fmtNum(mod.downloads));
        if (mod.endorsements != null) parts.push('点赞 ' + fmtNum(mod.endorsements));
        if (mod.fileSize != null) parts.push('大小 ' + fmtSize(mod.fileSize));
        if (mod.updatedAt) parts.push('更新 ' + fmtDate(mod.updatedAt));
        return parts.join(' · ');
    }

    function aiStatus(text, kind) {
        const el = $('#nme-ai-status');
        if (!el) return;
        el.textContent = text || '';
        el.className = 'nme-ai-status' + (kind ? ' nme-ai-status-' + kind : '');
    }

    function aiOutput() {
        const el = $('#nme-ai-out');
        if (el) el.hidden = false;
        return el;
    }

    function aiTextHtml(text) {
        return '<div class="nme-ai-text">' + escapeHtml(text).replace(/\n/g, '<br>') + '</div>';
    }

    /** 模组页 AI 工具条 */
    function mountDetailAi(ctx) {
        if (!ctx || ctx.mode !== 'detail') return;
        if ($('#nme-ai-bar')) return;
        const host = document.querySelector('main') || document.querySelector('h1') || document.body;
        const anchor = host.tagName === 'H1' ? host.parentElement : host;
        if (!anchor) return;

        const bar = document.createElement('div');
        bar.id = 'nme-ai-bar';
        bar.innerHTML = [
            '<div class="nme-ai-head">',
            '  <span class="nme-ai-title">N网 AI</span>',
            '  <span class="nme-ai-sub">翻译描述 / 结构化分析 / 依赖与冲突提示</span>',
            '</div>',
            '<div class="nme-ai-actions">',
            '  <button id="nme-ai-tr" class="nme-ai-btn" type="button">AI 翻译描述</button>',
            '  <button id="nme-ai-an" class="nme-ai-btn nme-ai-btn-accent" type="button">AI 分析模组</button>',
            '  <button id="nme-ai-cfg" class="nme-ai-btn" type="button">AI 配置</button>',
            '  <span id="nme-ai-status" class="nme-ai-status"></span>',
            '</div>',
            '<div id="nme-ai-out" class="nme-ai-out" hidden></div>'
        ].join('');

        if (host.tagName === 'H1') anchor.insertAdjacentElement('afterend', bar);
        else anchor.insertBefore(bar, anchor.firstChild);

        const tr = bar.querySelector('#nme-ai-tr');
        const an = bar.querySelector('#nme-ai-an');
        const cfg = bar.querySelector('#nme-ai-cfg');
        if (tr) tr.addEventListener('click', function () { runModTranslate(ctx); });
        if (an) an.addEventListener('click', function () { runModAnalyze(ctx); });
        if (cfg) cfg.addEventListener('click', openAiSettings);

        if (!aiConfigured()) aiStatus('未配置 AI 接口，先点「AI 配置」', 'warn');
    }

    async function ensureModDetail(ctx) {
        if (!state.modCache || state.modCache.modId !== ctx.modId) {
            state.modCache = await fetchModDetail(ctx.domain, ctx.modId);
        }
        return state.modCache;
    }

    async function runModTranslate(ctx) {
        const trBtn = $('#nme-ai-tr');
        const anBtn = $('#nme-ai-an');
        const cacheKey = 'tr.' + ctx.domain + '.' + ctx.modId;
        const cached = aiCacheGet(cacheKey);
        if (cached) {
            aiOutput().innerHTML = '<div class="nme-ai-card"><div class="nme-ai-card-head">AI 翻译（缓存）</div>' + aiTextHtml(cached.v) + '</div>';
            aiStatus('已使用缓存结果', 'ok');
            return;
        }
        if (!aiConfigured()) { openAiSettings(); return; }
        if (trBtn) trBtn.disabled = true;
        if (anBtn) anBtn.disabled = true;
        aiStatus('正在拉取描述并翻译…', 'busy');
        try {
            const mod = await ensureModDetail(ctx);
            const raw = bbcodeToText(mod.description || '') || bbcodeToText(mod.summary || '');
            if (!raw) throw new Error('该模组没有可翻译的描述');
            if (raw.length > 2000) aiStatus('正在翻译 ' + raw.length + ' 字符（超出部分会截断）…', 'busy');
            const prompt = '你是游戏模组文档翻译。把下面的 Nexus Mods 模组描述从英文翻译成简体中文。\n' +
                '要求：\n' +
                '1. 保留原文的段落、标题、列表、文件名、路径和链接；\n' +
                '2. 专有名词（模组名、工具名、游戏内名词、文件路径）保留英文；\n' +
                '3. 不要添加原文没有的内容，不要写前言或后记；\n' +
                '4. 直接输出翻译后的正文。\n\n' +
                '模组名：' + (mod.name || '') + '\n' +
                '原文：\n"""\n' + raw.slice(0, AI_MAX_DESC) + '\n"""';
            const text = await callAi(prompt, { temperature: 0.2, maxTokens: 4096 });
            const clean = text.trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
            aiCacheSet(cacheKey, clean);
            aiOutput().innerHTML = '<div class="nme-ai-card"><div class="nme-ai-card-head">AI 翻译' +
                '<span class="nme-ai-tip">' + escapeHtml(modMetaLine(mod)) + '</span></div>' +
                aiTextHtml(clean) + '</div>';
            aiStatus('翻译完成', 'ok');
        } catch (e) {
            aiStatus((e && e.message) || String(e), 'err');
        } finally {
            if (trBtn) trBtn.disabled = false;
            if (anBtn) anBtn.disabled = false;
        }
    }

    function renderModAnalysis(data, mod) {
        const features = (data.features || []).map(function (f) {
            return '<li>' + escapeHtml(typeof f === 'string' ? f : JSON.stringify(f)) + '</li>';
        }).join('');
        const rows = [
            ['一句话', data.oneliner],
            ['安装', data.install],
            ['依赖', data.requirements],
            ['冲突/注意', data.conflicts],
            ['适合', data.audience],
            ['风险', data.risk]
        ].filter(function (r) { return r[1]; }).map(function (r) {
            return '<div class="nme-ai-kv"><span class="nme-ai-k">' + r[0] + '</span><span class="nme-ai-v">' + escapeHtml(r[1]) + '</span></div>';
        }).join('');
        return '<div class="nme-ai-card">' +
            '<div class="nme-ai-card-head">AI 分析<span class="nme-ai-tip">' + escapeHtml(modMetaLine(mod)) + '</span></div>' +
            rows +
            (features ? '<div class="nme-ai-sec-title">主要功能</div><ul class="nme-ai-list">' + features + '</ul>' : '') +
            '</div>';
    }

    async function runModAnalyze(ctx) {
        const trBtn = $('#nme-ai-tr');
        const anBtn = $('#nme-ai-an');
        const cacheKey = 'an.' + ctx.domain + '.' + ctx.modId;
        const cached = aiCacheGet(cacheKey);
        if (cached) {
            aiOutput().innerHTML = renderModAnalysis(cached.v, state.modCache || { name: '' });
            aiStatus('已使用缓存结果', 'ok');
            return;
        }
        if (!aiConfigured()) { openAiSettings(); return; }
        if (trBtn) trBtn.disabled = true;
        if (anBtn) anBtn.disabled = true;
        aiStatus('正在分析模组…', 'busy');
        try {
            const mod = await ensureModDetail(ctx);
            const desc = bbcodeToText(mod.description || '').slice(0, AI_MAX_DESC);
            const prompt = '你是资深模组安装顾问。根据下面的 Nexus Mods 模组信息，输出 JSON（只输出 JSON，不要 markdown 代码块）：\n' +
                '{\n' +
                '  "oneliner": "一句话说明这个 mod 做什么",\n' +
                '  "features": ["主要功能点", "..."],\n' +
                '  "install": "安装步骤（含目标路径）",\n' +
                '  "requirements": "前置依赖 / 游戏版本要求，没有就写 无",\n' +
                '  "conflicts": "已知冲突或注意事项，没有就写 无",\n' +
                '  "audience": "适合什么玩家",\n' +
                '  "risk": "低/中/高 + 一句原因"\n' +
                '}\n\n' +
                '只依据给到的信息，不要编造。信息：\n' +
                '名称：' + (mod.name || '') + '\n' +
                '简介：' + (mod.summary || '') + '\n' +
                '元数据：' + modMetaLine(mod) + '\n' +
                '描述：\n"""\n' + desc + '\n"""';
            const text = await callAi(prompt, { temperature: 0.2, maxTokens: 1600 });
            const data = parseAiJson(text);
            aiCacheSet(cacheKey, data);
            aiOutput().innerHTML = renderModAnalysis(data, mod);
            aiStatus('分析完成', 'ok');
        } catch (e) {
            aiStatus((e && e.message) || String(e), 'err');
        } finally {
            if (trBtn) trBtn.disabled = false;
            if (anBtn) anBtn.disabled = false;
        }
    }


    // ==================== AI 配置弹窗 ====================

    function openAiSettings() {
        if ($('#nme-ai-cfg-modal')) return;
        const modal = document.createElement('div');
        modal.id = 'nme-ai-cfg-modal';
        modal.innerHTML = [
            '<div class="nme-ai-modal">',
            '  <div class="nme-ai-modal-title">AI 接口配置</div>',
            '  <div class="nme-ai-modal-help">兼容 OpenAI / DeepSeek 的 <code>/chat/completions</code> 接口。Key 只保存在本机脚本存储里，仅发送模组文本，不发送 Nexus Cookie。</div>',
            '  <label class="nme-ai-field"><span>API 地址</span><input id="nme-cfg-url" type="text" spellcheck="false"></label>',
            '  <label class="nme-ai-field"><span>API Key</span><input id="nme-cfg-key" type="password" spellcheck="false" placeholder="sk-..."></label>',
            '  <label class="nme-ai-field"><span>模型</span><input id="nme-cfg-model" type="text" spellcheck="false" placeholder="deepseek-chat"></label>',
            '  <div class="nme-ai-modal-foot">',
            '    <span id="nme-cfg-status" class="nme-ai-status"></span>',
            '    <button id="nme-cfg-test" class="nme-ai-btn" type="button">测试</button>',
            '    <button id="nme-cfg-cancel" class="nme-ai-btn" type="button">取消</button>',
            '    <button id="nme-cfg-save" class="nme-ai-btn nme-ai-btn-accent" type="button">保存</button>',
            '  </div>',
            '</div>'
        ].join('');
        document.body.appendChild(modal);

        const urlEl = modal.querySelector('#nme-cfg-url');
        const keyEl = modal.querySelector('#nme-cfg-key');
        const modelEl = modal.querySelector('#nme-cfg-model');
        const statusEl = modal.querySelector('#nme-cfg-status');
        urlEl.value = aiCfg.url || AI_DEFAULT_URL;
        keyEl.value = aiCfg.key || '';
        modelEl.value = aiCfg.model || AI_DEFAULT_MODEL;

        const setStatus = function (t, kind) {
            statusEl.textContent = t || '';
            statusEl.className = 'nme-ai-status' + (kind ? ' nme-ai-status-' + kind : '');
        };
        const close = function () { modal.remove(); };

        modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
        modal.querySelector('#nme-cfg-cancel').addEventListener('click', close);
        modal.querySelector('#nme-cfg-save').addEventListener('click', function () {
            aiCfg.url = urlEl.value.trim() || AI_DEFAULT_URL;
            aiCfg.key = keyEl.value.trim();
            aiCfg.model = modelEl.value.trim() || AI_DEFAULT_MODEL;
            saveAiCfg();
            close();
            if (state.ctx && state.ctx.mode === 'detail') aiStatus(aiConfigured() ? 'AI 配置已保存' : '已保存（未填 Key）', 'ok');
        });
        modal.querySelector('#nme-cfg-test').addEventListener('click', async function () {
            const btn = this;
            btn.disabled = true;
            setStatus('测试中…', 'busy');
            const prev = { url: aiCfg.url, key: aiCfg.key, model: aiCfg.model };
            aiCfg.url = urlEl.value.trim() || AI_DEFAULT_URL;
            aiCfg.key = keyEl.value.trim();
            aiCfg.model = modelEl.value.trim() || AI_DEFAULT_MODEL;
            try {
                const txt = await callAi('只回复两个字：可用', { maxTokens: 32, temperature: 0 });
                setStatus('连接成功：' + txt.trim().slice(0, 20), 'ok');
            } catch (e) {
                setStatus((e && e.message) || String(e), 'err');
            } finally {
                aiCfg.url = prev.url; aiCfg.key = prev.key; aiCfg.model = prev.model;
                btn.disabled = false;
            }
        });
    }

    // ==================== 下载增强 ====================
    // 参考 Greasy Fork 三个脚本的机制（见 reference/）：
    //   - 官方 GenerateDownloadUrl 接口直接换直链，不抓下载页 DOM
    //   - 失败时回退到 ?tab=files&file_id=...&nmm=1 页面里的 data-download-url
    //   - 合集用 GraphQL collectionRevision(slug) 取 modFiles，逐个人工触发下载
    //   - 批量下载带间隔、连续下载上限、冷却、断点历史

    const DL_GEN = '/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl';
    const DL_HISTORY_KEY = 'nme.dlhistory';
    const DL_RATE_LIMIT = 150;   // 连续下载多少个后强制冷却
    const DL_COOLDOWN = 300;     // 冷却秒数
    const DL_MAX_LOG = 80;
    const DL_REPEAT_GUARD = 30000;  // 同一文件 30 秒内不重复触发，避免重复扣次数

    /**
     * 下载错误分类（借鉴 Vortex 的边界处理）：
     * 可重试的（网络/接口偶发）与必须停下的（未登录/被拦截/限流/无权限）分开。
     */
    class DlError extends Error {
        constructor(code, message) {
            super(message);
            this.name = 'DlError';
            this.code = code;
        }
        get fatal() {
            return this.code === 'AUTH' || this.code === 'FORBIDDEN' ||
                this.code === 'CLOUDFLARE' || this.code === 'RATE_LIMIT';
        }
    }

    const dlRecent = {};  // fileId → 最近一次触发时间
    function dlTooSoon(fileId) {
        const t = dlRecent[fileId];
        return !!t && (Date.now() - t) < DL_REPEAT_GUARD;
    }
    function markDl(fileId) { dlRecent[fileId] = Date.now(); }

    const Q_MOD_FILES = `query ModFiles($modId: ID!, $gameId: ID!) {
  modFiles(modId: $modId, gameId: $gameId) {
    fileId name version sizeInBytes category primary totalDownloads uri
  }
}`;

    const Q_COLLECTION_MODS = `query CollectionRevisionMods($slug: String!, $domain: String) {
  collectionRevision(slug: $slug, domainName: $domain, viewAdultContent: true) {
    modCount revisionNumber totalSize
    modFiles {
      optional
      fileId
      file { name sizeInBytes mod { modId name game { id domainName } } }
    }
  }
}`;

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function isLoggedIn() {
        if (typeof window.USER_ID !== 'undefined' && window.USER_ID) return true;
        return !document.querySelector('.replaced-login-link');
    }

    function dlStatus(text, kind) {
        const el = $('#nme-dl-status');
        if (!el) return;
        el.textContent = text || '';
        el.className = 'nme-ai-status' + (kind ? ' nme-ai-status-' + kind : '');
    }

    /** 官方接口：fid + game_id → { url } */
    async function generateDownloadUrl(fileId, gameId) {
        let res;
        try {
            res = await fetch(DL_GEN, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: 'fid=' + encodeURIComponent(fileId) + '&game_id=' + encodeURIComponent(gameId)
            });
        } catch (e) {
            throw new DlError('NETWORK', '网络错误，无法连接 Nexus');
        }
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
                throw new DlError('AUTH', '没有下载权限（登录失效、需要 Premium，或作者未开放该文件）');
            }
            if (res.status === 429) throw new DlError('RATE_LIMIT', '请求过于频繁，Nexus 已限流');
            throw new DlError('API', '生成下载链接失败（HTTP ' + res.status + '）');
        }
        let data;
        try { data = await res.json(); } catch (e) { throw new DlError('API', '接口返回不是有效 JSON'); }
        if (!data || !data.url) throw new DlError('API', '接口没有返回下载地址');
        return data.url;
    }

    function decodeDlUrl(u) {
        return String(u || '')
            .replace(/\\\//g, '/')
            .replace(/&amp;/g, '&')
            .replace(/&#38;/g, '&')
            .replace(/\\u0026/gi, '&');
    }

    /** 从文件页 HTML 兜底提取直链 */
    function extractDownloadUrl(html) {
        const patterns = [
            /const downloadUrl\s*=\s*['"]([^'"]+)['"]/,
            /id="slowDownloadButton"[^>]*data-download-url="([^"]+)"/,
            /data-download-url\s*=\s*["']([^"']+)["']/,
            /href\s*=\s*["'](nxm:\/\/[^"']+)["']/i
        ];
        for (let i = 0; i < patterns.length; i++) {
            const m = html.match(patterns[i]);
            if (m && m[1]) return decodeDlUrl(m[1]);
        }
        return '';
    }

    /** 统一取直链：官方接口优先，HTML 兜底 */
    async function resolveDownloadUrl(domain, modId, fileId, gameId) {
        if (!isLoggedIn()) throw new DlError('AUTH', '请先登录 Nexus Mods 账号');

        let apiError = null;
        try {
            return await generateDownloadUrl(fileId, gameId);
        } catch (e) {
            apiError = e;
            if (e && e.code === 'NETWORK') await sleep(800);
        }

        const pageUrl = 'https://www.nexusmods.com/' + encodeURIComponent(domain) + '/mods/' + modId +
            '?tab=files&file_id=' + encodeURIComponent(fileId) + '&nmm=1';
        let html = '', status = 0;
        try {
            const res = await fetch(pageUrl, { credentials: 'include' });
            status = res.status;
            html = res.ok ? await res.text() : '';
        } catch (e) {
            throw new DlError('NETWORK', '网络错误，无法打开文件页');
        }

        if (!html) {
            if (status === 429) throw new DlError('RATE_LIMIT', '请求过于频繁，Nexus 已限流');
            if (status === 401 || status === 403) {
                throw new DlError('FORBIDDEN', '没有下载权限（登录失效、需要 Premium，或作者未开放该文件）');
            }
            throw apiError || new DlError('API', '文件页返回空内容（HTTP ' + status + '）');
        }

        if (html.includes('class="replaced-login-link"')) throw new DlError('AUTH', '请先登录 Nexus Mods 账号');
        if (html.includes('Just a moment')) {
            throw new DlError('CLOUDFLARE', '触发 Cloudflare 校验，请手动打开该文件页完成校验');
        }
        if (html.includes('temporarily suspended')) throw new DlError('RATE_LIMIT', 'Nexus 临时限制了下载，请稍后再试');

        const url = extractDownloadUrl(html);
        if (!url) {
            if (apiError) throw apiError;
            throw new DlError('NO_URL', '未取到下载地址（该文件可能需要手动确认或 Premium）');
        }
        return url;
    }

    /** 网络类错误重试一次；被拦截/无权限不重试 */
    async function resolveWithRetry(domain, modId, fileId, gameId) {
        try {
            return await resolveDownloadUrl(domain, modId, fileId, gameId);
        } catch (e) {
            if (e && e.code === 'NETWORK') {
                await sleep(1500);
                return await resolveDownloadUrl(domain, modId, fileId, gameId);
            }
            throw e;
        }
    }

    /** 触发下载：a[download] 点击，不离开当前页；nxm:// 交给 Vortex */
    function triggerDownload(url, fileName) {
        if (/^nxm:\/\//i.test(url)) { location.href = url; return; }
        const a = document.createElement('a');
        a.href = url;
        // 没有扩展名时交给 Content-Disposition 决定，避免存成无后缀文件
        const name = (fileName || '').trim();
        if (name && /\.[a-z0-9]{1,8}$/i.test(name)) a.download = name;
        a.rel = 'noopener';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { if (a.parentElement) a.remove(); }, 1000);
    }

    // ---------- 模组详情页：文件列表 + 一键下载 ----------

    function mountDetailDownload(ctx) {
        if (!ctx || ctx.mode !== 'detail' || $('#nme-dl-bar')) return;
        const aiBar = $('#nme-ai-bar');
        const host = document.querySelector('main') || document.querySelector('h1') || document.body;
        const anchor = host.tagName === 'H1' ? host.parentElement : host;
        if (!anchor) return;

        const bar = document.createElement('div');
        bar.id = 'nme-dl-bar';
        bar.innerHTML = [
            '<div class="nme-dl-head">',
            '  <span class="nme-dl-title">N网 下载</span>',
            '  <span class="nme-dl-sub">官方接口直链 · 个人文件下载</span>',
            '</div>',
            '<div class="nme-dl-actions">',
            '  <button id="nme-dl-refresh" class="nme-dl-btn" type="button">刷新文件列表</button>',
            '  <span id="nme-dl-status" class="nme-ai-status"></span>',
            '</div>',
            '<div id="nme-dl-list" class="nme-dl-list"><div class="nme-dl-empty">正在读取文件列表…</div></div>'
        ].join('');

        if (aiBar && aiBar.parentElement) aiBar.insertAdjacentElement('afterend', bar);
        else if (host.tagName === 'H1') anchor.insertAdjacentElement('afterend', bar);
        else anchor.insertBefore(bar, anchor.firstChild);

        const refresh = bar.querySelector('#nme-dl-refresh');
        if (refresh) refresh.addEventListener('click', function () { loadDetailFiles(ctx); });
        const list = bar.querySelector('#nme-dl-list');
        if (list) {
            list.addEventListener('click', function (e) {
                const btn = e.target.closest('.nme-dl-go');
                if (!btn) return;
                const idx = parseInt(btn.getAttribute('data-idx'), 10);
                const f = state.dlFiles[idx];
                if (f) runSingleDownload(ctx, f, btn);
            });
        }
        loadDetailFiles(ctx);
    }

    async function loadDetailFiles(ctx) {
        const list = $('#nme-dl-list');
        if (!list) return;
        list.innerHTML = '<div class="nme-dl-empty">正在读取文件列表…</div>';
        dlStatus('', '');
        try {
            const mod = await ensureModDetail(ctx);
            const gameId = mod.game && mod.game.id;
            if (!gameId) throw new Error('未取到 gameId');
            const d = await gqlRequest(Q_MOD_FILES, { modId: ctx.modId, gameId: gameId }, 'ModFiles');
            const files = (d && d.modFiles) || [];
            state.dlFiles = files;
            state.dlGameId = gameId;
            renderDetailFiles(files);
        } catch (e) {
            list.innerHTML = '<div class="nme-dl-empty nme-dl-err">' + escapeHtml((e && e.message) || String(e)) + '</div>';
        }
    }

    function renderDetailFiles(files) {
        const list = $('#nme-dl-list');
        if (!list) return;
        if (!files.length) {
            list.innerHTML = '<div class="nme-dl-empty">该模组还没有公开文件。</div>';
            return;
        }
        list.innerHTML = files.map(function (f, i) {
            const tag = f.category ? '<span class="nme-dl-tag">' + escapeHtml(f.category) + '</span>' : '';
            const meta = [
                f.version ? '版本 ' + f.version : '',
                f.sizeInBytes ? fmtSize(f.sizeInBytes) : '',
                f.totalDownloads != null ? '下载 ' + fmtNum(f.totalDownloads) : ''
            ].filter(Boolean).join(' · ');
            return '<div class="nme-dl-row">' +
                '<div class="nme-dl-main">' +
                '<div class="nme-dl-name">' + escapeHtml(f.name || ('文件 #' + f.fileId)) + tag + '</div>' +
                '<div class="nme-dl-meta">' + escapeHtml(meta) + '</div>' +
                '</div>' +
                '<button class="nme-dl-btn nme-dl-go" type="button" data-idx="' + i + '">一键下载</button>' +
                '</div>';
        }).join('');
    }

    async function runSingleDownload(ctx, file, btn) {
        if (dlTooSoon(file.fileId)) {
            dlStatus('刚刚已触发过该文件，请 30 秒后再试', 'warn');
            return;
        }
        const old = btn.textContent;
        btn.disabled = true;
        btn.textContent = '获取中…';
        dlStatus('正在获取「' + (file.name || file.fileId) + '」的下载地址…', 'busy');
        try {
            const url = await resolveWithRetry(ctx.domain, ctx.modId, file.fileId, state.dlGameId);
            triggerDownload(url, file.name);
            markDl(file.fileId);
            dlStatus('已开始下载：' + (file.name || file.fileId), 'ok');
        } catch (e) {
            dlStatus((e && e.message) || String(e), 'err');
        } finally {
            btn.disabled = false;
            btn.textContent = old;
        }
    }

    // ---------- 合集页：批量下载 ----------

    function dlHistoryLoad() {
        try { return JSON.parse(GM_getValue(DL_HISTORY_KEY, '{}') || '{}'); } catch (e) { return {}; }
    }

    function dlHistorySave(h) {
        try { GM_setValue(DL_HISTORY_KEY, JSON.stringify(h)); } catch (e) { /* 忽略 */ }
    }

    function dlHistoryKey(ctx) {
        return (ctx.domain || '') + '/' + (ctx.collectionSlug || '');
    }

    function dlLog(text, kind) {
        const box = $('#nme-dl-log');
        if (!box) return;
        const line = document.createElement('div');
        if (kind) line.className = 'nme-dl-log-' + kind;
        line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + text;
        box.appendChild(line);
        while (box.children.length > DL_MAX_LOG) box.removeChild(box.firstChild);
        box.scrollTop = box.scrollHeight;
    }

    function mountCollectionDownload(ctx) {
        if (!ctx || ctx.mode !== 'collection' || $('#nme-dl-bar')) return;
        const host = document.querySelector('main') || document.body;
        if (!host) return;

        const bar = document.createElement('div');
        bar.id = 'nme-dl-bar';
        bar.innerHTML = [
            '<div class="nme-dl-head">',
            '  <span class="nme-dl-title">N网 合集下载</span>',
            '  <span id="nme-dl-sub" class="nme-dl-sub">正在读取合集…</span>',
            '</div>',
            '<div class="nme-dl-actions">',
            '  <label class="nme-dl-meta">间隔 <input id="nme-dl-gap" class="nme-dl-gap" type="number" min="1" max="60" step="1"></label>',
            '  <button id="nme-dl-start" class="nme-dl-btn nme-dl-btn-accent" type="button" disabled>开始下载</button>',
            '  <button id="nme-dl-pause" class="nme-dl-btn" type="button" disabled>暂停</button>',
            '  <button id="nme-dl-stop" class="nme-dl-btn" type="button" disabled>停止</button>',
            '  <button id="nme-dl-clear" class="nme-dl-btn" type="button">清空历史</button>',
            '  <span id="nme-dl-status" class="nme-ai-status"></span>',
            '</div>',
            '<div class="nme-dl-prog"><div id="nme-dl-prog-fill" class="nme-dl-prog-fill"></div></div>',
            '<div id="nme-dl-log" class="nme-dl-log"></div>'
        ].join('');
        host.insertBefore(bar, host.firstChild);

        const gapEl = bar.querySelector('#nme-dl-gap');
        gapEl.value = CFG.dlGap;
        gapEl.addEventListener('change', function () {
            const v = Math.max(1, Math.min(60, parseInt(gapEl.value, 10) || 5));
            CFG.dlGap = v;
            gapEl.value = v;
            saveCfg();
        });

        bar.querySelector('#nme-dl-start').addEventListener('click', function () { startCollectionDownload(ctx); });
        bar.querySelector('#nme-dl-pause').addEventListener('click', function () {
            state.dlPaused = !state.dlPaused;
            this.textContent = state.dlPaused ? '继续' : '暂停';
            dlStatus(state.dlPaused ? '已暂停' : '继续下载…', state.dlPaused ? 'warn' : 'busy');
        });
        bar.querySelector('#nme-dl-stop').addEventListener('click', function () {
            state.dlStop = true;
            dlStatus('正在停止…', 'warn');
        });
        bar.querySelector('#nme-dl-clear').addEventListener('click', function () {
            const h = dlHistoryLoad();
            delete h[dlHistoryKey(ctx)];
            dlHistorySave(h);
            dlLog('已清空本合集下载历史', 'ok');
        });

        loadCollection(ctx);
    }

    async function loadCollection(ctx) {
        const sub = $('#nme-dl-sub');
        try {
            const d = await gqlRequest(Q_COLLECTION_MODS, {
                slug: ctx.collectionSlug,
                domain: ctx.domain || null
            }, 'CollectionRevisionMods');
            const rev = d && d.collectionRevision;
            if (!rev) throw new Error('未找到合集数据');
            const mods = (rev.modFiles || []).map(function (mf) {
                return {
                    fileId: mf.fileId,
                    name: (mf.file && mf.file.name) || '',
                    sizeInBytes: mf.file && mf.file.sizeInBytes,
                    modId: mf.file && mf.file.mod && mf.file.mod.modId,
                    domain: (mf.file && mf.file.mod && mf.file.mod.game && mf.file.mod.game.domainName) || ctx.domain,
                    gameId: mf.file && mf.file.mod && mf.file.mod.game && mf.file.mod.game.id,
                    optional: !!mf.optional
                };
            }).filter(function (m) { return m.fileId && m.modId && m.gameId; });

            state.dlQueue = mods;
            state.dlTotal = mods.length;
            const mandatory = mods.filter(function (m) { return !m.optional; }).length;
            if (sub) sub.textContent = mods.length + ' 个文件（必装 ' + mandatory + ' / 可选 ' + (mods.length - mandatory) + '）';
            const start = $('#nme-dl-start');
            if (start) start.disabled = mods.length === 0;
            dlLog('已读取合集：' + mods.length + ' 个文件');
        } catch (e) {
            if (sub) sub.textContent = '读取合集失败';
            dlStatus((e && e.message) || String(e), 'err');
        }
    }

    function setDlProgress(done, total) {
        const fill = $('#nme-dl-prog-fill');
        if (fill) fill.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
    }

    function setDlButtons(running) {
        const start = $('#nme-dl-start');
        const pause = $('#nme-dl-pause');
        const stop = $('#nme-dl-stop');
        if (start) { start.disabled = running; start.textContent = running ? '下载中…' : '开始下载'; }
        if (pause) { pause.disabled = !running; pause.textContent = '暂停'; }
        if (stop) stop.disabled = !running;
    }

    async function startCollectionDownload(ctx) {
        if (state.dlRunning) return;
        if (!state.dlQueue.length) { await loadCollection(ctx); }
        const queue = state.dlQueue || [];
        if (!queue.length) { dlStatus('合集里没有可下载的文件', 'err'); return; }

        if (!isLoggedIn()) { dlStatus('请先登录 Nexus Mods 账号', 'err'); return; }

        const ok = window.confirm(
            '即将逐个请求下载合集里的 ' + queue.length + ' 个文件。\n\n' +
            '· 会在当前页连续触发浏览器下载，出现「允许下载多个文件」时请允许；\n' +
            '· 免费账号会走慢速通道，间隔太短容易触发站点限流；\n' +
            '· 批量下载可能不符合 Nexus 的使用条款，请自行判断。\n\n' +
            '继续？'
        );
        if (!ok) return;

        const history = dlHistoryLoad();
        const key = dlHistoryKey(ctx);
        if ((history[key] || []).length) {
            const skip = window.confirm('历史里已有 ' + history[key].length + ' 个已下载文件。\n\n确定 = 跳过它们，只下缺的；取消 = 重新下载全部。');
            if (!skip) { history[key] = []; dlHistorySave(history); }
        }
        const done = history[key] || [];

        state.dlRunning = true;
        state.dlStop = false;
        state.dlPaused = false;
        state.dlDone = 0;
        state.dlCount = 0;
        let fails = 0;
        setDlButtons(true);
        dlStatus('开始下载…', 'busy');
        setDlProgress(0, queue.length);
        dlLog('开始下载，共 ' + queue.length + ' 个文件');

        for (let i = 0; i < queue.length; i++) {
            if (state.dlStop) break;
            while (state.dlPaused && !state.dlStop) await sleep(500);
            if (state.dlStop) break;

            const f = queue[i];
            if (done.indexOf(f.fileId) >= 0) {
                dlLog('[' + (i + 1) + '/' + queue.length + '] 跳过（历史已下载）：' + f.name);
                state.dlDone++;
                setDlProgress(state.dlDone, queue.length);
                continue;
            }
            if (dlTooSoon(f.fileId)) {
                dlLog('[' + (i + 1) + '/' + queue.length + '] 跳过（刚刚已手动触发）：' + f.name);
                state.dlDone++;
                setDlProgress(state.dlDone, queue.length);
                continue;
            }

            if (state.dlCount >= DL_RATE_LIMIT) {
                dlLog('已连续下载 ' + DL_RATE_LIMIT + ' 个，冷却 ' + DL_COOLDOWN + ' 秒…', 'warn');
                let left = DL_COOLDOWN;
                while (left > 0 && !state.dlStop) {
                    dlStatus('安全冷却中，剩余 ' + left + ' 秒', 'warn');
                    await sleep(1000);
                    left--;
                }
                state.dlCount = 0;
            }
            if (state.dlStop) break;

            dlStatus('[' + (i + 1) + '/' + queue.length + '] 正在获取：' + f.name, 'busy');
            try {
                const url = await resolveWithRetry(f.domain, f.modId, f.fileId, f.gameId);
                triggerDownload(url, f.name);
                markDl(f.fileId);
                done.push(f.fileId);
                history[key] = done;
                dlHistorySave(history);
                state.dlCount++;
                state.dlDone++;
                fails = 0;
                dlLog('[' + (i + 1) + '/' + queue.length + '] 已开始下载：' + f.name, 'ok');
            } catch (e) {
                const msg = (e && e.message) || String(e);
                const fatal = !!(e && e.fatal);
                fails++;
                dlLog('[' + (i + 1) + '/' + queue.length + '] 失败：' + f.name + ' — ' + msg, 'err');
                dlStatus(msg, 'err');
                if (fatal || fails >= 3) {
                    dlLog(fatal ? '遇到「' + msg + '」，已停止批量下载' : '连续 3 个文件失败，已停止批量下载', 'err');
                    state.dlStop = true;
                    break;
                }
            }
            setDlProgress(state.dlDone, queue.length);

            if (i < queue.length - 1 && !state.dlStop) {
                const gap = Math.max(1, CFG.dlGap || 5) * 1000;
                await sleep(gap);
            }
        }

        state.dlRunning = false;
        state.dlPaused = false;
        setDlButtons(false);
        if (state.dlStop) dlStatus('已停止（已下载的会记入历史）', 'warn');
        else dlStatus('批量下载结束：' + state.dlDone + ' / ' + queue.length + '（含历史跳过）', 'ok');
        setDlProgress(state.dlDone, queue.length);
    }

    // ---------- 下载等待页自动跳过 ----------

    function setupDownloadSkip() {
        if (!CFG.skipWait) return;
        const isWaitPage =
            /\/Core\/Libs\/Common\/Widgets\/DownloadPopUp/i.test(location.pathname + location.search) ||
            (/[?&]file_id=\d+/i.test(location.search) && /[?&]nmm=1/i.test(location.search));
        if (!isWaitPage) return;

        const guard = 'nme.skip.' + location.href;
        try { if (sessionStorage.getItem(guard)) return; } catch (e) { /* 忽略 */ }

        let tries = 0;
        const tick = function () {
            const btn = document.querySelector('#slowDownloadButton[data-download-url], [data-download-url]');
            const url = btn && decodeDlUrl(btn.getAttribute('data-download-url') || '');
            if (url && /^(https?:|nxm:)/i.test(url)) {
                try { sessionStorage.setItem(guard, '1'); } catch (e) { /* 忽略 */ }
                location.href = url;
                return;
            }
            tries++;
            if (tries < 120) setTimeout(tick, 250);
        };
        tick();
    }

    // ==================== 列表页：AI 解读当前页 ====================

    function renderPageDigest(data) {
        const groups = (data.groups || []).map(function (g) {
            const picks = (g.picks || []).map(function (p) {
                const name = escapeHtml(p.name || ('#' + p.id));
                const id = parseInt(p.id, 10);
                const dom = state.ctx && state.ctx.domain;
                const title = (dom && id > 0)
                    ? '<a href="https://www.nexusmods.com/games/' + encodeURIComponent(dom) + '/mods/' + id + '">' + name + '</a>'
                    : name;
                return '<li>' + title + '<span class="nme-ai-why">' + escapeHtml(p.why || '') + '</span></li>';
            }).join('');
            return '<div class="nme-ai-sec-title">' + escapeHtml(g.theme || '推荐') + '</div><ul class="nme-ai-list">' + picks + '</ul>';
        }).join('');
        return '<div class="nme-ai-card">' +
            '<div class="nme-ai-card-head">AI 解读本页</div>' +
            (groups || '<div class="nme-ai-text">AI 没有给出推荐。</div>') +
            (data.tip ? '<div class="nme-ai-sec-title">提示</div><div class="nme-ai-text">' + escapeHtml(data.tip) + '</div>' : '') +
            '</div>';
    }

    async function runPageDigest() {
        const btn = $('#nme-ai-digest');
        const out = $('#nme-ai-digest-out');
        if (!out) return;
        if (!aiConfigured()) { openAiSettings(); return; }
        if (!state.mods || !state.mods.length) {
            out.hidden = false;
            out.innerHTML = '<div class="nme-ai-card nme-ai-text">当前还没有加载到模组，先滚动加载一些再试。</div>';
            return;
        }
        const mods = state.mods.slice(0, 60);
        const fingerprint = 'pg.' + normKey(state.ctx.domain || '') + '.' + mods.map(function (m) { return m.modId; }).join('-');
        const cached = aiCacheGet(fingerprint);
        if (cached) {
            out.hidden = false;
            out.innerHTML = renderPageDigest(cached.v);
            return;
        }
        if (btn) btn.disabled = true;
        out.hidden = false;
        out.innerHTML = '<div class="nme-ai-card nme-ai-text">AI 正在解读本页 ' + mods.length + ' 个模组…</div>';
        try {
            const lines = mods.map(function (m) {
                return m.modId + ' | ' + (m.name || '') + ' | ' + (m.summary || '').slice(0, 90) +
                    ' | 下载 ' + (m.downloads || 0) + ' | 点赞 ' + (m.endorsements || 0) +
                    ' | ' + (m.modCategory && m.modCategory.name || '');
            }).join('\n');
            const prompt = '下面是 Nexus Mods 一个游戏模组列表页当前加载的模组（格式：id | 名称 | 简介 | 下载 | 点赞 | 分类）。\n' +
                '请从中挑选最值得安装的 5-8 个，并按用途分组。输出 JSON（只输出 JSON，不要 markdown 代码块）：\n' +
                '{"groups":[{"theme":"分组名","picks":[{"id":123,"name":"模组名","why":"一句话推荐理由"}]}],"tip":"一句总体建议"}\n\n' +
                '只从给定列表里选，id 必须原样保留。列表：\n' + lines;
            const text = await callAi(prompt, { temperature: 0.3, maxTokens: 1600 });
            const data = parseAiJson(text);
            aiCacheSet(fingerprint, data);
            out.innerHTML = renderPageDigest(data);
        } catch (e) {
            out.innerHTML = '<div class="nme-ai-card nme-ai-status-err">' + escapeHtml((e && e.message) || String(e)) + '</div>';
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // ==================== 中文找游戏：工具条交互 ====================

    function setCnMsg(text, kind) {
        const el = $('#nme-cn-msg');
        if (!el) return;
        el.textContent = text || '';
        el.className = 'nme-cn-msg' + (kind ? ' nme-cn-msg-' + kind : '');
    }

    function renderGameResults(list) {
        const box = $('#nme-cn-results');
        if (!box) return;
        box.hidden = false;
        if (!list || !list.length) {
            box.innerHTML = '<div class="nme-cn-empty">没有匹配到游戏。可以试试英文名或 Nexus 游戏域名（如 <code>stellarblade</code>）。</div>';
            return;
        }
        box.innerHTML = list.map(function (g) {
            const href = 'https://www.nexusmods.com/games/' + encodeURIComponent(g.domain) + '/mods';
            const count = g.modCount == null ? '' : '<span class="nme-cn-count">' + fmtNum(g.modCount) + ' 个模组</span>';
            return '<a class="nme-cn-item" href="' + href + '">' +
                '<span class="nme-cn-name">' + escapeHtml(g.name) + '</span>' +
                '<span class="nme-cn-domain">' + escapeHtml(g.domain) + '</span>' +
                count +
                '<span class="nme-cn-src">' + escapeHtml(g.source || '') + '</span>' +
                '</a>';
        }).join('');
    }

    async function runCnGameSearch() {
        const input = $('#nme-cn');
        const btn = $('#nme-cn-go');
        const term = (input && input.value || '').trim();
        if (!term) return;
        if (btn) btn.disabled = true;
        setCnMsg('正在解析「' + term + '」…', 'busy');
        const box = $('#nme-cn-results');
        if (box) { box.hidden = false; box.innerHTML = ''; }
        try {
            const list = await resolveGame(term);
            renderGameResults(list);
            if (!list.length) setCnMsg('未找到对应游戏', 'warn');
            else setCnMsg('找到 ' + list.length + ' 个候选，点选进入游戏模组页', 'ok');
        } catch (e) {
            setCnMsg((e && e.message) || String(e), 'err');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // ==================== 页面上下文 ====================

    /**
     * 解析当前页面属于哪类列表页，以及 URL 上已有的筛选条件。
     * 只认站点自己已经在用的 URL 参数，不臆造参数名。
     */
    function getContext() {
        const u = new URL(location.href);
        const path = u.pathname;
        let mode = null, domain = null, modId = 0, collectionSlug = null;

        const mGame = path.match(/^\/games\/([^/]+)\/mods\/?$/);
        const mLegacy = path.match(/^\/([^/]+)\/mods\/?$/);
        const mDetail = path.match(/^\/games\/([^/]+)\/mods\/(\d+)/) || path.match(/^\/([^/]+)\/mods\/(\d+)/);
        const mColl = path.match(/^\/games\/([^/]+)\/collections\/([^/?#]+)/) || path.match(/^\/([^/]+)\/collections\/([^/?#]+)/);
        if (mDetail) { mode = 'detail'; domain = mDetail[1]; modId = parseInt(mDetail[2], 10) || 0; }
        else if (mColl) { mode = 'collection'; domain = mColl[1]; collectionSlug = mColl[2]; }
        else if (mGame) { mode = 'list'; domain = mGame[1]; }
        else if (mLegacy) { mode = 'list'; domain = mLegacy[1]; }
        else if (/^\/search\/?$/.test(path) || path.indexOf('/search') === 0) {
            mode = 'search';
        }
        if (!mode) return null;

        const sp = u.searchParams;
        const categoryName = sp.getAll('categoryName').filter(Boolean);
        const tagNames = sp.getAll('tag').filter(Boolean);
        const languageName = sp.getAll('languageName').filter(Boolean);
        const keyword = sp.get('keyword') || '';

        return {
            mode: mode,
            domain: domain,
            modId: modId,
            collectionSlug: collectionSlug,
            keyword: keyword,
            categoryName: categoryName,
            tags: tagNames,
            languageName: languageName,
            page: parseInt(sp.get('page') || '1', 10) || 1
        };
    }

    // ==================== 增强视图 ====================

    const SORTS = [
        ['createdAt', '发布日期'],
        ['updatedAt', '最近更新'],
        ['downloads', '下载量'],
        ['uniqueDownloads', '独立下载量'],
        ['endorsements', '点赞数'],
        ['name', '模组名称'],
        ['size', '文件大小'],
        ['lastComment', '最近评论'],
        ['random', '随机惊喜']
    ];

    const state = {
        ctx: null,
        offset: 0,
        total: 0,
        loaded: 0,
        loading: false,
        done: false,
        error: '',
        retried: false,
        chips: { zh: false, zht: false, tr: false, hot: false },
        tpl: null,
        mods: [],
        modCache: null,
        io: null,
        // 下载增强
        dlFiles: [],
        dlGameId: 0,
        dlQueue: [],
        dlTotal: 0,
        dlRunning: false,
        dlPaused: false,
        dlStop: false,
        dlDone: 0,
        dlCount: 0
    };

    function buildVariables(offset) {
        const ctx = state.ctx;
        const chips = state.chips;

        const facets = {
            categoryName: ctx.categoryName.slice(),
            languageName: ctx.languageName.slice(),
            tag: ctx.tags.slice()
        };

        if (chips.zh && facets.languageName.indexOf('Simplified Chinese') < 0) {
            facets.languageName.push('Simplified Chinese');
        }
        if (chips.zht && facets.languageName.indexOf('Traditional Chinese') < 0) {
            facets.languageName.push('Traditional Chinese');
        }
        if (chips.tr && facets.tag.indexOf('Translation') < 0) {
            facets.tag.push('Translation');
        }
        if (chips.hot && facets.categoryName.indexOf('Animation') < 0) {
            // 「热门」用独立筛选表达：下载量下限
        }

        const filter = {
            adultContent: [{ op: 'EQUALS', value: false }],
            filter: [],
            gameDomainName: ctx.mode === 'list' ? [{ op: 'EQUALS', value: ctx.domain }] : [],
            name: [],
            op: 'AND'
        };

        const kw = (CFG.keyword || '').trim() || ctx.keyword;
        if (kw) filter.name = [{ op: 'WILDCARD', value: kw }];
        if (ctx.mode === 'search') filter.status = [{ op: 'EQUALS', value: 'published' }];

        const minDl = state.chips.hot ? Math.max(CFG.minDownloads || 0, 1000) : (CFG.minDownloads || 0);
        if (minDl > 0) filter.downloads = [{ op: 'GTE', value: minDl }];
        if (CFG.minEndorsements > 0) filter.endorsements = [{ op: 'GTE', value: CFG.minEndorsements }];
        if (CFG.maxSizeMB > 0) filter.fileSize = [{ op: 'LTE', value: Math.round(CFG.maxSizeMB * 1024 * 1024) }];

        const sort = {};
        sort[CFG.sortBy] = { direction: CFG.sortDir };

        return {
            count: CFG.pageSize,
            offset: offset,
            facets: facets,
            filter: filter,
            postFilter: {},
            sort: sort
        };
    }

    function makeTile(mod) {
        const tpl = state.tpl;
        const tile = tpl.cloneNode(true);

        // 去掉原生菜单按钮（headlessui 依赖 React，克隆后无功能且 id 重复）
        const menuBtn = tile.querySelector('button[aria-label="Mod options"]');
        if (menuBtn && menuBtn.parentElement) menuBtn.parentElement.removeChild(menuBtn);

        const setText = (sel, text) => {
            const el = tile.querySelector(sel);
            if (el) el.textContent = text;
            return el;
        };

        // 缩略图
        const thumbLink = tile.querySelector('a[href*="/mods/"]');
        const thumbImg = tile.querySelector('img');
        if (thumbLink) thumbLink.setAttribute('href', 'https://www.nexusmods.com/' + (mod.game && mod.game.domainName ? mod.game.domainName : '') + '/mods/' + mod.modId);
        if (thumbImg) {
            if (mod.thumbnailUrl) thumbImg.setAttribute('src', mod.thumbnailUrl);
            thumbImg.setAttribute('alt', mod.name || '');
        }

        // 标题
        const title = tile.querySelector('[data-e2eid="mod-tile-title"]');
        if (title) {
            title.textContent = mod.name || '';
            title.setAttribute('href', 'https://www.nexusmods.com/' + (mod.game && mod.game.domainName ? mod.game.domainName : '') + '/mods/' + mod.modId);
        }

        // 上传者
        const userLink = tile.querySelector('[data-e2eid="user-link"]');
        if (userLink) {
            const uname = (mod.uploader && mod.uploader.name) || '—';
            userLink.setAttribute('href', 'https://www.nexusmods.com/profile/' + encodeURIComponent(uname));
            const span = userLink.querySelector('span');
            if (span) span.textContent = uname;
            const avatar = userLink.querySelector('img[data-testid="user-link-avatar"]');
            if (avatar && mod.uploader && mod.uploader.avatar) avatar.setAttribute('src', mod.uploader.avatar);
        }

        // 分类
        const cat = tile.querySelector('[data-e2eid="mod-tile-category"]');
        if (cat) {
            const cname = (mod.modCategory && mod.modCategory.name) || '';
            cat.textContent = cname;
            if (cname && mod.game && mod.game.domainName) {
                cat.setAttribute('href', 'https://www.nexusmods.com/games/' + mod.game.domainName + '/mods?categoryName=' + encodeURIComponent(cname));
            }
        }

        // 时间
        const upd = tile.querySelector('[data-e2eid="mod-tile-updated"] time');
        if (upd) { upd.textContent = fmtRelative(mod.updatedAt); upd.setAttribute('datetime', mod.updatedAt || ''); }
        const upl = tile.querySelector('[data-e2eid="mod-tile-uploaded"] time');
        if (upl) { upl.textContent = fmtDate(mod.createdAt); upl.setAttribute('datetime', mod.createdAt || ''); }

        // 摘要
        const sum = tile.querySelector('[data-e2eid="mod-tile-summary"]');
        if (sum) sum.textContent = mod.summary || '';

        // 数值
        setText('[data-e2eid="mod-tile-endorsements"]', fmtNum(mod.endorsements));
        setText('[data-e2eid="mod-tile-downloads"]', fmtNum(mod.downloads));
        setText('[data-e2eid="mod-tile-file-size"]', fmtSize(mod.fileSize));

        // 语言徽章
        const badges = detectBadges(mod);
        if (badges.length && title && title.parentElement) {
            const holder = document.createElement('span');
            holder.className = 'nme-badges';
            for (let i = 0; i < badges.length; i++) {
                const b = document.createElement('span');
                b.className = 'nme-badge ' + badges[i].cls;
                b.textContent = badges[i].text;
                holder.appendChild(b);
            }
            title.parentElement.insertBefore(holder, title.nextSibling);
        }

        return tile;
    }

    function renderStatus() {
        const status = $('#nme-status');
        const msg = $('#nme-msg');
        const total = $('#nme-total');
        const loaded = $('#nme-loaded');
        if (!status) return;
        if (total) total.textContent = state.total ? fmtNum(state.total) : '—';
        if (loaded) loaded.textContent = fmtNum(state.loaded);

        if (state.error) {
            status.className = 'nme-status nme-status-err';
            if (msg) {
                msg.textContent = '';
                msg.appendChild(document.createTextNode('加载失败：' + state.error + ' '));
                const retry = document.createElement('button');
                retry.className = 'nme-btn';
                retry.type = 'button';
                retry.textContent = '重试';
                retry.addEventListener('click', function () {
                    state.retried = false;
                    loadPage(true);
                });
                msg.appendChild(retry);
            }
        } else if (state.done) {
            status.className = 'nme-status';
            if (msg) msg.textContent = '已全部加载。';
        } else if (state.loading) {
            status.className = 'nme-status';
            if (msg) msg.textContent = '加载中…';
        } else {
            status.className = 'nme-status';
            if (msg) msg.textContent = '继续滚动加载更多。';
        }
    }

    async function loadPage(reset) {
        if (state.loading) return;
        if (reset) {
            state.offset = 0;
            state.loaded = 0;
            state.total = 0;
            state.mods = [];
            state.done = false;
            state.error = '';
            state.retried = false;
            const grid = $('#nme-grid');
            if (grid) grid.innerHTML = '';
        }
        if (state.done) return;

        state.loading = true;
        renderStatus();

        try {
            const data = await queryMods(buildVariables(state.offset));
            state.total = data.totalCount || 0;
            const nodes = data.nodes || [];
            const grid = $('#nme-grid');
            if (grid) {
                const frag = document.createDocumentFragment();
                for (let i = 0; i < nodes.length; i++) frag.appendChild(makeTile(nodes[i]));
                grid.appendChild(frag);
            }
            state.loaded += nodes.length;
            state.offset += nodes.length;
            for (let i = 0; i < nodes.length; i++) state.mods.push(nodes[i]);
            if (nodes.length === 0 || state.offset >= state.total) state.done = true;
        } catch (e) {
            state.error = (e && e.message) || String(e);
            // 站点偶发限流/断连（实测批量请求后会出现 Failed to fetch），自动重试一次
            if (!state.retried) {
                state.retried = true;
                state.loading = false;
                renderStatus();
                setTimeout(function () { loadPage(false); }, 1500);
                return;
            }
        } finally {
            state.loading = false;
            renderStatus();
        }
    }

    // ==================== 工具条 ====================

    function buildPanel(ctx) {
        const panel = document.createElement('div');
        panel.id = 'nme-panel';

        const sortOptions = SORTS.map(function (s) {
            return '<option value="' + s[0] + '"' + (s[0] === CFG.sortBy ? ' selected' : '') + '>' + s[1] + '</option>';
        }).join('');

        panel.innerHTML = [
            '<div id="nme-toolbar">',
            '<div class="nme-bar">',
            '  <span class="nme-label">每页</span>',
            '  <select id="nme-size" class="nme-sel">',
            '    <option value="20"' + (CFG.pageSize === 20 ? ' selected' : '') + '>20</option>',
            '    <option value="40"' + (CFG.pageSize === 40 ? ' selected' : '') + '>40</option>',
            '    <option value="60"' + (CFG.pageSize === 60 ? ' selected' : '') + '>60</option>',
            '    <option value="80"' + (CFG.pageSize === 80 ? ' selected' : '') + '>80</option>',
            '  </select>',
            '  <span class="nme-label">排序</span>',
            '  <select id="nme-sort" class="nme-sel">' + sortOptions + '</select>',
            '  <button id="nme-dir" class="nme-btn" type="button">' + (CFG.sortDir === 'DESC' ? '降序' : '升序') + '</button>',
            '  <input id="nme-kw" class="nme-input" type="search" placeholder="关键词（模组名 / 描述）" value="' + escapeAttr(CFG.keyword || ctx.keyword || '') + '">',
            '</div>',
            '<div class="nme-bar">',
            '  <span class="nme-label">快捷</span>',
            '  <button class="nme-chip" type="button" data-chip="zh">简中</button>',
            '  <button class="nme-chip" type="button" data-chip="zht">繁中</button>',
            '  <button class="nme-chip" type="button" data-chip="tr">翻译</button>',
            '  <button class="nme-chip" type="button" data-chip="hot">热门（下载≥1000）</button>',
            '  <span class="nme-sep"></span>',
            '  <span class="nme-label">下载量≥</span><input id="nme-dl" class="nme-input nme-num" type="number" min="0" value="' + (CFG.minDownloads || 0) + '">',
            '  <span class="nme-label">点赞≥</span><input id="nme-ed" class="nme-input nme-num" type="number" min="0" value="' + (CFG.minEndorsements || 0) + '">',
            '  <span class="nme-label">大小≤MB</span><input id="nme-mb" class="nme-input nme-num" type="number" min="0" value="' + (CFG.maxSizeMB || 0) + '">',
            '  <button id="nme-reset" class="nme-btn" type="button">重置</button>',
            '  <button id="nme-view" class="nme-btn nme-btn-accent" type="button">切换到原生视图</button>',
            '</div>',
            '<div class="nme-bar nme-bar-cn">',
            '  <span class="nme-label">中文找游戏</span>',
            '  <input id="nme-cn" class="nme-input nme-cn-input" type="search" placeholder="输入中文名，如 剑星 / 上古卷轴5，回车查找" value="' + (CJK_RE.test(ctx.keyword || '') ? escapeAttr(ctx.keyword) : '') + '">',
            '  <button id="nme-cn-go" class="nme-btn nme-btn-accent" type="button">查找游戏</button>',
            '  <span id="nme-cn-msg" class="nme-cn-msg"></span>',
            '  <span class="nme-sep"></span>',
            '  <button id="nme-ai-digest" class="nme-btn" type="button">AI 解读本页</button>',
            '  <button id="nme-ai-cfg2" class="nme-btn" type="button">AI 配置</button>',
            '</div>',
            '<div id="nme-cn-results" class="nme-cn-results" hidden></div>',
            '<div id="nme-ai-digest-out" class="nme-ai-out" hidden></div>',
            '</div>',
            '<div id="nme-status" class="nme-status"><span id="nme-msg">准备中…</span> <span id="nme-counts">共 <b id="nme-total">—</b> 条结果 · 已加载 <b id="nme-loaded">0</b> 条</span></div>',
            '<div id="nme-grid" class="nme-grid"></div>',
            '<div id="nme-sentinel" class="nme-sentinel">滚动到底部自动加载更多</div>',
            '<button id="nme-fab" type="button" aria-pressed="true" title="当前：增强视图；点击切回原生视图">',
            '  <span class="nme-fab-dot" aria-hidden="true"></span><span id="nme-fab-text">增强视图</span>',
            '  <span class="nme-fab-swap" aria-hidden="true">⇄</span>',
            '</button>'
        ].join('');

        // 快捷筛选状态回显
        for (const k in state.chips) {
            if (state.chips[k]) {
                const b = panel.querySelector('.nme-chip[data-chip="' + k + '"]');
                if (b) b.classList.add('nme-chip-on');
            }
        }

        return panel;
    }

    function escapeAttr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function bindPanel(panel) {
        const on = (sel, ev, fn) => {
            const el = panel.querySelector(sel);
            if (el) el.addEventListener(ev, fn);
        };

        on('#nme-size', 'change', function () {
            CFG.pageSize = parseInt(this.value, 10) || 20;
            saveCfg();
            loadPage(true);
        });

        on('#nme-sort', 'change', function () {
            CFG.sortBy = this.value;
            saveCfg();
            loadPage(true);
        });

        on('#nme-dir', 'click', function () {
            CFG.sortDir = CFG.sortDir === 'DESC' ? 'ASC' : 'DESC';
            this.textContent = CFG.sortDir === 'DESC' ? '降序' : '升序';
            saveCfg();
            loadPage(true);
        });

        const kw = panel.querySelector('#nme-kw');
        if (kw) {
            kw.addEventListener('search', function () {
                CFG.keyword = this.value;
                saveCfg();
                loadPage(true);
            });
            kw.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    CFG.keyword = this.value;
                    saveCfg();
                    loadPage(true);
                }
            });
        }

        const numChange = debounce(function () {
            CFG.minDownloads = parseInt(panel.querySelector('#nme-dl').value, 10) || 0;
            CFG.minEndorsements = parseInt(panel.querySelector('#nme-ed').value, 10) || 0;
            CFG.maxSizeMB = parseInt(panel.querySelector('#nme-mb').value, 10) || 0;
            saveCfg();
            loadPage(true);
        }, 400);
        ['#nme-dl', '#nme-ed', '#nme-mb'].forEach(function (sel) {
            const el = panel.querySelector(sel);
            if (el) el.addEventListener('input', numChange);
        });

        panel.querySelectorAll('.nme-chip').forEach(function (btn) {
            btn.addEventListener('click', function () {
                const key = this.getAttribute('data-chip');
                state.chips[key] = !state.chips[key];
                this.classList.toggle('nme-chip-on', state.chips[key]);
                loadPage(true);
            });
        });

        on('#nme-reset', 'click', function () {
            CFG.keyword = '';
            CFG.minDownloads = 0;
            CFG.minEndorsements = 0;
            CFG.maxSizeMB = 0;
            state.chips = { zh: false, zht: false, tr: false, hot: false };
            panel.querySelectorAll('.nme-chip').forEach(function (b) { b.classList.remove('nme-chip-on'); });
            const k = panel.querySelector('#nme-kw'); if (k) k.value = '';
            const d = panel.querySelector('#nme-dl'); if (d) d.value = '0';
            const e2 = panel.querySelector('#nme-ed'); if (e2) e2.value = '0';
            const m = panel.querySelector('#nme-mb'); if (m) m.value = '0';
            saveCfg();
            loadPage(true);
        });

        on('#nme-view', 'click', function () {
            setView(CFG.view === 'enhanced' ? 'native' : 'enhanced');
        });

        on('#nme-fab', 'click', function () {
            setView(CFG.view === 'enhanced' ? 'native' : 'enhanced');
        });

        // —— 中文找游戏 ——
        const cn = panel.querySelector('#nme-cn');
        if (cn) {
            cn.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); runCnGameSearch(); }
            });
        }
        on('#nme-cn-go', 'click', runCnGameSearch);
        on('#nme-ai-cfg2', 'click', openAiSettings);
        on('#nme-ai-digest', 'click', runPageDigest);

        // 关键词里出现中文时，顺手提示走「中文找游戏」
        const kwEl = panel.querySelector('#nme-kw');
        if (kwEl && cn) {
            kwEl.addEventListener('input', function () {
                if (CJK_RE.test(this.value)) {
                    cn.value = this.value;
                    setCnMsg('中文关键词在 N 网搜不到，改按「中文找游戏」解析', 'warn');
                } else {
                    setCnMsg('', '');
                }
            });
            kwEl.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && CJK_RE.test(this.value)) {
                    e.preventDefault();
                    cn.value = this.value;
                    runCnGameSearch();
                }
            });
        }
    }

    let toastTimer = null;
    /** 右下角提示，用于视图切换与菜单操作的结果反馈 */
    function showToast(title, detail, kind) {
        if (!document.body) return;
        let t = $('#nme-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'nme-toast';
            t.setAttribute('role', 'status');
            t.setAttribute('aria-live', 'polite');
            document.body.appendChild(t);
        }
        t.className = 'nme-toast nme-toast-' + (kind || 'enhanced') + ' nme-toast-on';
        t.innerHTML = '<b>' + escapeHtml(title) + '</b><span>' + escapeHtml(detail || '') + '</span>';
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.classList.remove('nme-toast-on'); }, 3200);
    }

    /** 切换视图后给一次明确反馈，避免用户不知道刚才动了什么 */
    function showModeToast(view) {
        if (view === 'enhanced') {
            showToast('增强视图已开启', CFG.pageSize + ' 条/页 · 无限滚动 · 中文筛选 · 中文找游戏', 'enhanced');
        } else {
            showToast('已切回原生视图', '使用站点默认 20 条/页与自带筛选，增强工具条已隐藏', 'native');
        }
    }

    function setView(view) {
        const prev = CFG.view;
        CFG.view = view;
        saveCfg();
        const body = document.body;
        if (!body) return;
        body.classList.toggle('nme-view-enhanced', view === 'enhanced');
        body.classList.toggle('nme-view-native', view === 'native');

        const btn = $('#nme-view');
        if (btn) btn.textContent = (view === 'enhanced') ? '切换到原生视图' : '开启增强视图';

        const fab = $('#nme-fab');
        const fabText = $('#nme-fab-text');
        if (fab) {
            fab.setAttribute('aria-pressed', view === 'enhanced' ? 'true' : 'false');
            fab.setAttribute('title', view === 'enhanced'
                ? '当前：增强视图（已开启），点击切回原生视图'
                : '当前：原生视图（增强已关闭），点击开启增强视图');
        }
        if (fabText) fabText.textContent = (view === 'enhanced') ? '增强视图' : '原生视图 · 开启增强';

        if (view === 'enhanced' && state.loaded === 0 && state.ctx &&
            (state.ctx.mode === 'list' || state.ctx.mode === 'search')) {
            loadPage(true);
        }
        if (prev !== view) {
            if ($('#nme-panel')) showModeToast(view);
            else showToast('视图设置已保存', '回到列表或搜索页后生效', 'native');
        }
        refreshMenu();
    }

    // ==================== 样式 ====================

    function addStyle() {
        const css = [
            'body.nme-view-enhanced [data-nme-native="1"]{display:none !important;}',
            'body.nme-view-enhanced .mods-grid{display:none !important;}',
            'body.nme-view-native #nme-toolbar,body.nme-view-native #nme-grid,',
            'body.nme-view-native #nme-status,body.nme-view-native #nme-sentinel{display:none !important;}',
            'body.nme-view-native #nme-panel{margin:0;}',
            'body.nme-view-enhanced nav[aria-label*="Pagination" i]{display:none !important;}',
            '#nme-panel{margin:0 0 1.5rem;}',
            '#nme-panel .nme-bar{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin-bottom:.5rem;}',
            '#nme-panel .nme-label{font-size:.8125rem;opacity:.7;white-space:nowrap;}',
            '#nme-panel .nme-sel, #nme-panel .nme-input{background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.16);border-radius:.375rem;padding:.3rem .5rem;font-size:.8125rem;line-height:1.2;}',
            '#nme-panel .nme-input{min-width:12rem;flex:1 1 12rem;}',
            '#nme-panel .nme-num{width:6rem;flex:0 0 6rem;}',
            '#nme-panel .nme-btn{background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.16);border-radius:.375rem;padding:.3rem .6rem;font-size:.8125rem;cursor:pointer;}',
            '#nme-panel .nme-btn:hover{background:rgba(255,255,255,.12);}',
            '#nme-panel .nme-btn-accent{border-color:rgba(255,255,255,.32);}',
            '#nme-panel .nme-chip{background:transparent;color:inherit;border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:.2rem .7rem;font-size:.8125rem;cursor:pointer;}',
            '#nme-panel .nme-chip-on{background:#d34a4a;border-color:#d34a4a;color:#fff;}',
            '#nme-panel .nme-sep{width:1px;height:1.25rem;background:rgba(255,255,255,.16);margin:0 .25rem;}',
            '#nme-panel .nme-status{font-size:.8125rem;opacity:.75;margin:.35rem 0 .75rem;}',
            '#nme-panel .nme-status-err{color:#ff8a8a;opacity:1;}',
            '#nme-panel .nme-grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));}',
            '#nme-panel .nme-sentinel{text-align:center;font-size:.8125rem;opacity:.55;padding:1.25rem 0;}',
            '#nme-panel .nme-badges{display:inline-flex;gap:.25rem;margin-left:.35rem;vertical-align:middle;}',
            '#nme-panel .nme-badge{font-size:.6875rem;line-height:1.2;padding:.1rem .35rem;border-radius:.25rem;border:1px solid currentColor;}',
            '#nme-panel .nme-badge-hans{color:#e05c5c;}',
            '#nme-panel .nme-badge-hant{color:#d68b3c;}',
            '#nme-panel .nme-badge-zh{color:#e05c5c;}',
            '#nme-panel .nme-badge-tr{color:#5ca0e0;}',
            '#nme-panel .nme-badge-direct{color:#3fa66a;}',
            '#nme-fab{position:fixed;right:16px;bottom:16px;z-index:9999;display:inline-flex;align-items:center;gap:.45rem;',
            '  height:34px;padding:0 .8rem;border-radius:999px;border:1px solid rgba(255,255,255,.28);',
            '  background:rgba(20,20,22,.94);color:#e8e8e8;font-weight:600;font-size:.8125rem;cursor:pointer;',
            '  box-shadow:0 3px 14px rgba(0,0,0,.5);backdrop-filter:blur(6px);}',
            '#nme-fab:hover{background:rgba(44,44,48,.98);border-color:rgba(255,255,255,.46);}',
            '#nme-fab .nme-fab-dot{width:8px;height:8px;border-radius:50%;background:#3fa66a;box-shadow:0 0 0 3px rgba(63,166,106,.18);}',
            '#nme-fab .nme-fab-swap{opacity:.6;font-size:.95em;line-height:1;}',
            '#nme-fab:hover .nme-fab-swap{opacity:1;}',
            'body.nme-view-native #nme-fab{border-color:rgba(224,163,60,.65);color:#f0c37a;}',
            'body.nme-view-native #nme-fab .nme-fab-dot{background:#e0a33c;box-shadow:0 0 0 3px rgba(224,163,60,.2);}',
            '#nme-toast{position:fixed;right:16px;bottom:62px;z-index:10000;max-width:min(22rem,80vw);',
            '  padding:.6rem .8rem;border-radius:.55rem;border:1px solid rgba(255,255,255,.2);',
            '  background:rgba(20,20,22,.96);color:#eee;font-size:.8125rem;line-height:1.45;',
            '  box-shadow:0 6px 24px rgba(0,0,0,.5);opacity:0;transform:translateY(8px);',
            '  transition:opacity .18s ease,transform .18s ease;pointer-events:none;}',
            '#nme-toast.nme-toast-on{opacity:1;transform:translateY(0);}',
            '#nme-toast b{display:block;font-size:.875rem;margin-bottom:.15rem;color:#d34a4a;}',
            '#nme-toast.nme-toast-native b{color:#e0a33c;}',
            '#nme-toast span{opacity:.75;}',

            // —— 中文找游戏 ——
            '#nme-panel .nme-bar-cn{margin-top:.1rem;}',
            '#nme-panel .nme-cn-input{flex:1 1 18rem;}',
            '#nme-panel .nme-cn-msg{font-size:.8125rem;opacity:.7;}',
            '#nme-panel .nme-cn-msg-ok{color:#69c08a;opacity:1;}',
            '#nme-panel .nme-cn-msg-busy{color:#e0a33c;opacity:1;}',
            '#nme-panel .nme-cn-msg-warn{color:#e0a33c;opacity:1;}',
            '#nme-panel .nme-cn-msg-err{color:#ff8a8a;opacity:1;}',
            '#nme-panel .nme-cn-results{display:flex;flex-wrap:wrap;gap:.5rem;margin:.35rem 0 .85rem;}',
            '#nme-panel .nme-cn-item{display:flex;flex-direction:column;gap:.1rem;padding:.45rem .7rem;min-width:11rem;',
            '  border:1px solid rgba(255,255,255,.18);border-radius:.45rem;color:inherit;text-decoration:none;background:rgba(255,255,255,.03);}',
            '#nme-panel .nme-cn-item:hover{background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.3);}',
            '#nme-panel .nme-cn-name{font-weight:600;font-size:.875rem;}',
            '#nme-panel .nme-cn-domain{font-size:.75rem;opacity:.6;}',
            '#nme-panel .nme-cn-count{font-size:.75rem;opacity:.75;}',
            '#nme-panel .nme-cn-src{font-size:.6875rem;opacity:.5;}',
            '#nme-panel .nme-cn-empty{font-size:.8125rem;opacity:.8;}',

            // —— AI 工具条（列表页 + 详情页）——
            '#nme-ai-bar{margin:1rem 0;padding:.8rem .95rem;border:1px solid rgba(255,255,255,.16);',
            '  border-radius:.6rem;background:rgba(255,255,255,.04);}',
            '#nme-ai-bar .nme-ai-head{display:flex;align-items:baseline;gap:.55rem;flex-wrap:wrap;}',
            '#nme-ai-bar .nme-ai-title{font-weight:700;color:#d34a4a;}',
            '#nme-ai-bar .nme-ai-sub{font-size:.75rem;opacity:.6;}',
            '#nme-ai-bar .nme-ai-actions{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin-top:.6rem;}',
            '#nme-ai-bar .nme-ai-btn,#nme-panel .nme-ai-btn{background:rgba(255,255,255,.06);color:inherit;',
            '  border:1px solid rgba(255,255,255,.16);border-radius:.375rem;padding:.3rem .6rem;font-size:.8125rem;cursor:pointer;}',
            '#nme-ai-bar .nme-ai-btn:hover,#nme-panel .nme-ai-btn:hover{background:rgba(255,255,255,.12);}',
            '#nme-ai-bar .nme-ai-btn:disabled,#nme-panel .nme-ai-btn:disabled{opacity:.5;cursor:progress;}',
            '#nme-ai-bar .nme-ai-btn-accent,#nme-panel .nme-ai-btn-accent{background:#d34a4a;border-color:#d34a4a;color:#fff;}',
            '#nme-ai-status{font-size:.75rem;opacity:.7;}',
            '.nme-ai-status-ok{color:#69c08a !important;opacity:1;}',
            '.nme-ai-status-err,.nme-ai-status-err .nme-ai-status{color:#ff8a8a !important;opacity:1;}',
            '.nme-ai-status-busy{color:#e0a33c !important;opacity:1;}',
            '.nme-ai-status-warn{color:#e0a33c !important;opacity:1;}',
            '.nme-ai-out{margin:.35rem 0 .9rem;}',
            '#nme-ai-bar .nme-ai-out{margin-top:.75rem;}',
            '.nme-ai-card{border:1px solid rgba(255,255,255,.14);border-radius:.5rem;padding:.75rem .9rem;',
            '  background:rgba(255,255,255,.03);}',
            '.nme-ai-card-head{font-weight:600;margin-bottom:.5rem;display:flex;flex-wrap:wrap;gap:.3rem .75rem;align-items:baseline;}',
            '.nme-ai-tip{font-size:.75rem;font-weight:400;opacity:.6;}',
            '.nme-ai-text{font-size:.875rem;line-height:1.65;word-break:break-word;}',
            '.nme-ai-kv{display:flex;gap:.5rem;margin:.25rem 0;}',
            '.nme-ai-k{flex:0 0 5.5rem;opacity:.6;font-size:.8125rem;}',
            '.nme-ai-v{flex:1;font-size:.875rem;line-height:1.6;}',
            '.nme-ai-sec-title{font-weight:600;margin:.65rem 0 .25rem;}',
            '.nme-ai-list{margin:0;padding-left:1.1rem;}',
            '.nme-ai-list li{margin:.2rem 0;font-size:.875rem;line-height:1.55;}',
            '.nme-ai-list a{color:#7db4e6;text-decoration:none;}',
            '.nme-ai-list a:hover{text-decoration:underline;}',
            '.nme-ai-why{display:block;font-size:.75rem;opacity:.65;}',

            // —— AI 配置弹窗 ——
            '#nme-ai-cfg-modal{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.62);}',
            '#nme-ai-cfg-modal .nme-ai-modal{width:min(560px,92vw);max-height:88vh;overflow:auto;background:#1b1b1f;color:#eee;',
            '  border:1px solid rgba(255,255,255,.18);border-radius:.7rem;padding:1rem 1.1rem;box-shadow:0 10px 40px rgba(0,0,0,.55);}',
            '#nme-ai-cfg-modal .nme-ai-modal-title{font-weight:700;font-size:1rem;margin-bottom:.35rem;}',
            '#nme-ai-cfg-modal .nme-ai-modal-help{font-size:.78rem;line-height:1.6;opacity:.7;margin-bottom:.8rem;}',
            '#nme-ai-cfg-modal code{background:rgba(255,255,255,.1);padding:.05rem .3rem;border-radius:.2rem;}',
            '#nme-ai-cfg-modal .nme-ai-field{display:flex;flex-direction:column;gap:.25rem;margin-bottom:.6rem;}',
            '#nme-ai-cfg-modal .nme-ai-field span{font-size:.78rem;opacity:.75;}',
            '#nme-ai-cfg-modal .nme-ai-field input{background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.22);',
            '  border-radius:.35rem;padding:.42rem .55rem;font-size:.85rem;}',
            '#nme-ai-cfg-modal .nme-ai-modal-foot{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-top:.85rem;}',
            '#nme-ai-cfg-modal .nme-ai-modal-foot .nme-ai-status{flex:1;font-size:.78rem;}',
            '#nme-ai-cfg-modal .nme-ai-btn{background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.22);',
            '  border-radius:.375rem;padding:.35rem .8rem;font-size:.8125rem;cursor:pointer;}',
            '#nme-ai-cfg-modal .nme-ai-btn:hover{background:rgba(255,255,255,.16);}',
            '#nme-ai-cfg-modal .nme-ai-btn-accent{background:#d34a4a;border-color:#d34a4a;}',

            // —— 下载增强 ——
            '#nme-dl-bar{margin:1rem 0;padding:.8rem .95rem;border:1px solid rgba(255,255,255,.16);',
            '  border-radius:.6rem;background:rgba(255,255,255,.04);}',
            '#nme-dl-bar .nme-dl-head{display:flex;align-items:baseline;gap:.55rem;flex-wrap:wrap;}',
            '#nme-dl-bar .nme-dl-title{font-weight:700;color:#d34a4a;}',
            '#nme-dl-bar .nme-dl-sub{font-size:.75rem;opacity:.6;}',
            '#nme-dl-bar .nme-ai-status{font-size:.75rem;opacity:.7;}',
            '#nme-dl-bar .nme-dl-actions{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin-top:.6rem;}',
            '#nme-dl-bar .nme-dl-btn{background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.16);',
            '  border-radius:.375rem;padding:.3rem .6rem;font-size:.8125rem;cursor:pointer;}',
            '#nme-dl-bar .nme-dl-btn:hover{background:rgba(255,255,255,.12);}',
            '#nme-dl-bar .nme-dl-btn:disabled{opacity:.5;cursor:not-allowed;}',
            '#nme-dl-bar .nme-dl-btn-accent{background:#d34a4a;border-color:#d34a4a;color:#fff;}',
            '#nme-dl-bar .nme-dl-gap{width:4.5rem;background:rgba(255,255,255,.06);color:inherit;',
            '  border:1px solid rgba(255,255,255,.16);border-radius:.375rem;padding:.25rem .4rem;font-size:.8125rem;}',
            '#nme-dl-bar .nme-dl-list{margin-top:.6rem;display:flex;flex-direction:column;gap:.35rem;max-height:22rem;overflow:auto;}',
            '#nme-dl-bar .nme-dl-row{display:flex;align-items:center;gap:.6rem;padding:.4rem .55rem;',
            '  border:1px solid rgba(255,255,255,.1);border-radius:.4rem;background:rgba(255,255,255,.02);}',
            '#nme-dl-bar .nme-dl-main{flex:1;min-width:0;}',
            '#nme-dl-bar .nme-dl-name{font-size:.875rem;font-weight:600;word-break:break-word;}',
            '#nme-dl-bar .nme-dl-meta{font-size:.75rem;opacity:.6;margin-top:.1rem;}',
            '#nme-dl-bar .nme-dl-tag{display:inline-block;font-size:.6875rem;border:1px solid currentColor;',
            '  border-radius:.2rem;padding:0 .25rem;margin-left:.35rem;opacity:.8;vertical-align:middle;}',
            '#nme-dl-bar .nme-dl-empty{font-size:.8125rem;opacity:.7;}',
            '#nme-dl-bar .nme-dl-err{color:#ff8a8a;opacity:1;}',
            '#nme-dl-bar .nme-dl-prog{height:6px;border-radius:3px;background:rgba(255,255,255,.12);',
            '  overflow:hidden;margin-top:.6rem;}',
            '#nme-dl-bar .nme-dl-prog-fill{height:100%;width:0;background:#d34a4a;transition:width .25s;}',
            '#nme-dl-bar .nme-dl-log{margin-top:.5rem;max-height:9rem;overflow:auto;font-size:.75rem;line-height:1.55;',
            '  background:rgba(0,0,0,.22);border-radius:.35rem;padding:.4rem .55rem;}',
            '#nme-dl-bar .nme-dl-log-err{color:#ff8a8a;}',
            '#nme-dl-bar .nme-dl-log-ok{color:#69c08a;}',
            '#nme-dl-bar .nme-dl-log-warn{color:#e0a33c;}'
        ].join('\n');
        GM_addStyle(css);
    }

    // ==================== 启动 ====================

    function nativeTileTemplate() {
        const t = nativeTiles()[0];
        return t || null;
    }

    /** 站点自己的卡片（排除增强视图里的） */
    function nativeTiles() {
        return $$('[data-e2eid="mod-tile"]').filter(function (t) {
            return !t.closest('#nme-grid');
        });
    }

    function countNative(root) {
        if (!root || !root.querySelectorAll) return 0;
        return Array.from(root.querySelectorAll('[data-e2eid="mod-tile"]')).filter(function (t) {
            return !t.closest('#nme-grid');
        }).length;
    }

    /**
     * 原生网格容器。
     * 列表页是 .mods-grid，搜索页是 div.grid.*，两者结构不同，
     * 所以从第一张原生卡片向上找「原生卡片数最多」的那一层，不写死类名。
     */
    function findNativeGrid() {
        const tiles = nativeTiles();
        if (!tiles.length) return null;
        let node = tiles[0].parentElement;
        let best = node;
        let bestCount = countNative(node);
        while (node && node !== document.body) {
            const c = countNative(node);
            if (c > bestCount) { bestCount = c; best = node; }
            node = node.parentElement;
        }
        return best;
    }

    /** 需要在增强视图下隐藏的原生结果根节点 */
    function nativeHideRoot(grid) {
        const p = grid && grid.parentElement;
        if (p && p.tagName === 'SECTION') return p;   // 搜索页：连同「模组 (N)」分组一起隐藏
        return grid;
    }

    /** React 重渲染会换掉原生网格节点，需要重新打上隐藏标记 */
    function ensureNativeHidden() {
        if (CFG.view !== 'enhanced') return;
        const grid = findNativeGrid();
        if (!grid) return;
        const root = nativeHideRoot(grid);
        if (root && root.getAttribute('data-nme-native') !== '1') {
            root.setAttribute('data-nme-native', '1');
        }
    }

    /**
     * 站点筛选面板里，分类/语言/标签这些行只有左边那个小方框可点，
     * 点文字没反应（HeadlessUI 的 role=checkbox 没有关联 label）。
     * 这里把文字点击转发给方框，属于「更高效的筛选」范畴。
     */
    function enhanceFilterClick() {
        const rows = $$('[class*="group/checkbox"]');
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row.getAttribute('data-nme-click') === '1') continue;
            const cb = row.querySelector('[role=checkbox]');
            const label = row.querySelector('label');
            if (!cb || !label) continue;
            // 只有 label 指向真正的表单控件时，点击文字才会被浏览器转发；
            // Nexus 的 HeadlessUI 把 for 指向 <span role=checkbox>，浏览器不认，
            // 所以这里统一自己转发。
            const forId = label.getAttribute('for');
            const forEl = forId ? document.getElementById(forId) : null;
            const labelable = forEl && /^(INPUT|SELECT|TEXTAREA|BUTTON|METER|OUTPUT|PROGRESS)$/.test(forEl.tagName);
            if (labelable) continue;
            label.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                cb.click();
            });
            row.setAttribute('data-nme-click', '1');
        }
    }

    function mountEnhanced() {
        const ctx = state.ctx;
        if (!ctx) return;
        if ($('#nme-panel')) return;

        const tpl = nativeTileTemplate();
        if (!tpl) return; // 原生列表还没渲染出来，稍后重试
        state.tpl = tpl;

        const grid = findNativeGrid();
        if (!grid || !grid.parentElement) return;

        // 隐藏根节点：列表页 = 网格本身；搜索页 = 包含「模组 (N)」的 section
        const root = nativeHideRoot(grid);
        root.setAttribute('data-nme-native', '1');

        const panel = buildPanel(ctx);
        root.parentElement.insertBefore(panel, root);
        bindPanel(panel);

        setView(CFG.view);

        // 无限滚动
        const sentinel = $('#nme-sentinel');
        if (sentinel && window.IntersectionObserver) {
            state.io = new IntersectionObserver(function (entries) {
                for (let i = 0; i < entries.length; i++) {
                    if (entries[i].isIntersecting && !state.loading && !state.done) loadPage(false);
                }
            }, { rootMargin: '600px 0px' });
            state.io.observe(sentinel);
        }
    }

    function decorateNativeTiles(root) {
        if (!CFG.badges) return;
        const scope = root && root.querySelectorAll ? root : document;
        const tiles = scope.querySelectorAll('[data-e2eid="mod-tile"]');
        for (let i = 0; i < tiles.length; i++) {
            const tile = tiles[i];
            if (tile.closest('#nme-grid')) continue; // 增强视图的卡片自带徽章
            if (tile.getAttribute('data-nme-badged') === '1') continue;
            const title = tile.querySelector('[data-e2eid="mod-tile-title"]');
            if (!title) continue;
            const name = title.textContent || '';
            const badges = detectBadges({ name: name, tags: [] });
            if (!badges.length) { tile.setAttribute('data-nme-badged', '1'); continue; }
            const holder = document.createElement('span');
            holder.className = 'nme-badges';
            for (let j = 0; j < badges.length; j++) {
                const b = document.createElement('span');
                b.className = 'nme-badge ' + badges[j].cls;
                b.textContent = badges[j].text;
                holder.appendChild(b);
            }
            if (title.parentElement) title.parentElement.insertBefore(holder, title.nextSibling);
            tile.setAttribute('data-nme-badged', '1');
        }
    }

    // 菜单项要能反映当前状态，所以每次变更后反注册再注册。
    // 个别管理器不返回菜单 id，此时退化为只注册一次，避免菜单堆叠。
    const CAN_UNREG_MENU = typeof GM_unregisterMenuCommand === 'function';
    let menuIds = [];
    let menuRegistered = false;
    let menuRefreshable = CAN_UNREG_MENU;

    function refreshMenu() {
        if (!menuRefreshable) return;
        // 异步重建：避免在菜单回调里同步反注册正在执行的那一条
        setTimeout(function () { setupMenu(); }, 0);
    }

    function setupMenu() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        if (menuRegistered && !menuRefreshable) return;
        try {
            if (CAN_UNREG_MENU) {
                for (let i = 0; i < menuIds.length; i++) {
                    try { GM_unregisterMenuCommand(menuIds[i]); } catch (e) { /* 忽略单个失败 */ }
                }
            }
            menuIds = [];
            const reg = function (label, fn) {
                const id = GM_registerMenuCommand(label, fn);
                if (id === undefined || id === null) menuRefreshable = false;
                else menuIds.push(id);
            };

            const enhanced = CFG.view === 'enhanced';
            reg(enhanced ? '视图：增强视图（点击切到原生）' : '视图：原生视图（点击切到增强）', function () {
                setView(CFG.view === 'enhanced' ? 'native' : 'enhanced');
            });

            [20, 40, 60, 80].forEach(function (n) {
                reg('每页条数：' + n + (CFG.pageSize === n ? ' ✓' : ''), function () {
                    CFG.pageSize = n;
                    saveCfg();
                    refreshMenu();
                    if (CFG.view === 'enhanced') {
                        showToast('每页条数：' + n, '正在重新加载列表…', 'enhanced');
                        loadPage(true);
                    } else {
                        showToast('每页条数：' + n, '当前为原生视图，切回增强视图后生效', 'native');
                    }
                });
            });

            reg('界面中文化：' + (CFG.zhUI ? '开 ✓' : '关'), function () {
                CFG.zhUI = !CFG.zhUI;
                saveCfg();
                refreshMenu();
                if (CFG.zhUI) {
                    translateTree(document.body);
                    showToast('界面中文化：已开启', '站点界面文本已替换为中文', 'enhanced');
                } else {
                    showToast('界面中文化：已关闭', '已翻译的文本需刷新页面才会恢复英文', 'native');
                }
            });

            reg('语言徽章：' + (CFG.badges ? '开 ✓' : '关'), function () {
                CFG.badges = !CFG.badges;
                saveCfg();
                refreshMenu();
                decorateNativeTiles(document.body);
            });

            reg('下载等待页自动跳过：' + (CFG.skipWait ? '开 ✓' : '关'), function () {
                CFG.skipWait = !CFG.skipWait;
                saveCfg();
                refreshMenu();
                showToast('下载等待页自动跳过：' + (CFG.skipWait ? '开' : '关'),
                    CFG.skipWait ? '下次进入下载等待页时自动跳转' : '下次进入下载等待页时保持原样', 'enhanced');
            });

            reg('AI 接口配置（翻译 / 分析）', openAiSettings);

            menuRegistered = true;
        } catch (e) { /* 忽略 */ }
    }

    function init() {
        addStyle();
        setupMenu();

        // 下载等待页：尽早开始等待按钮
        setupDownloadSkip();

        const ctx = getContext();
        state.ctx = ctx;

        if (CFG.zhUI) translateTree(document.body);
        enhanceFilterClick();

        if (ctx) {
            if (ctx.mode === 'detail') {
                // 模组详情页：AI 工具条 + 下载卡
                let tries = 0;
                const tryMountAi = function () {
                    tries++;
                    mountDetailAi(ctx);
                    mountDetailDownload(ctx);
                    if ((!$('#nme-ai-bar') || !$('#nme-dl-bar')) && tries < 40) setTimeout(tryMountAi, 250);
                };
                tryMountAi();
            } else if (ctx.mode === 'collection') {
                // 合集页：批量下载面板
                let tries = 0;
                const tryMountColl = function () {
                    tries++;
                    if ($('#nme-dl-bar')) return;
                    mountCollectionDownload(ctx);
                    if (!$('#nme-dl-bar') && tries < 40) setTimeout(tryMountColl, 250);
                };
                tryMountColl();
            } else {
                // 等原生列表渲染出第一张卡片再挂载增强视图（需要克隆原生卡片做样式模板）
                let tries = 0;
                const tryMount = function () {
                    tries++;
                    if ($('#nme-panel')) return;
                    mountEnhanced();
                    if (!$('#nme-panel') && tries < 40) setTimeout(tryMount, 250);
                };
                tryMount();
            }
        }

        // 站点是 React 客户端渲染，后续内容需要持续处理（中文化 + 徽章 + 详情页 AI 条）
        const obs = new MutationObserver(debounce(function () {
            if (CFG.zhUI) translateTree(document.body);
            if (CFG.badges) decorateNativeTiles(document.body);
            enhanceFilterClick();
            if (state.ctx && state.ctx.mode === 'detail') {
                mountDetailAi(state.ctx);
                mountDetailDownload(state.ctx);
            } else if (state.ctx && state.ctx.mode === 'collection') {
                mountCollectionDownload(state.ctx);
            } else {
                ensureNativeHidden();
            }
        }, 250));
        try { obs.observe(document.body, { childList: true, subtree: true }); } catch (e) { /* 忽略 */ }

        console.log('%c' + LOG_PREFIX + ' v' + VERSION + ' 已启动', 'color:#d34a4a;font-weight:bold;font-size:13px');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
