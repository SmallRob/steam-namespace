/* =====================================================================
 * Steam AI Agent —— 默认凭据客户端（saa-auth.lib.js）
 * =====================================================================
 * 职责：让插件"开箱即用"地带上一个默认 token，同时**不把明文 token 放进发布包**。
 *
 * 【协议分工】
 *   客户端只做三件事：
 *     ① 搬运一段不透明密文（构建期由发布机密封，客户端不解密、也无法解密）
 *     ② 生成并保管一把设备私钥（ECDSA P-256，存在 IndexedDB，不外传）
 *     ③ 每次请求用设备私钥签名（防 token 被抄走后盗用）
 *   服务端做三件事：
 *     ① 验签 → 解密 → 校验作用域 → 绑定设备 → 签发短期会话
 *     ② refresh 一次性轮换，旧 token 被复用 = 盗用 → 整条会话吊销
 *     ③ 解密出的默认 token **永不回传客户端**
 *
 * 【客户端不会做的事】
 *   · 不会把 token 明文写进任何存储
 *   · 不会在没有服务端配合的情况下"本地生成"可用凭据
 *   · 不会把密文里的东西当配置项暴露给用户
 *
 * 导出 API（window.SAAAuth）：
 *   configure(opts)   注入默认凭据 {seal, baseUrl, subject?}
 *   ensureSession()   有有效会话直接返回，否则走「挑战码 → 激活」握手
 *   request(path, o)  带会话 + 设备签名发起请求（自动 401 刷新重试一次）
 *   getState()        {status, deviceId, scopes, expiresAt}
 *   logout()          清会话（设备密钥保留）
 *   VERSION           库版本
 *
 * 依赖：宿主提供 GM_xmlhttpRequest / GM_getValue / GM_setValue（缺失时降级到 fetch / localStorage）。
 * ===================================================================== */
