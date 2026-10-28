/* =====================================================================
 * HubRelay —— relay 数据回流客户端共享库 v0.2.0（hub-relay.lib.js）
 * =====================================================================
 * 用途：让任意插件以「零额外 Steam 请求」把已拿到的数据回流给 data-hub
 *       （观测中转库），并可选地批量读取 hub 已有详情做首屏预填。
 *
 * 平台化约定（与 sglv-plugin-host / saa-auth 同族）：
 *   · 源在本仓 shared/；分发副本在 SmallRob/steam-namespace（@require 钉 commit）
 *   · 零依赖：鉴权复用宿主 @require 的 window.SAAAuth（设备私钥/会话/签名）
 *   · 缺 SAAAuth / GM_* → 静默禁用（enabled() 恒 false，绝不抛错）
 *
 * v0.2.0 新增（个人域 personal_merge，2026-10-28）：
 *   · `privacy` 开关（**默认关**）：关着时所有 personal kind 一律不入箱；
 *   · enqueue 第 4 参支持 `{ entitySubject }`：personal kind 的主体（当前页面 steamid）；
 *   · 本地主体自过滤：会话主体（SAAAuth.getState().subject）与 entitySubject 不一致 → 直接丢弃
 *     （多账号同浏览器时，小号页面的数据绝不上报进大号名下。★这只是省流量的本地闸，
 *      真正的安全边界在服务端 A 档 —— 服务端仍然用会话 subject 重算校验）；
 *   · capabilities()：暴露 privacy / 会话主体 / 可用 personal kind 列表。
 *
 * 限频与限次（v0.1 的第一公民，别裸奔）：
 *   · 出箱合并：同 (kind, entityKey) 在 mergeWindowMs(10min) 内**覆盖**不堆积
 *   · flush 节流：两次成功发送 ≥ minFlushGapMs(30s)；单批 ≤ batchMax(50)
 *   · 日配额：本地按 /relay/kinds 的 quotaDailyDevice × quotaSafety(0.5) 截流，
 *     每日计数按 Asia/Shanghai 日界（与服务端同口径）
 *   · 退避：429/503 按 retryAfter 或 5min 暂停；连败 3 次暂停 10min；
 *     E_RELAY_DISABLED（kill switch）暂停 24h
 *   · 出箱上限 maxOutbox(2000)：超限丢最旧（上报绝不影响宿主内存/存储）
 *
 * 接口（window.HubRelay）：
 *   configure(opts)   { pluginId, pluginVer, seal, baseUrl?, enabledFn?,
 *                       storage?, privacy?, subjectFn? }
 *                     —— enabledFn: () => boolean（宿主开关）
 *                     —— privacy:   true 才上报 personal kind（默认 false）
 *                     —— subjectFn: () => string（当前页面 steamid，缺省读会话主体）
 *   enqueue(kind, entityKey, data, opts?)  —— 入箱（opts.entitySubject 供 personal kind）
 *   flushNow()                            —— 立即尝试一次冲刷（受节流约束）
 *   appsBatch(ids, cc) → Promise<obj|null> 读辅助（失败回 null，零回归）
 *   capabilities()                       —— { privacy, subject, personalKinds, ... }
 *   state()                              —— { pending, todayCount, pausedUntil, privacy }
 *   VERSION
 * ===================================================================== */
