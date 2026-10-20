// ==UserScript==
// @name         SGLV Plugin Host (Shared Library)
// @namespace    sglv-plugin-host
// @version      0.3.0
// @description  Steam 插件体系 host 库。提供 `__PLUGIN_HOST__` 全局：feature flag、降级路径、manifest 解析、跨插件 storage（IDB）、插件版本清单注册（registerPlugin）。
// @author       steam-workspace
// @license      MIT
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_info
// @run-at       document-start
// ==/UserScript==

// ============================================================================
// ⚠️ 这是**分发副本**（公开仓 SmallRob/steam-namespace），供 @require 走 CDN。
//    源文件：SmallRob/steam-userscripts（私有仓）shared/sglv-plugin-host.lib.js
//    同步流程：先改源文件并跑 `node shared/run-tests.js`，再覆盖本副本。
//    本副本头部横幅与源文件一致，勿单独手改（下次同步会被覆盖）。
//    版本契约：data/plugin-contract.json
// ============================================================================


/**
 * SGLV Plugin Host (Shared Library) · Phase 1 试点
 *
 * 职责：
 * 1. 提供 __PLUGIN_HOST__ 全局给宿主脚本用
 * 2. 解析 user.js 头部的 // @plugin-manifest 注释
 * 3. 提供 feature flag 控制整套系统开关
 * 4. 任何错误都不影响宿主脚本主流程（4 层防线）
 *
 * 设计约束：
 * - IIFE 风格，浏览器原生加载
 * - 零外部依赖（不引 npm 包）
 * - 内联 manifest 校验逻辑（与 @steam/plugin-manifest 保持规则一致）
 *
 * @see docs/plan/steam-plugin-blueprint.md Phase 1
 * @see docs/adr/0001-plugin-manifest-schema.md
 */