(function (root) {
    'use strict';

    const VERSION = '1.1.0';
    const STORE_KEY = 'saa_auth_state_v1';       // GM 存储：会话 + installId
    const IDB_NAME = 'saa-auth';
    const IDB_STORE = 'keys';

    const DEFAULTS = {
        baseUrl: '',                 // 服务端地址（https://…）
        accessTtlMs: 60 * 1000,      // 提前 60s 认为会话过期（服务端 TTL 15min）
        requestTimeoutMs: 30000,
        maxRetry: 1,
    };

    let cfg = Object.assign({}, DEFAULTS);
    let cred = null;                // {seal, baseUrl, subject, attest}
    let device = null;              // {privateKey, publicJwk, jkt}
    let state = null;               // 持久化状态
    let activating = null;          // 并发去重
    let policyCache = null;         // /auth/policy 快照 { at, data }

    // ---------------------------------------------------------------------
    // 基础工具
    // ---------------------------------------------------------------------
    function b64u(bytes) {
        let s = '';
        const arr = new Uint8Array(bytes);
        for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function unb64u(str) {
        const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
        const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
        const bin = atob(s + pad);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function utf8(str) {
        return new TextEncoder().encode(str);
    }

    function hex(buf) {
        const arr = new Uint8Array(buf);
        let s = '';
        for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, '0');
        return s;
    }

    async function sha256hex(data) {
        const buf = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? utf8(data) : data);
        return hex(buf);
    }

    /**
     * 统一读 GM / localStorage。
     * ⚠️ 各脚本管理器对「对象值」的序列化行为不一致（有的回对象、有的回 JSON 字符串），
     *    所以这里统一按 JSON 字符串存取，读的时候两种都兼容。
     */
    function gmGet(key, fallback) {
        let v;
        try {
            if (typeof GM_getValue === 'function') v = GM_getValue(key, undefined);
        } catch (e) { /* ignore */ }
        if (v === undefined || v === null) {
            try {
                const raw = localStorage.getItem(key);
                v = raw == null ? undefined : raw;
            } catch (e) { /* ignore */ }
        }
        if (v === undefined || v === null) return fallback;
        if (typeof v === 'string') {
            try { return JSON.parse(v); } catch (e) { return v; }
        }
        return v;
    }

    function gmSet(key, value) {
        const payload = (typeof value === 'string') ? value : JSON.stringify(value);
        try {
            if (typeof GM_setValue === 'function') { GM_setValue(key, payload); return true; }
        } catch (e) { /* ignore */ }
        try { localStorage.setItem(key, payload); return true; } catch (e) { /* ignore */ }
        return false;
    }

    function gmDel(key) {
        try { if (typeof GM_setValue === 'function') { GM_setValue(key, undefined); return; } } catch (e) { /* ignore */ }
        try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
    }

    function randomId() {
        if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        const a = new Uint8Array(16);
        crypto.getRandomValues(a);
        return hex(a);
    }

    // ---------------------------------------------------------------------
    // 设备密钥（ECDSA P-256）
    // ---------------------------------------------------------------------
    function openIdb() {
        return new Promise((resolve) => {
            try {
                const req = indexedDB.open(IDB_NAME, 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
            } catch (e) { resolve(null); }
        });
    }

    function idbGet(db, key) {
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const req = tx.objectStore(IDB_STORE).get(key);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            } catch (e) { resolve(null); }
        });
    }

    function idbPut(db, key, value) {
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).put(value, key);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
            } catch (e) { resolve(false); }
        });
    }

    /** 生成设备密钥对（extractable 决定私钥能否导出） */
    async function generateDeviceKey(extractable) {
        const pair = await crypto.subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-256' },
            extractable,
            ['sign', 'verify'],
        );
        const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
        return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicJwk, jkt: await thumbprint(publicJwk) };
    }

    /**
     * 取设备密钥对。
     * 优先 IndexedDB（私钥**不可导出**，最安全）；
     * IndexedDB 不可用时降级到 GM 存储 —— 此时私钥必须可导出才能存下来。
     */
    async function ensureDevice() {
        if (device) return device;
        const db = await openIdb();
        if (db) {
            const stored = await idbGet(db, 'device');
            if (stored && stored.privateKey && stored.publicJwk) {
                device = stored;
                return device;
            }
            device = await generateDeviceKey(false);   // 不可导出
            await idbPut(db, 'device', device);
            return device;
        }
        // ---- 降级：GM 存储（存可导出的 JWK）----
        const saved = gmGet('saa_auth_device_jwk_v1', null);
        if (saved && saved.privateJwk && saved.publicJwk) {
            try {
                const priv = await crypto.subtle.importKey(
                    'jwk', saved.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
                );
                const pub = await crypto.subtle.importKey(
                    'jwk', saved.publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
                );
                device = { privateKey: priv, publicKey: pub, publicJwk: saved.publicJwk, jkt: await thumbprint(saved.publicJwk) };
                return device;
            } catch (e) { /* 存坏了就重新生成 */ }
        }
        device = await generateDeviceKey(true);        // 可导出（才能落 GM 存储）
        try {
            const privateJwk = await crypto.subtle.exportKey('jwk', device.privateKey);
            gmSet('saa_auth_device_jwk_v1', { publicJwk: device.publicJwk, privateJwk });
        } catch (e) { /* ignore */ }
        return device;
    }

    /** JWK 指纹：必须与服务端 crypto.js 的 jwkThumbprint 逐字节一致 */
    async function thumbprint(jwk) {
        const canonical = JSON.stringify({ crv: jwk.crv || '', kty: jwk.kty || '', x: jwk.x || '', y: jwk.y || '' });
        const buf = await crypto.subtle.digest('SHA-256', utf8(canonical));
        return b64u(buf);
    }

    /** 设备签名（WebCrypto 的 ECDSA 输出是裸 r||s，与服务端 ieee-p1363 对齐） */
    async function signData(data) {
        const d = await ensureDevice();
        const sig = await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            d.privateKey,
            utf8(data),
        );
        return b64u(sig);
    }

    // ---------------------------------------------------------------------
    // 签名载荷（与服务端 service.js 逐字节一致）
    // ---------------------------------------------------------------------
    function proofData(ctx, nonce, installId, jkt, subject) {
        return `SAA-PROOF-V1\n${ctx}\n${nonce}\n${installId || ''}\n${jkt}\n${subject || ''}`;
    }

    function requestSigData(method, path, ts, bodyHash) {
        return `SAA-REQ-V1\n${String(method || '').toUpperCase()}\n${path}\n${ts}\n${bodyHash}`;
    }

    /**
     * 路径归一化 —— 签名用的 path 必须与**实际发出去的那一串**逐字节相同。
     * ---------------------------------------------------------------------
     * 设备签名覆盖 `SAA-REQ-V1\n<METHOD>\n<path+query>\n<ts>\n<sha256(body)>`，
     * 服务端按**收到的** path+query 验签（server.js: p + u.search）。
     * 而浏览器 / GM_xmlhttpRequest 会把非 ASCII（中文）与空格百分号编码后才发出，
     * 于是「按原始中文串签名、按编码串验签」必然对不上 → E_DEVICE_SIG / 401。
     * （2026-10-21 在隔离测试库上用 /search?q=艾尔登 复现。）
     *
     * ⚠️ 不能直接用 encodeURI：它会把已有的 %XX 再编成 %25（双重编码），
     *    而插件侧（pcHubRequest）传进来的路径**已经**是 URLSearchParams 编好的。
     *    所以这里只编码「非法/非 ASCII 字符」，% 与 URL 保留字符一律原样保留。
     */
    function normalizePath(p) {
        return String(p == null ? '' : p).replace(
            /[^A-Za-z0-9\-._~!$&'()*+,;=:@/?%[\]]/g,
            (ch) => encodeURIComponent(ch)
        );
    }

    // ---------------------------------------------------------------------
    // 传输
    // ---------------------------------------------------------------------
    function httpRequest(method, path, { body, headers } = {}) {
        const url = String(cfg.baseUrl).replace(/\/+$/, '') + path;
        const h = Object.assign({ 'Content-Type': 'application/json' }, headers || {});

        if (typeof GM_xmlhttpRequest === 'function') {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method,
                    url,
                    headers: h,
                    data: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
                    timeout: cfg.requestTimeoutMs,
                    onload: (r) => {
                        let data = null;
                        try { data = JSON.parse(r.responseText); } catch (e) { data = { raw: r.responseText }; }
                        resolve({ status: r.status, data });
                    },
                    onerror: () => reject(new Error('网络错误')),
                    ontimeout: () => reject(new Error('请求超时')),
                });
            });
        }
        return fetch(url, {
            method,
            headers: h,
            body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        }).then(async (res) => {
            let data = null;
            try { data = await res.json(); } catch (e) { data = null; }
            return { status: res.status, data };
        });
    }

    // ---------------------------------------------------------------------
    // 状态
    // ---------------------------------------------------------------------
    function loadState() {
        if (state) return state;
        state = gmGet(STORE_KEY, null) || {
            installId: randomId(),
            deviceId: null,
            accessToken: null,
            refreshToken: null,
            expiresAt: 0,
            refreshExpiresAt: 0,
            scopes: [],
            subject: '',
        };
        return state;
    }

    function saveState() {
        gmSet(STORE_KEY, state);
    }

    function accessValid() {
        const s = loadState();
        return !!s.accessToken && s.expiresAt - cfg.accessTtlMs > Date.now();
    }

    function refreshValid() {
        const s = loadState();
        return !!s.refreshToken && s.refreshExpiresAt > Date.now();
    }

    // ---------------------------------------------------------------------
    // 握手
    // ---------------------------------------------------------------------
    async function doChallenge() {
        const r = await httpRequest('POST', '/auth/challenge', { body: {} });
        if (!r.data || !r.data.nonce) throw new Error('挑战码获取失败：' + JSON.stringify(r.data || {}));
        return r.data.nonce;
    }

    async function activate(opts = {}) {
        if (!cred) throw new Error('未调用 configure');
        const attest = opts.attest || cred.attest || null;
        const seal = opts.seal || cred.seal || '';
        // 两条合法凭据路径：签发的 seal（自建/发布机），或登录态自证 attest（远程托管）
        if (!seal && !attest) throw new Error('未配置凭据：需要 seal，或 attest（登录态自证）');
        if (activating) return activating;
        activating = (async () => {
            const s = loadState();
            const d = await ensureDevice();
            // 主体优先级：attest.steamid（自证里声明的那一个，服务端会校验一致）
            //   > 显式配置的 cred.subject > 已保存的会话主体
            const subject = String((attest && attest.steamid) || cred.subject || s.subject || '');
            const nonce = await doChallenge();
            const proof = await signData(proofData('activate', nonce, s.installId, d.jkt, subject));
            const body = {
                installId: s.installId,
                deviceJwk: d.publicJwk,
                nonce,
                proof,
                subject,
            };
            if (seal) body.seal = seal;
            if (attest) body.attest = attest;
            const r = await httpRequest('POST', '/auth/activate', { body });
            if (r.status !== 200 || !r.data || !r.data.ok) {
                throw new Error('激活失败：' + ((r.data && (r.data.message || r.data.error)) || r.status));
            }
            s.deviceId = r.data.deviceId;
            s.accessToken = r.data.accessToken;
            s.refreshToken = r.data.refreshToken;
            s.expiresAt = r.data.expiresAt || 0;
            s.refreshExpiresAt = r.data.refreshExpiresAt || 0;
            s.scopes = r.data.scopes || [];
            s.subject = r.data.subject || subject || '';
            s.subjectSource = r.data.subjectSource || (attest ? 'attested' : '');
            s.subjectVerified = r.data.subjectVerified == null ? 0 : Number(r.data.subjectVerified) || 0;
            saveState();
            return s;
        })();
        try {
            return await activating;
        } finally {
            activating = null;
        }
    }

    async function doRefresh() {
        const s = loadState();
        if (!refreshValid()) throw new Error('刷新令牌已失效，需要重新激活');
        const d = await ensureDevice();
        const nonce = await doChallenge();
        const proof = await signData(proofData('refresh', nonce, s.installId, d.jkt, s.subject || ''));
        const r = await httpRequest('POST', '/auth/refresh', {
            body: {
                refreshToken: s.refreshToken,
                deviceJwk: d.publicJwk,
                nonce,
                proof,
                installId: s.installId,
                subject: s.subject || '',
            },
        });
        if (r.status !== 200 || !r.data || !r.data.ok) {
            // 刷新失败（多半是 refresh 被判定重放）→ 丢掉会话，等下次重新激活
            s.accessToken = null; s.refreshToken = null; s.expiresAt = 0;
            saveState();
            throw new Error('刷新失败：' + ((r.data && (r.data.message || r.data.error)) || r.status));
        }
        s.accessToken = r.data.accessToken;
        s.refreshToken = r.data.refreshToken;
        s.expiresAt = r.data.expiresAt || 0;
        s.refreshExpiresAt = r.data.refreshExpiresAt || 0;
        saveState();
        return s;
    }

    /** 保证有可用会话（过期则刷新，无 refresh 则激活/要求登录） */
    async function ensureSession() {
        if (accessValid()) return loadState();
        if (refreshValid()) {
            try { return await doRefresh(); } catch (e) { /* 落到重新激活 */ }
        }
        // 有 seal → 公开封装凭据激活；有 attest → 登录态自证激活（远程托管免登录）
        if (cred && (cred.seal || cred.attest)) return activate();
        throw new Error('NEEDS_STEAM_LOGIN');
    }

    // ---------------------------------------------------------------------
    // 策略探测 + 登录态自证
    // ---------------------------------------------------------------------
    /**
     * 服务端认证策略快照（GET /auth/policy，公开无鉴权），缓存 10 分钟。
     * 宿主据此决定：subjectTrust='attested' 就不必弹 Steam 登录，直接用当前
     * 页面登录态激活；'steam' 才需要走 loginWithSteam。
     * 失败回 null（调用方按「需要登录」处理，绝不因为探测失败就放行）。
     */
    async function probePolicy(force) {
        const now = Date.now();
        if (!force && policyCache && (now - policyCache.at) < 10 * 60 * 1000) return policyCache.data;
        try {
            const r = await httpRequest('GET', '/auth/policy');
            if (r.status !== 200 || !r.data || r.data.ok !== true) return policyCache ? policyCache.data : null;
            policyCache = { at: now, data: r.data };
            return r.data;
        } catch (e) {
            return policyCache ? policyCache.data : null;
        }
    }

    /**
     * 用「当前页面登录态」的 steamid 构造 attest（服务端校验结构 + 时间窗）。
     * 判据：steamid 必须来自**登录后才有**的页面变量 / cookie。
     *   · 'steam-page-ssr' —— 页面里的 g_steamID（未登录页面没有）
     *   · 'steam-cookie'   —— steamLoginSecure cookie（HttpOnly 时读不到，回退用前者）
     *   · 'community-my'   —— 请求 /my/profile 后从 HTML 里解析
     * ★ 这不是密码学证明：服务端只把它当「声明 + 一致性检查」。真正的隔离仍靠
     *   服务端把 subject 钉在设备上（一设备一账号）+ 个人域 A 档。
     */
    function buildAttest(steamid, opts = {}) {
        const sid = String(steamid || '').trim();
        if (!/^\d{17}$/.test(sid)) return null;
        let host = String(opts.host || '');
        if (!host) {
            try { host = String(root.location && root.location.hostname || ''); } catch (e) { host = ''; }
        }
        return {
            via: String(opts.via || 'steam-page-ssr'),
            host,
            steamid: sid,
            capturedAt: Number(opts.capturedAt) || Date.now(),
        };
    }

    /**
     * 一步到位：探测策略 → 需要就用手上的 steamid 生成 attest 并激活。
     * @returns {Promise<{ok:boolean, needLogin?:boolean, reason?:string, subject?:string, subjectVerified?:number}>}
     */
    async function ensureSessionWithSteamId(steamid) {
        const sid = String(steamid || '').trim();
        // 已有可用会话 → 直接复用。hub-relay 每轮冲刷前都会调这个钩子，
        // 不做早退的话会变成「每 30 秒重新激活一次」，纯浪费配额。
        if (accessValid()) {
            const s = loadState();
            return {
                ok: true, subject: s.subject || '', subjectVerified: Number(s.subjectVerified) || 0,
                source: s.subjectSource || '', reused: true,
            };
        }
        const pol = await probePolicy();
        const trust = pol && pol.subjectTrust === 'attested' ? 'attested' : 'steam';
        if (trust !== 'attested') {
            return { ok: false, needLogin: true, reason: '服务端要求 Steam OpenID 登录（subjectTrust=steam）' };
        }
        if (!/^\d{17}$/.test(sid)) {
            return { ok: false, needLogin: true, reason: '未取到当前 Steam 登录态（页面无 g_steamID）' };
        }
        const attest = buildAttest(sid);
        if (!attest) return { ok: false, needLogin: true, reason: 'attest 构造失败' };
        // 把 attest 交给 activate；重试时 capturedAt 会更新（时间窗 15min 足够）
        try {
            const s = await activate({ attest });
            return {
                ok: true,
                subject: s.subject,
                subjectVerified: Number(s.subjectVerified) || 0,
                source: s.subjectSource || attest.via,
            };
        } catch (e) {
            return { ok: false, needLogin: false, reason: e.message || String(e) };
        }
    }

    // ---------------------------------------------------------------------
    // 请求
    // ---------------------------------------------------------------------
    /**
     * 带会话 + 设备签名发起请求
     * @param {string} path  以 / 开头
     * @param {object} opts  {method, body, headers}
     */
    async function request(path, opts = {}) {
        const method = (opts.method || 'GET').toUpperCase();
        const rawBody = opts.body == null ? '' : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
        // ★ 签名与发送必须用同一个字符串：先归一化（中文/空格 → 百分号编码），
        //   否则「按原始串签名、按编码串验签」必然对不上（见 normalizePath 注释）。
        const reqPath = normalizePath(path);
        let lastErr = null;

        for (let attempt = 0; attempt <= cfg.maxRetry; attempt++) {
            const s = await ensureSession();
            const ts = Date.now();
            const bodyHash = await sha256hex(rawBody);
            const sig = await signData(requestSigData(method, reqPath, ts, bodyHash));
            const headers = Object.assign({}, opts.headers || {}, {
                'Authorization': 'Bearer ' + s.accessToken,
                'X-Device-Ts': String(ts),
                'X-Device-Sig': sig,
            });
            let res;
            try {
                res = await httpRequest(method, reqPath, { body: opts.body == null ? null : rawBody, headers });
            } catch (e) {
                lastErr = e;
                if (attempt < cfg.maxRetry) continue;
                throw e;
            }
            if (res.status === 401 && attempt < cfg.maxRetry) {
                // 会话失效 → 强制刷新后重试一次
                const st = loadState();
                st.expiresAt = 0;
                saveState();
                lastErr = new Error('未授权');
                continue;
            }
            return res;
        }
        throw lastErr || new Error('请求失败');
    }

    // ---------------------------------------------------------------------
    // 对外 API
    // ---------------------------------------------------------------------

    /**
     * 远程托管：Steam OpenID 认证 → 换会话
     *
     * 流程（弹窗 + 轮询，不用 postMessage，避免跨域面）：
     *   ① POST /auth/steam/start        → {ticket, url}
     *   ② window.open(url) 打开 Steam 登录页，用户登录后 Steam 302 回你的回调
     *   ③ 轮询 GET /auth/steam/poll?ticket=… → {status:'ready', grant, steamid}
     *   ④ POST /auth/steam/exchange      → 会话（+ 可选 userKey）
     *
     * @param {object} opts { pollIntervalMs, timeoutMs, onStatus }
     */
    async function loginWithSteam(opts = {}) {
        if (!cred || !cred.baseUrl) throw new Error('未配置 baseUrl');
        const pollInterval = opts.pollIntervalMs || 1500;
        const timeout = opts.timeoutMs || 180000;
        const s = loadState();
        const d = await ensureDevice();

        const start = await httpRequest('POST', '/auth/steam/start', {
            body: { installId: s.installId, deviceJwk: d.publicJwk },
        });
        if (!start.data || !start.data.ok || !start.data.ticket) {
            throw new Error('发起 Steam 认证失败：' + JSON.stringify(start.data || {}));
        }
        const ticket = start.data.ticket;
        if (opts.onStatus) opts.onStatus('waiting-steam');

        const popup = (typeof window !== 'undefined' && window.open)
            ? window.open(start.data.url, 'saa-steam-login', 'width=520,height=680')
            : null;
        if (!popup) throw new Error('弹窗被拦截：请允许本插件弹出窗口后重试');

        // 轮询授权码
        const deadline = Date.now() + timeout;
        let ready = null;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, pollInterval));
            let poll;
            try {
                poll = await httpRequest('GET', `/auth/steam/poll?ticket=${encodeURIComponent(ticket)}`, {});
            } catch (e) { continue; }
            if (!poll.data) continue;
            if (poll.data.status === 'ready' && poll.data.grant) { ready = poll.data; break; }
            if (poll.data.status === 'exchanged') break;
        }
        try { popup.close(); } catch (e) { /* ignore */ }
        if (!ready) throw new Error('Steam 认证超时或未完成');

        if (opts.onStatus) opts.onStatus('exchanging');

        // 设备持有证明：绑定 ticket + installId + steamid
        const proof = await signData(proofData('steam', ticket, s.installId, d.jkt, ready.steamid || ''));
        const ex = await httpRequest('POST', '/auth/steam/exchange', {
            body: {
                grant: ready.grant,
                installId: s.installId,
                deviceJwk: d.publicJwk,
                proof,
            },
        });
        if (!ex.data || !ex.data.ok) {
            throw new Error('兑换会话失败：' + ((ex.data && (ex.data.message || ex.data.error)) || ex.status));
        }
        s.deviceId = ex.data.deviceId;
        s.accessToken = ex.data.accessToken;
        s.refreshToken = ex.data.refreshToken;
        s.expiresAt = ex.data.expiresAt || 0;
        s.refreshExpiresAt = ex.data.refreshExpiresAt || 0;
        s.scopes = ex.data.scopes || [];
        s.subject = ex.data.subject || ready.steamid || '';
        s.userKey = ex.data.userKey || null;      // 服务端派生的每用户 key（非真实 rtoken）
        saveState();
        if (opts.onStatus) opts.onStatus('ready');
        return { ok: true, steamid: s.subject, scopes: s.scopes, hasUserKey: !!s.userKey };
    }

    /** 读 Steam 页面登录态里的 steamid64（steamLoginSecure 的第一段） */
    function readSteamIdFromCookie() {
        try {
            const m = /(?:^|;\s*)steamLoginSecure=([^;]+)/.exec(document.cookie || '');
            if (!m) return '';
            const dec = decodeURIComponent(m[1]);
            const id = dec.split('||')[0];
            return /^\d{17}$/.test(id) ? id : '';
        } catch (e) { return ''; }
    }

    function configure(opts = {}) {
        // ★ 合并语义，不是替换：多个库（如 hub-relay）会各自调 configure 补自己的
        //   baseUrl，如果这里是「整体覆盖」，后调用的那个会把前一个配好的 attest
        //   或 seal 清掉 —— 表现为「明明配了却一直走未登录分支」，极难排查。
        const prev = cred || {};
        cred = {
            seal: opts.seal !== undefined ? String(opts.seal || '') : String(prev.seal || ''),
            baseUrl: String(opts.baseUrl || prev.baseUrl || cfg.baseUrl || ''),
            subject: opts.subject !== undefined ? String(opts.subject || '') : String(prev.subject || ''),
            // 登录态自证（可选）：传了就代表「本插件用登录态替身份」，不再需要 seal
            attest: opts.attest !== undefined
                ? ((opts.attest && typeof opts.attest === 'object') ? opts.attest : null)
                : (prev.attest || null),
        };
        if (opts.baseUrl) cfg.baseUrl = String(opts.baseUrl);
        if (opts.accessTtlMs) cfg.accessTtlMs = Number(opts.accessTtlMs) || cfg.accessTtlMs;
        return { ok: true, hasSeal: !!cred.seal, hasAttest: !!cred.attest, baseUrl: cfg.baseUrl };
    }

    function getState() {
        const s = loadState();
        return {
            status: s.accessToken ? (accessValid() ? 'ready' : 'stale') : 'idle',
            deviceId: s.deviceId,
            scopes: s.scopes || [],
            subject: s.subject || '',
            subjectSource: s.subjectSource || '',
            subjectVerified: Number(s.subjectVerified) || 0,
            expiresAt: s.expiresAt || 0,
            baseUrl: cfg.baseUrl,
            hasSeal: !!(cred && cred.seal),
            hasAttest: !!(cred && cred.attest),
        };
    }

    function logout() {
        const s = loadState();
        s.accessToken = null; s.refreshToken = null; s.expiresAt = 0; s.refreshExpiresAt = 0;
        saveState();
    }

    const API = {
        VERSION,
        configure,
        ensureSession,
        ensureSessionWithSteamId,
        probePolicy,
        buildAttest,
        activate,
        refresh: doRefresh,
        request,
        getState,
        logout,
        loginWithSteam,
        readSteamIdFromCookie,
    };

    root.SAAAuth = API;
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