(function (root) {
    'use strict';

    const VERSION = '0.2.0';

    const DEFAULTS = {
        // 生产公网端点（与插件三级回落的兜底常量同口径）。
        // ★ 127.0.0.1:18777 只是服务器本地调试地址，发布物一律不许用；
        //   seal 与公网 hub（hub.leansoftx.com 反代到本机生产 hub）同一注册表，直接有效。
        //   接入方应显式传三级回落解析出的 baseUrl（用户设置 → 远程 hub-endpoint.json → 兜底常量），
        //   本默认值只在漏传时兜底，保证打到生产而不是调用方自己的 localhost。
        baseUrl: 'https://hub.leansoftx.com',
        // ★ 个人域的默认姿态是「关」：库升级不能替用户做主，把个人库/愿望单开始上报。
        //   宿主必须在设置页给出明确开关，用户勾选后才传 privacy:true。
        privacy: false,
        mergeWindowMs: 10 * 60 * 1000,
        flushIntervalMs: 60 * 1000,
        minFlushGapMs: 30 * 1000,
        batchMax: 50,
        requestMax: 200,                     // 服务端硬上限
        maxOutbox: 2000,
        maxConsecutiveFails: 3,
        pauseOn429Ms: 5 * 60 * 1000,
        pauseOnFailMs: 10 * 60 * 1000,
        pauseOnDisabledMs: 24 * 60 * 60 * 1000,
        kindsRefreshMs: 12 * 60 * 60 * 1000,
        quotaSafety: 0.5,
        gmPrefix: 'hub_relay_',
    };

    let cfg = null;               // configure 后的有效配置
    let kindsCache = null;        // /relay/kinds 协商结果 { at, kinds: Map }
    let flushing = false;         // 单飞锁
    let lastFlushAt = 0;           // 上次成功发送时刻（节流）
    let pausedUntil = 0;           // 退避暂停
    let consecutiveFails = 0;
    let timer = null;

    // ------------------------------------------------------------------
    // 宿主环境探测（缺任一依赖 → 库整体禁用，行为 = 未安装）
    // ------------------------------------------------------------------
    const GM = {
        // ★ 必须显式 root.GM_*：裸全局引用在无 GM 环境会 ReferenceError 被吞成默认值
        //   （node 单测实测踩过：GM store 永远读不中，日配额截流静默失效）
        get(k, d) { try { return root.GM_getValue ? root.GM_getValue(k, d) : d; } catch (e) { return d; } },
        set(k, v) { try { if (root.GM_setValue) root.GM_setValue(k, v); } catch (e) { /* ignore */ } },
        del(k) {
            try {
                if (root.GM_deleteValue) root.GM_deleteValue(k);
                else if (root.GM_setValue) root.GM_setValue(k, undefined);
            } catch (e) { /* ignore */ }
        },
    };
    function auth() {
        try { return (root.SAAAuth && root.SAAAuth.ensureSession) ? root.SAAAuth : null; }
        catch (e) { return null; }
    }
    /** 会话主体（Steam OpenID 登录时落定的 steamid；未登录 / 旧版 SAAAuth 无该字段 → 空串） */
    function sessionSubject() {
        try {
            const A = auth();
            const s = A && A.getState ? A.getState() : null;
            return s && s.subject ? String(s.subject) : '';
        } catch (e) { return ''; }
    }
    function httpAvailable() { return typeof root.GM_xmlhttpRequest === 'function'; }
    function enabled() {
        if (!cfg) return false;
        if (!auth() || !httpAvailable()) return false;
        if (cfg.enabledFn && !cfg.enabledFn()) return false;
        return Date.now() >= pausedUntil;
    }

    // ------------------------------------------------------------------
    // 日界（Asia/Shanghai，与服务端 relay_quota_day 同口径）
    // ------------------------------------------------------------------
    function dayKey(now) {
        return new Date((now || Date.now()) + 8 * 3600 * 1000).toISOString().slice(0, 10);
    }

    // ------------------------------------------------------------------
    // 存储层：浏览器默认 IndexedDB 出箱；node 单测可注入内存实现。
    //   约定接口：all() / put(item) / delete(id) / deleteOldest(n) / count()
    //   item = { id, kind, entityKey, data, observedAt, enqueuedAt }
    //   （id = `${kind}|${entityKey}`，合并窗口按它去重）
    // ------------------------------------------------------------------
    function createIdbStorage(dbName, storeName) {
        let dbp = null;
        function open() {
            if (dbp) return dbp;
            dbp = new Promise((resolve, reject) => {
                const rq = indexedDB.open(dbName, 1);
                rq.onupgradeneeded = () => { rq.result.createObjectStore(storeName, { keyPath: 'id' }); };
                rq.onsuccess = () => resolve(rq.result);
                rq.onerror = () => reject(rq.error);
            });
            return dbp;
        }
        function tx(mode, fn) {
            return open().then((db) => new Promise((resolve, reject) => {
                const t = db.transaction(storeName, mode);
                const st = t.objectStore(storeName);
                const req = fn(st);
                t.oncomplete = () => resolve(req && req.result);
                t.onerror = () => reject(t.error);
            }));
        }
        return {
            all() { return tx('readonly', (st) => st.getAll()).then((r) => r || []); },
            put(item) { return tx('readwrite', (st) => st.put(item)); },
            delete(id) { return tx('readwrite', (st) => st.delete(id)); },
            deleteOldest(n) {
                return tx('readonly', (st) => st.getAll()).then((rows) => {
                    rows = (rows || []).sort((a, b) => a.enqueuedAt - b.enqueuedAt).slice(0, n);
                    return Promise.all(rows.map((r) => tx('readwrite', (st) => st.delete(r.id)))).then(() => rows.length);
                });
            },
            count() { return this.all().then((a) => a.length); },
        };
    }

    function storage() {
        if (cfg.storage) return cfg.storage;             // 注入（测试）
        if (!cfg._storage) cfg._storage = createIdbStorage(DEFAULTS.gmPrefix + 'outbox', 'items');
        return cfg._storage;
    }

    // ------------------------------------------------------------------
    // 本地日配额（协商值 × 安全系数；超出静默丢弃该 kind 的新入箱）
    // ------------------------------------------------------------------
    function kindQuota(kind) {
        const k = kindsFor(kind);
        return k ? Math.floor((k.quotaDailyDevice || 10000) * DEFAULTS.quotaSafety) : 3000;
    }
    function kindsFor(kind) {
        if (!kindsCache) return null;
        if (!kindsCache.kindMap) {   // 旧缓存（无 kindMap）的惰性构建
            kindsCache.kindMap = {};
            for (const k of (kindsCache.kinds || [])) kindsCache.kindMap[k.kind] = k;
        }
        return kindsCache.kindMap[kind] || null;
    }
    function todayCount(kind) {
        const o = GM.get(DEFAULTS.gmPrefix + 'day_' + dayKey(), {});
        return kind ? (o[kind] || 0) : Object.values(o).reduce((s, n) => s + n, 0);
    }
    function bumpToday(kind, n) {
        const key = DEFAULTS.gmPrefix + 'day_' + dayKey();
        const o = GM.get(key, {});
        o[kind] = (o[kind] || 0) + n;
        GM.set(key, o);
        // 顺手清前一天的键（只保留当天）
        GM.del(DEFAULTS.gmPrefix + 'day_' + dayKey(Date.now() - 26 * 3600 * 1000));
    }

    // ------------------------------------------------------------------
    // HTTP（GM_xmlhttpRequest；SAAAuth.request 自带签名与会话，读辅助走它）
    // ------------------------------------------------------------------
    function relayRequest(path, method, bodyObj) {
        const A = auth();
        if (!A) return Promise.resolve({ status: 0, data: null });
        return A.ensureSession().then(() => A.request(path, { method, body: bodyObj }))
            .catch((e) => ({ status: 0, data: null, error: String(e && e.message || e) }));
    }

    function refreshKinds(force) {
        const cached = GM.get(DEFAULTS.gmPrefix + 'kinds_v1', null);
        const fresh = cached && (Date.now() - cached.at) < DEFAULTS.kindsRefreshMs;
        if (!force && fresh) { kindsCache = cached; return Promise.resolve(cached); }
        return relayRequest('/relay/kinds', 'GET').then((r) => {
            if (r.status !== 200 || !r.data || !r.data.ok || !Array.isArray(r.data.kinds)) {
                if (cached) { kindsCache = cached; return cached; }   // 协商失败用旧缓存
                return null;
            }
            const kindMap = {};
            for (const k of r.data.kinds) kindMap[k.kind] = k;
            kindsCache = { at: Date.now(), kinds: r.data.kinds, idFormula: r.data.idFormula, kindMap };
            GM.set(DEFAULTS.gmPrefix + 'kinds_v1', kindsCache);
            return kindsCache;
        });
    }

    // ------------------------------------------------------------------
    // obs_id：sha1(deviceId|pluginId|kind|entityKey|floor(observedAt/idemBucketMs))
    //   （WebCrypto SHA-1；deviceId 取会话——防伪公式要求服务端可重算）
    // ------------------------------------------------------------------
    function sha1Hex(str) {
        const data = new TextEncoder().encode(str);
        return crypto.subtle.digest('SHA-1', data).then((buf) => {
            return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
        });
    }
    function obsId(deviceId, kind, entityKey, observedAt) {
        const k = kindsFor(kind);
        const bucketMs = k ? k.idemBucketMs : 3600000;
        return sha1Hex(`${deviceId}|${cfg.pluginId}|${kind}|${entityKey}|${Math.floor(observedAt / bucketMs)}`);
    }

    // ------------------------------------------------------------------
    // 入箱（全异步零抛；截流/合并/超限丢弃都在这里）
    // ------------------------------------------------------------------
    /**
     * 入箱（全异步零抛；截流/合并/超限丢弃都在这里）
     * @param {string} kind
     * @param {string|number} entityKey
     * @param {object} data
     * @param {{entitySubject?:string, _retried?:boolean}} [opts]
     *        entitySubject：personal kind 的主体（当前页面 steamid），缺省读 cfg.subjectFn()
     * @returns {Promise<boolean>} true=已入箱
     */
    function enqueue(kind, entityKey, data, opts) {
        const o = opts || {};
        if (!enabled()) return Promise.resolve(false);
        const meta = kindsFor(kind);
        if (!meta) {
            // 首次：先协商再入。★只重试一次——协商后仍不认识的 kind 直接本地拒；
            //   否则「缓存里有 kinds 但没这个 kind」会无限递归（测试逮住：Map 爆栈）
            if (o._retried) return Promise.resolve(false);
            return refreshKinds().then(() => enqueue(kind, entityKey, data,
                { entitySubject: o.entitySubject, _retried: true }));
        }
        // ── 个人域三道本地闸（省流量与防串号；安全边界在服务端 A 档）────────────
        //   ① 隐私开关未开 → 不上报（默认姿态：库升级不替用户做主）
        //   ② 主体必须是 17 位 steamid
        //   ③ 会话主体已知且与上报主体不一致 → 丢弃（多账号同浏览器，绝不串号）
        let entitySubject = null;
        if (meta.dataClass === 'personal') {
            if (!cfg.privacy) return Promise.resolve(false);
            entitySubject = o.entitySubject ? String(o.entitySubject)
                : (cfg.subjectFn ? String(cfg.subjectFn() || '') : '');
            if (!/^\d{17}$/.test(entitySubject)) return Promise.resolve(false);
            const sess = sessionSubject();
            if (sess && sess !== entitySubject) return Promise.resolve(false);
        }
        if (todayCount(kind) >= kindQuota(kind)) return Promise.resolve(false);   // 本地日配额截流
        const st = storage();
        const id = `${kind}|${entityKey}`;
        const now = Date.now();
        return st.all().then((rows) => {
            const prev = rows.find((r) => r.id === id);
            if (prev && (now - prev.enqueuedAt) < DEFAULTS.mergeWindowMs) {
                prev.data = data;                    // 合并窗口内覆盖（不堆积）
                prev.observedAt = now;
                prev.enqueuedAt = now;
                if (entitySubject) prev.entitySubject = entitySubject;
                return st.put(prev).then(() => true);
            }
            if (rows.length >= DEFAULTS.maxOutbox) {
                st.deleteOldest(rows.length - DEFAULTS.maxOutbox + 1);   // 超限丢最旧
            }
            return st.put(Object.assign({ id, kind, entityKey, data, observedAt: now, enqueuedAt: now },
                entitySubject ? { entitySubject } : {}))
                .then(() => { bumpToday(kind, 1); return true; });
        }).catch(() => false);
    }

    // ------------------------------------------------------------------
    // 冲刷（单飞；节流；退避；组批 ≤ batchMax；按 id 删除已表态条目）
    // ------------------------------------------------------------------
    function flushNow(force) {
        if (flushing || !enabled()) return Promise.resolve(null);
        const now = Date.now();
        if (!force && (now - lastFlushAt) < DEFAULTS.minFlushGapMs) return Promise.resolve(null);
        flushing = true;
        let sent = 0;
        return storage().all()
            .then((rows) => {
                if (rows.length === 0) return null;
                const batch = rows.sort((a, b) => a.enqueuedAt - b.enqueuedAt)
                    .slice(0, Math.min(DEFAULTS.batchMax, DEFAULTS.requestMax));
                const A = auth();
                // 会话可用性预检：无 seal（远程托管）且 state 仍是 idle（从未登录）→ 直接跳过。
                // 不预检的话每轮都会 ensureSession 抛 NEEDS_STEAM_LOGIN → 计入连败 →
                // 10 分钟暂停 + 控制台噪音，而真实原因只是「用户还没登录」。
                const st0 = A.getState ? A.getState() : null;
                if (!cfg.seal && (!st0 || st0.status === 'idle')) return null;
                return A.ensureSession().then(() => {
                    const deviceId = (A.getState() && A.getState().deviceId) || '';
                    if (!deviceId) throw new Error('no-device');
                    return Promise.all(batch.map((r) => obsId(deviceId, r.kind, r.entityKey, r.observedAt)
                        .then((id) => {
                            const rep = {
                                id, kind: r.kind, entityKey: r.entityKey,
                                observedAt: r.observedAt, data: r.data,
                            };
                            // personal kind 必须带主体（服务端 A 档：会话 subject 重算校验）
                            if (r.entitySubject) rep.entitySubject = r.entitySubject;
                            return rep;
                        })));
                }).then((reports) => relayRequest('/relay/report', 'POST', {
                    pluginId: cfg.pluginId, pluginVer: cfg.pluginVer, reports,
                }).then((r) => ({ r, reports }))).then(({ r, reports }) => {
                    if (r.status === 200 && r.data && r.data.ok) {
                        lastFlushAt = Date.now();
                        consecutiveFails = 0;
                        sent = reports.length;
                        return Promise.all(batch.map((b) => storage().delete(b.id)))
                            .then(() => ({ ok: true, sent, res: r.data }));
                    }
                    // 失败路径：分类退避
                    const code = r.data && r.data.code;
                    const retryAfter = (r.data && Number(r.data.retryAfter)) || 0;
                    if (code === 'E_RELAY_DISABLED') {
                        pause(DEFAULTS.pauseOnDisabledMs);
                    } else if (r.status === 429 || r.status === 503) {
                        pause(Math.max(retryAfter * 1000, DEFAULTS.pauseOn429Ms));
                    } else {
                        consecutiveFails++;
                        if (consecutiveFails >= DEFAULTS.maxConsecutiveFails) {
                            pause(DEFAULTS.pauseOnFailMs);
                            consecutiveFails = 0;
                        }
                    }
                    return { ok: false, status: r.status, code };
                });
            })
            .catch((e) => {
                consecutiveFails++;
                if (consecutiveFails >= DEFAULTS.maxConsecutiveFails) {
                    pause(DEFAULTS.pauseOnFailMs);
                    consecutiveFails = 0;
                }
                return { ok: false, error: String(e && e.message || e) };
            })
            .then((r) => { flushing = false; return r; })
            .catch(() => { flushing = false; return null; });
    }

    // ------------------------------------------------------------------
    // 读辅助：批量详情（300/批自动分片；任何失败 → null，宿主零回归）
    // ------------------------------------------------------------------
    function appsBatch(ids, cc) {
        if (!enabled()) return Promise.resolve(null);
        const uniq = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
        if (uniq.length === 0) return Promise.resolve({ apps: {}, missing: [] });
        const chunks = [];
        for (let i = 0; i < uniq.length; i += 300) chunks.push(uniq.slice(i, i + 300));
        return Promise.all(chunks.map((c) => relayRequest(
            `/apps/batch?ids=${c.join(',')}&cc=${encodeURIComponent(cc || 'CN')}`, 'GET')))
            .then((rs) => {
                const out = { apps: {}, missing: [] };
                for (const r of rs) {
                    if (r.status !== 200 || !r.data || !r.data.ok) return null;
                    Object.assign(out.apps, r.data.apps);
                    (r.data.missing || []).forEach((m) => out.missing.push(m));
                }
                return out;
            })
            .catch(() => null);
    }

    // ------------------------------------------------------------------
    // 配置 + 定时器
    // ------------------------------------------------------------------
    function configure(opts) {
        // ★ seal 可以为空：远程托管模式（HUB_AUTH_REQUIRE_STEAM=1）下服务端已关闭裸 seal
        //   激活通道（/auth/activate 直接回 E_STEAM_REQUIRED），此时唯一通道是
        //   SAAAuth.loginWithSteam() 换来的 Steam OpenID 会话。要求必须带 seal 等于
        //   把「只能登录」的部署方式挡在门外。pluginId 仍然是必需的（服务端按它查 kind 契约）。
        if (!opts || !opts.pluginId) return;
        cfg = Object.assign({}, DEFAULTS, {
            pluginId: String(opts.pluginId),
            pluginVer: String(opts.pluginVer || ''),
            baseUrl: String(opts.baseUrl || DEFAULTS.baseUrl),
            enabledFn: opts.enabledFn || null,
            storage: opts.storage || null,
            seal: opts.seal,
            // 个人域：默认关；只有显式 privacy:true 才上报（★不继承上次状态，避免「升级后自动开启」）
            privacy: opts.privacy === true,
            subjectFn: typeof opts.subjectFn === 'function' ? opts.subjectFn : null,
        });
        const A = auth();
        if (A && A.configure) {
            A.configure({ seal: cfg.seal, baseUrl: cfg.baseUrl });
        }
        // 恢复上次的退避状态（跨页保留；kill switch 期间不必反复试探）
        const savedPause = Number(GM.get(DEFAULTS.gmPrefix + 'paused_until', 0)) || 0;
        if (savedPause > Date.now()) pausedUntil = savedPause;
        if (timer) clearInterval(timer);
        timer = setInterval(() => { flushNow().catch(() => {}); }, DEFAULTS.flushIntervalMs);
        if (timer && typeof timer.unref === 'function') timer.unref();   // node/测试环境不挂进程；浏览器无此方法
        // 启动即协商一次 kind 契约（异步、失败无害）
        refreshKinds(true).catch(() => {});
    }

    // 退避状态跨页保留：kill switch / 429 期间不必每页反复试探
    function pause(ms) {
        pausedUntil = Date.now() + ms;
        GM.set(DEFAULTS.gmPrefix + 'paused_until', pausedUntil);
    }

    function state() {
        return {
            pending: storage && cfg ? storage().count().catch(() => 0) : 0,
            todayCount: todayCount(),
            pausedUntil,
            configured: !!cfg,
            privacy: !!(cfg && cfg.privacy),
            kinds: kindsCache ? kindsCache.kinds.length : 0,
        };
    }

    /**
     * 能力探测（宿主设置页 / 诊断卡用）：告诉用户「这个插件现在能上报什么、
     * 个人数据开关是开还是关、会话认到的是哪个账号」。
     */
    function capabilities() {
        const list = (kindsCache && kindsCache.kinds) || [];
        const personalKinds = list.filter((k) => k.dataClass === 'personal').map((k) => k.kind);
        return {
            version: VERSION,
            configured: !!cfg,
            enabled: enabled(),
            privacy: !!(cfg && cfg.privacy),
            subject: sessionSubject() || null,
            kinds: list.length,
            personalKinds,
            supportsPersonal: personalKinds.length > 0,
            pausedUntil,
        };
    }

    root.HubRelay = {
        configure, enqueue, flushNow, appsBatch, state, refreshKinds, capabilities,
        get pausedUntil() { return pausedUntil; },
        VERSION,
    };
})(typeof window !== 'undefined' ? window : this);
