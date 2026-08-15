# -*- coding: utf-8 -*-
"""从 Steam 商店页面抓取横板封面(header_schinese.jpg 优先)并重新编号"""
import json
import os
import re
import time
import random

import requests

DATA_FILE = r"e:\WorkSpace\steam-namespace\data\steam_vediogame_selected.json"
BAK_FILE = r"e:\WorkSpace\steam-namespace\data\steam_vediogame_selected.bak.json"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

# 跳过年龄验证
COOKIES = {
    "birthtime": "568022401",
    "mature_content": "1",
    "wants_mature_content": "1",
    "lastagecheckage": "1-January-1988",
}

# header_schinese 优先(带 hash),其次 header(带 hash)
RE_SCHINESE = re.compile(
    r"https://shared\.fastly\.steamstatic\.com/store_item_assets/steam/apps/"
    r"\d+/[0-9a-f]{40,}/header_schinese\.jpg"
)
RE_HEADER = re.compile(
    r"https://shared\.fastly\.steamstatic\.com/store_item_assets/steam/apps/"
    r"\d+/[0-9a-f]{40,}/header\.jpg"
)
# 备用: 无 hash 域名(akamai/fastly) 的 header
RE_HEADER_ANY = re.compile(
    r"https://[^\s\"'<>\\]+?store_item_assets/steam/apps/\d+/[^\s\"'<>\\]*header\.jpg"
)
# 备用: 商店 API 返回的 header_image
API_URL = "https://store.steampowered.com/api/appdetails?appids={}&l=schinese&cc=cn"


def fetch_page(session, appid):
    """抓取商店页面, 返回页面文本; 失败返回 None"""
    url = f"https://store.steampowered.com/app/{appid}/"
    for attempt in range(3):
        try:
            r = session.get(url, timeout=20)
            if r.status_code == 200:
                return r.text
            if r.status_code == 429:
                time.sleep(5 * (attempt + 1))
                continue
            return None  # 404 等, 游戏可能已下架
        except requests.RequestException:
            time.sleep(3 * (attempt + 1))
    return None


def fetch_header_via_api(session, appid):
    """备用: 通过 appdetails API 获取 header_image"""
    try:
        r = session.get(API_URL.format(appid), timeout=15)
        if r.status_code != 200:
            return None
        data = r.json()
        app = data.get(str(appid), {})
        if app.get("success"):
            return app["data"].get("header_image")
    except (requests.RequestException, ValueError, KeyError):
        pass
    return None


def get_poster(session, appid, old_poster):
    """获取横板封面 URL, 失败时回退旧 poster"""
    page = fetch_page(session, appid)
    if page:
        m = RE_SCHINESE.search(page)
        if m:
            return m.group(0)
        m = RE_HEADER.search(page)
        if m:
            return m.group(0)
        # 无 hash 的 header
        m = RE_HEADER_ANY.search(page)
        if m:
            return m.group(0).rstrip(",")
    # 页面失败或没有 header, 尝试 API
    api_poster = fetch_header_via_api(session, appid)
    if api_poster:
        return api_poster
    return old_poster or ""


def main():
    with open(DATA_FILE, encoding="utf-8") as f:
        data = json.load(f)

    # 备份原文件
    if not os.path.exists(BAK_FILE):
        with open(BAK_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print("已备份原文件 ->", BAK_FILE)

    session = requests.Session()
    session.headers.update(HEADERS)
    session.cookies.update(COOKIES)

    updated = 0
    failed = []
    total = len(data)
    for idx, item in enumerate(data, 1):
        appid = item["appid"]
        old_poster = item.get("poster", "")
        new_poster = get_poster(session, appid, old_poster)
        if new_poster != old_poster:
            item["poster"] = new_poster
            updated += 1
        if not new_poster:
            failed.append(appid)
        # 重新编号
        item["序号"] = idx
        if idx % 25 == 0 or idx == total:
            print(f"进度 {idx}/{total}, 已更新 {updated}, 待补 {len(failed)}")
        time.sleep(random.uniform(0.8, 1.6))  # 限流保护

    # 保证字段顺序: 序号, date, appid, name, poster
    ordered = []
    for item in data:
        ordered.append({
            "序号": item["序号"],
            "date": item["date"],
            "appid": item["appid"],
            "name": item["name"],
            "poster": item["poster"],
        })

    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(ordered, f, ensure_ascii=False, indent=2)

    empty = sum(1 for x in ordered if not x["poster"])
    print(f"\n完成: 共 {total} 条, 更新 poster {updated} 条, 仍为空 {empty} 条")
    if failed:
        print("未获取到封面的 appid:", failed)


if __name__ == "__main__":
    main()