(function (env) {
  'use strict';

  // page：挂 __PLUGIN_HOST__、读 indexedDB（优先页面 unsafeWindow，宿主脚本才找得到）
  // gm*：油猴 / ScriptCat 沙箱里的 GM API。它们在脚本作用域，不在页面 window 上。
  var page = env.page;
  var gmInfo = env.gmInfo;
  var gmGet = env.gmGet;
  var gmSet = env.gmSet;

  function publish(value) {
    try { page.__PLUGIN_HOST__ = value; } catch (_) {}
    if (env.sandbox && env.sandbox !== page) {
      try { env.sandbox.__PLUGIN_HOST__ = value; } catch (_) {}
    }
  }

  // ============================================================
  // 第 1 层防线：feature flag
  // 默认开。任何脚本可以通过 GM_setValue 关闭：
  //   GM_setValue('__PLUGIN__system_enabled', false);
  // ============================================================
  var PLUGIN_SYSTEM_ENABLED = (function () {
    try {
      return typeof gmGet === 'function' ? gmGet('__PLUGIN__system_enabled', true) : true;
    } catch (_) {
      return true;
    }
  })();

  if (!PLUGIN_SYSTEM_ENABLED) {
    console.info('[SGLV Plugin Host] 已通过 feature flag 关闭');
    publish(null);
    return;
  }

  // ============================================================
  // 第 2 层防线：环境检测（缺 GM API 则整库跳过）
  // ============================================================
  if (!gmInfo || typeof gmGet !== 'function') {
    console.warn('[SGLV Plugin Host] 缺少 GM API，plugin 系统跳过');
    publish(null);
    return;
  }

  // ============================================================
  // 内联简化版 manifest 校验（与 @steam/plugin-manifest 保持规则一致）
  // 油猴侧不能引 npm 包，所以这里写一份精简版
  // TODO Phase 2：考虑把校验逻辑也独立成 universal 包
  // ============================================================
  var ID_RE = /^@?[a-z0-9-]+(\/[a-z0-9-]+)?$/;
  var VERSION_RE = /^\d+\.\d+\.\d+$/;
  var READ_VALUES = ['games', 'dlc', 'achievements', 'friends', 'reviews', 'wishlist', 'inventory', 'badges'];
  var WRITE_VALUES = ['games.notes', 'wishlist', 'collection', 'achievements.private', 'reviews.private'];
  var ACTION_VALUES = ['sendMessage', 'rateGame', 'requestRefund', 'joinGroup', 'createListing'];
  var EFFECT_VALUES = ['read:network', 'write:network', 'read:storage', 'write:storage', 'read:clipboard', 'write:clipboard', 'show:notification', 'open:window'];

  function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  function validateManifest(input) {
    // 第 3 层防线：解析失败不抛错，返回 null（降级为无声明）
    try {
      if (!isPlainObject(input)) return null;

      var id = input.id;
      var version = input.version;
      var displayName = input.displayName;
      var scope = input.scope;

      if (typeof id !== 'string' || !ID_RE.test(id)) return null;
      if (typeof version !== 'string' || !VERSION_RE.test(version)) return null;
      if (typeof displayName !== 'string' || displayName.length === 0) return null;
      if (!isPlainObject(scope)) return null;

      // entry 至少一项
      var entry = input.entry;
      if (!isPlainObject(entry)) return null;
      if (!entry.web && !entry.userscript && !entry.tauri) return null;

      return {
        id: id,
        version: version,
        displayName: displayName,
        scope: {
          read: Array.isArray(scope.read) ? scope.read.filter(function (r) { return READ_VALUES.indexOf(r) !== -1; }) : [],
          write: Array.isArray(scope.write) ? scope.write.filter(function (w) { return WRITE_VALUES.indexOf(w) !== -1; }) : [],
          action: Array.isArray(scope.action) ? scope.action.filter(function (a) { return ACTION_VALUES.indexOf(a) !== -1; }) : [],
        },
        effects: Array.isArray(input.effects) ? input.effects.filter(function (e) { return EFFECT_VALUES.indexOf(e) !== -1; }) : [],
        entry: entry,
        integrity: input.integrity,
        ui: input.ui,
        engine: input.engine,
      };
    } catch (e) {
      console.warn('[SGLV Plugin Host] manifest 校验异常', e);
      return null;
    }
  }

  // ============================================================
  // 解析 user.js 头部的 // @plugin-manifest 注释
  // 油猴会把 // @xxx 收成 script.metaBlocks，但 host 启动时也常在 document-start
  // 所以更稳的做法：从 GM_info.script 对象上读 @plugin-manifest 注释（如果有）
  // 退路：从当前脚本源码里用正则挖
  // ============================================================
  function parseManifestFromScript() {
    try {
      // 方式 1：从 GM_info.script 读（油猴会在 script 对象上暴露 metaBlocks）
      var metaBlocks = gmInfo && gmInfo.script && gmInfo.script.metaBlocks;
      if (Array.isArray(metaBlocks)) {
        for (var i = 0; i < metaBlocks.length; i++) {
          var block = metaBlocks[i];
          if (block && block.name === 'plugin-manifest' && typeof block.content === 'string') {
            return JSON.parse(block.content);
          }
        }
      }

      // 方式 2：从 GM_info.scriptHandler + 当前脚本（不通用，作为兜底）
      // Phase 1 不实现，留 TODO
      return null;
    } catch (e) {
      console.warn('[SGLV Plugin Host] manifest 解析失败', e);
      return null;
    }
  }

  // ============================================================
  // Policy Engine（油猴侧简化版，规则与 @steam/steamkit/policy 一致）
  // 不接受外部 override；任何 mode × kind × resource 的判断都在这里
  // ============================================================
  var DANGEROUS_ACTIONS = ['requestRefund', 'sendMessage', 'joinGroup', 'createListing', 'rateGame'];

  function evaluate(mode, manifest, action) {
    if (!manifest || !manifest.scope) return { allow: false, reason: 'invalid-manifest' };
    if (!action || !action.kind || !action.resource) return { allow: false, reason: 'invalid-action' };

    // 1. scope 覆盖检查
    var hasScope = false;
    if (action.kind === 'read') hasScope = manifest.scope.read.indexOf(action.resource) !== -1;
    else if (action.kind === 'write') hasScope = manifest.scope.write.indexOf(action.resource) !== -1;
    else if (action.kind === 'action') hasScope = manifest.scope.action.indexOf(action.resource) !== -1;
    if (!hasScope) return { allow: false, reason: 'scope-missing: ' + action.resource, code: 'scope-missing' };

    // 2. 危险 action：任何 mode 都 confirm
    if (action.kind === 'action' && DANGEROUS_ACTIONS.indexOf(action.resource) !== -1) {
      return { allow: 'confirm', reason: 'dangerous-action', prompt: '[' + manifest.id + '] 请求执行 ' + action.resource, code: 'confirm-required' };
    }

    // 3. 按 mode
    if (mode === 'strict') {
      if (action.kind === 'read') return { allow: true };
      return { allow: 'confirm', reason: 'strict-mode', prompt: 'strict 模式需要确认' };
    }
    if (mode === 'collaborative') {
      if (action.kind === 'read') return { allow: true };
      return { allow: 'confirm', reason: 'collaborative-mode', prompt: 'B 模式需要确认' };
    }
    if (mode === 'autonomous') return { allow: true };
    return { allow: false, reason: 'unknown-mode: ' + mode };
  }

  // ============================================================
  // Storage 层（基于 IndexedDB 共享命名空间）
  // 用途：让多个 user.js 共享数据（读共享，写各自）
  // key 约定：shared:<resource>  是公开共享；<plugin-id>:<key> 是私有
  // ============================================================
  var STORAGE_DB_NAME = 'sglv_plugin_host_storage';
  var STORAGE_STORE = 'kv';
  var STORAGE_VERSION = 1;
  var _idbDbPromise = null;  // 单例 db 连接

  function getIDB() {
    // 第 5 层防线：IDB 不可用（如 incognito + 旧浏览器）则 storage 整体禁用
    try {
      if (page && typeof page.indexedDB !== 'undefined') return page.indexedDB;
      if (env.sandbox && typeof env.sandbox.indexedDB !== 'undefined') return env.sandbox.indexedDB;
    } catch (_) {}
    return null;
  }

  function openDB() {
    if (_idbDbPromise) return _idbDbPromise;
    var idb = getIDB();
    if (!idb) {
      _idbDbPromise = Promise.resolve(null);
      return _idbDbPromise;
    }
    _idbDbPromise = new Promise(function (resolve) {
      try {
        var req = idb.open(STORAGE_DB_NAME, STORAGE_VERSION);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains(STORAGE_STORE)) {
            db.createObjectStore(STORAGE_STORE, { keyPath: 'key' });
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () {
          console.warn('[SGLV Plugin Host] IDB open 失败，storage 不可用', req.error);
          resolve(null);
        };
        req.onblocked = function () {
          console.warn('[SGLV Plugin Host] IDB 被阻塞（其他 tab 正在用旧版本）');
        };
      } catch (e) {
        console.warn('[SGLV Plugin Host] IDB open 异常', e);
        resolve(null);
      }
    });
    return _idbDbPromise;
  }

  function tx(db, mode) {
    if (!db) return null;
    try { return db.transaction(STORAGE_STORE, mode).objectStore(STORAGE_STORE); }
    catch (e) { console.warn('[SGLV Plugin Host] IDB tx 失败', e); return null; }
  }

  function reqToPromise(req) {
    return new Promise(function (resolve) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () {
        console.warn('[SGLV Plugin Host] IDB req 失败', req.error);
        resolve(null);
      };
    });
  }

  /**
   * 检查 entry 是否过期（按 ttl）
   */
  function isExpired(entry, now) {
    if (!entry || !entry.expiresAt) return false;
    return entry.expiresAt < (now || Date.now());
  }

  var storage = {
    isAvailable: function () { return getIDB() !== null; },

    /**
     * 读共享数据。返回 { value, updatedAt, ownerPluginId, expiresAt } | null
     * opts.maxAge: 仅当 updatedAt 在 maxAge 毫秒内才返回，否则 null
     */
    get: function (key, opts) {
      return openDB().then(function (db) {
        if (!db) return null;
        var store = tx(db, 'readonly');
        if (!store) return null;
        return reqToPromise(store.get(key)).then(function (entry) {
          if (!entry) return null;
          if (isExpired(entry)) return null;
          if (opts && opts.maxAge && (Date.now() - entry.updatedAt) > opts.maxAge) return null;
          return {
            value: entry.value,
            updatedAt: entry.updatedAt,
            ownerPluginId: entry.ownerPluginId,
            expiresAt: entry.expiresAt,
          };
        });
      });
    },

    has: function (key) {
      return openDB().then(function (db) {
        if (!db) return false;
        var store = tx(db, 'readonly');
        if (!store) return false;
        return reqToPromise(store.get(key)).then(function (entry) {
          return !!(entry && !isExpired(entry));
        });
      });
    },

    /**
     * 列出所有 key。pattern 是前缀，如 'shared:'
     */
    keys: function (pattern) {
      return openDB().then(function (db) {
        if (!db) return [];
        var store = tx(db, 'readonly');
        if (!store) return [];
        return reqToPromise(store.getAllKeys()).then(function (allKeys) {
          if (!pattern) return allKeys || [];
          return (allKeys || []).filter(function (k) { return typeof k === 'string' && k.indexOf(pattern) === 0; });
        });
      });
    },

    /**
     * 写数据。owner 默认为当前注册的 plugin id
     * opts.ttl: 过期时间（毫秒）
     */
    set: function (key, value, opts) {
      return openDB().then(function (db) {
        if (!db) return false;
        var store = tx(db, 'readwrite');
        if (!store) return false;
        var now = Date.now();
        var entry = {
          key: key,
          value: value,
          updatedAt: now,
          // owner 优先取显式传入（registerPlugin 路径），其次是 register() 声明的 spec
          ownerPluginId: (opts && opts.owner) || (registeredSpec && registeredSpec.id) || 'unknown',
        };
        if (opts && opts.ttl) entry.expiresAt = now + opts.ttl;
        return reqToPromise(store.put(entry)).then(function () { return true; });
      });
    },

    delete: function (key) {
      return openDB().then(function (db) {
        if (!db) return false;
        var store = tx(db, 'readwrite');
        if (!store) return false;
        return reqToPromise(store.delete(key)).then(function () { return true; });
      });
    },

    /** 仅删除自己 owner 的 key（防误删他人数据） */
    deleteOwn: function (key) {
      return this.get(key).then(function (entry) {
        var myId = (registeredSpec && registeredSpec.id) || 'unknown';
        if (!entry || entry.ownerPluginId !== myId) return false;
        return storage.delete(key);
      });
    },

    /** 清空所有自己 owner 的 key（仅写各自时不会影响 shared 共享） */
    clearOwn: function () {
      var myId = (registeredSpec && registeredSpec.id) || 'unknown';
      return this.keys().then(function (allKeys) {
        var ownKeys = allKeys.filter(function (k) { return k.indexOf(myId + ':') === 0; });
        return Promise.all(ownKeys.map(function (k) { return storage.delete(k); }));
      });
    },
  };

  // ============================================================
  // 暴露 __PLUGIN_HOST__
  // ============================================================
  var registeredSpec = null;  // 脚本通过 register() 显式提供的 spec

  var host = {
    version: '0.3.0',  // ⬆️ v0.3.0 加入 registerPlugin（版本清单注册）
    enabled: true,
    mode: 'collaborative',  // 默认模式
    policy: {
      evaluate: evaluate,
      isDangerous: function (action) { return DANGEROUS_ACTIONS.indexOf(action) !== -1; },
      DANGEROUS_ACTIONS: DANGEROUS_ACTIONS,
    },
    manifest: {
      parse: parseManifestFromScript,
      validate: validateManifest,
    },
    storage: storage,
    /**
     * 让脚本显式注册自己的 manifest spec。
     * 推荐用法：脚本 IIFE 顶部 `__PLUGIN_HOST__.register({ id, version, ... })`
     * 这样不依赖油猴 metaBlocks 扩展。
     * 第 4 层防线：注册失败不抛错，只 warn。
     */
    register: function (spec) {
      try {
        var validated = validateManifest(spec);
        if (validated) {
          registeredSpec = validated;
          console.info('[SGLV Plugin Host] 已注册 manifest: ' + validated.id + '@' + validated.version);
          return true;
        }
        console.warn('[SGLV Plugin Host] spec 校验失败，按无声明处理', spec);
        return false;
      } catch (e) {
        console.warn('[SGLV Plugin Host] register 异常', e);
        return false;
      }
    },
    getSpec: function () { return registeredSpec; },
    /**
     * 轻量清单注册 —— 只为「进插件清单 / 报版本号」，不做权限声明。
     *
     * 与 register(spec) 的分工：
     *   · register(spec)     权限声明入口（要 scope/entry，4 层防线语义）—— 别动
     *   · registerPlugin(…)  纯元数据，插件只需 6 行
     *
     * 写入位置：storage 的 `shared:plugin:<id>` 键（IndexedDB，同源共享）
     * 消费方：Steam AI Agent 的 getInstalledData / getInstalledPlugins 工具
     *
     * ⭐ version 默认自动取 `GM_info.script.version` —— 与脚本头部 @version 同源，
     *    **永不漂移**，插件不用手写版本号。
     */
    registerPlugin: function (info) {
      try {
        var id = info && info.id;
        // id 规则：小写字母/数字/连字符（与 ID_RE 同族但更宽松：允许 @ 前缀之外的形式）
        if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
          console.warn('[SGLV Plugin Host] registerPlugin: id 非法（需小写字母/数字/连字符）', id);
          return false;
        }
        // version：优先显式传，否则取脚本自己的 @version（GM_info.script.version）
        var v = String((info && info.version) || (gmInfo && gmInfo.script && gmInfo.script.version) || '').trim();
        if (!v) {
          console.warn('[SGLV Plugin Host] registerPlugin: 无法确定版本号（GM_info 不可用且未显式传 version）', id);
          return false;
        }
        var rec = {
          id: id,
          name: String((info && info.name) || id),
          family: String((info && info.family) || ''),
          version: v,
          versionSource: (info && info.version) ? 'spec' : 'GM_info',
          // 供消费方判断「该插件是否支持某个能力」的扩展位（如 registry 能力标记）
          capabilities: (info && info.capabilities) || null,
          ts: Date.now(),
        };
        storage.set('shared:plugin:' + id, rec, { owner: id });
        return true;
      } catch (e) {
        console.warn('[SGLV Plugin Host] registerPlugin 异常', e);
        return false;
      }
    },
    system: {
      disable: function () {
        try { if (typeof gmSet === 'function') gmSet('__PLUGIN__system_enabled', false); } catch (_) {}
        console.warn('[SGLV Plugin Host] 已禁用。刷新页面生效。');
      },
      enable: function () {
        try { if (typeof gmSet === 'function') gmSet('__PLUGIN__system_enabled', true); } catch (_) {}
        console.warn('[SGLV Plugin Host] 已启用。刷新页面生效。');
      },
    },
  };

  publish(host);

  // 启动期打印
  try {
    var v = gmInfo && gmInfo.script && gmInfo.script.version;
    console.info('%c[SGLV Plugin Host] v' + host.version + ' 已加载 (host script v' + v + ')', 'color:#2f6f5e;font-weight:bold');
    if (storage.isAvailable()) {
      console.info('%c[SGLV Plugin Host] storage 可用 (DB: ' + STORAGE_DB_NAME + ')', 'color:#7c7a72');
    } else {
      console.info('[SGLV Plugin Host] storage 不可用（无 indexedDB，shared 读共享将降级）');
    }
  } catch (_) {
    console.info('[SGLV Plugin Host] v' + host.version + ' 已加载');
  }

})(function () {
  // 非严格函数里的 this 是脚本沙箱全局。GM_* 挂在这里。
  // unsafeWindow 是页面 window，没有 GM API；以前把它当成唯一 global，检测会误判「缺少 GM API」。
  var sandbox = (function () { return this; })();
  var page = sandbox || {};
  if (typeof unsafeWindow !== 'undefined' && unsafeWindow) page = unsafeWindow;
  else if (typeof window !== 'undefined' && window) page = window;

  function fromScope(value, name) {
    if (value != null) return value;
    if (sandbox && sandbox[name] != null) return sandbox[name];
    if (page && page !== sandbox && page[name] != null) return page[name];
    return value;
  }

  return {
    page: page,
    sandbox: sandbox,
    gmInfo: fromScope(typeof GM_info !== 'undefined' ? GM_info : undefined, 'GM_info'),
    gmGet: fromScope(typeof GM_getValue === 'function' ? GM_getValue : undefined, 'GM_getValue'),
    gmSet: fromScope(typeof GM_setValue === 'function' ? GM_setValue : undefined, 'GM_setValue'),
  };
}());
