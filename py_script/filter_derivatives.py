#!/usr/bin/env python3
"""
过滤 output_filtered.json 中的衍生内容（DLC、试用版、4K版、资产包、扩展包等）
仅保留原版游戏
"""
import json
import requests
import time
import urllib3
import re

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Steam API 查询单个 appid 的类型
def check_app_type(app_id):
    """通过 Steam API 查询 app 的类型"""
    url = f"https://store.steampowered.com/api/appdetails?appids={app_id}"
    try:
        response = requests.get(url, timeout=15, verify=False)
        response.raise_for_status()
        data = response.json()
        app_str = str(app_id)
        if app_str in data and data[app_str].get('success'):
            game_data = data[app_str]['data']
            return {
                'app_id': app_id,
                'type': game_data.get('type', 'unknown'),
                'name': game_data.get('name', 'N/A'),
                'is_free': game_data.get('is_free', False),
            }
        return {'app_id': app_id, 'type': 'unknown', 'name': 'N/A', 'is_free': False}
    except Exception as e:
        print(f"  API 查询失败 (ID: {app_id}): {e}")
        return {'app_id': app_id, 'type': 'error', 'name': 'N/A', 'is_free': False}

# 需要通过 API 验证的 appid 列表（不确定是否为衍生的）
ambiguous_appids = [
    4306710,  # 灭寇1939:上川往事-额外壁纸相框资源包
    4306700,  # 灭寇1939:上川往事 4K版
    2303601,  # Not For Broadcast: The Timeloop
    2303600,  # Not For Broadcast: Bits of Your Life
    2199310,  # Not For Broadcast: Live & Spooky
    1201400,  # Not For Broadcast: Prologue
    2257770,  # Not For Broadcast VR
    2303602,  # Not For Broadcast Season Pass
    3480210,  # 月亮三部曲 (Trilogy of the Moon) - 第一个
    3478200,  # 月亮三部曲 (Trilogy of the Moon) - 第二个（可能是重复/DLC）
    2774960,  # 我和七个俏房客 - 第一个
    2774830,  # 我和七个俏房客 - 第二个（可能是重复/DLC）
    1937520,  # 神都不良探 Underdog Detective-第6至17回
    2099930,  # 飞越13号房 - 下：反击篇
    2690730,  # TELEFORUM - Supporter Pack
    2802560,  # 完蛋！我被美女包围了！-房间里的心跳VR花絮
    2677810,  # Simon the Sorcerer Origins - "PONY" DLC
    3823920,  # Simon the Sorcerer Origins - History Artbook
    4161480,  # 你好！我们还有场恋爱没谈-番外篇
    3668590,  # 月亮三部曲 - 初缘 (Trilogy of the Moon DLC)
    1835020,  # BornWild • Versus S1 - Prologue
    3828820,  # Don't Stop, Girlypop! Lite
]

def main():
    print("=" * 60)
    print("Steam 衍生内容过滤脚本")
    print("=" * 60)
    
    # 读取原始数据
    input_file = "output/output_filtered.json"
    with open(input_file, 'r', encoding='utf-8') as f:
        games = json.load(f)
    
    print(f"\n原始数据: {len(games)} 条记录")
    
    # ======== 第一步: 通过 API 验证 ========
    print("\n" + "=" * 60)
    print("第一步: 通过 Steam API 验证不确定的 appid")
    print("=" * 60)
    
    api_results = {}
    for i, app_id in enumerate(ambiguous_appids):
        print(f"  [{i+1}/{len(ambiguous_appids)}] 查询 appid={app_id} ...")
        result = check_app_type(app_id)
        api_results[app_id] = result
        print(f"    -> type={result['type']}, name={result['name']}")
        time.sleep(0.3)  # 避免请求过快
    
    # 输出 API 验证结果
    print("\n--- API 验证结果汇总 ---")
    for app_id, info in api_results.items():
        marker = "[DLC]" if info['type'] == 'dlc' else "[GAME]" if info['type'] == 'game' else f"[{info['type'].upper()}]"
        print(f"  {marker} appid={app_id}: {info['name']}")
    
    # ======== 第二步: 基于名称模式 + API 结果标记衍生内容 ========
    print("\n" + "=" * 60)
    print("第二步: 识别所有衍生内容")
    print("=" * 60)
    
    # 名称中的衍生关键词模式
    derivative_patterns = [
        # 试用版/试玩版/体验版/Prologue/Lite
        (r'试用版', '试用版'),
        (r'试玩版', '试玩版'),
        (r'体验版', '体验版'),
        (r'\bPrologue\b', 'Prologue'),
        (r'\bLite\b', 'Lite版本'),
        # 4K/2K/8K/高清/超清版本
        (r'4K\s*版', '4K版'),
        (r'4K资产包', '4K资产包'),
        (r'4K\s*包', '4K资源包'),
        (r'2K\s*高清', '2K高清包'),
        (r'8K', '8K版'),
        (r'超清版', '超清版'),
        (r'-2K$', '2K版'),
        (r'-2K视频', '2K视频'),
        # 资产包/资源包/壁纸/相框/剧照/写真/花絮
        (r'资源包', '资源包'),
        (r'资产包', '资产包'),
        (r'壁纸.*相框', '壁纸相框包'),
        (r'Wallpaper\s*Pack', '壁纸包'),
        (r'Photobook', '写真集'),
        (r'剧照集', '剧照集'),
        (r'写真', '写真集'),
        (r'高清剧照', '高清剧照'),
        (r'高清主题PV.*高清人物写真', '高清主题+写真'),
        (r'画面风格包', '画面风格包'),
        (r'画质增强.*扩展包', '画质增强扩展包'),
        (r'心动影集', '影集'),
        (r'视频花絮集', '视频花絮集'),
        (r'原声音乐MV', '原声音乐MV'),
        (r'History\s*Artbook', '历史画册'),
        # DLC/拓展包/扩展包
        (r'\bDLC\b', 'DLC'),
        (r'拓展包', '拓展包'),
        (r'扩展包', '扩展包'),
        (r'服装和剧情拓展', '服装和剧情拓展'),
        (r'Behind\s*the\s*Scenes\s*DLC', '幕后DLC'),
        # Season Pass / Supporter Pack
        (r'Season\s*Pass', '季票'),
        (r'Supporter\s*Pack', '支持者包'),
        # VR版本 (只在有原版的情况下)
        (r'VR花絮', 'VR花絮'),
        # 番外篇
        (r'番外篇', '番外篇'),
    ]
    
    # 要移除的 appid 集合
    remove_appids = set()
    remove_reasons = {}  # appid -> 原因
    
    # 1. 通过名称模式识别
    for game in games:
        appid = game['appid']
        name = game['name']
        for pattern, reason in derivative_patterns:
            if re.search(pattern, name, re.IGNORECASE):
                remove_appids.add(appid)
                remove_reasons[appid] = f"名称匹配: {reason} (名称: {name})"
                break
    
    # 2. 通过 API 结果识别
    for app_id, info in api_results.items():
        if info['type'] == 'dlc':
            remove_appids.add(app_id)
            remove_reasons[app_id] = f"API验证: type=dlc (API名称: {info['name']})"
        elif info['type'] == 'demo':
            remove_appids.add(app_id)
            remove_reasons[app_id] = f"API验证: type=demo (API名称: {info['name']})"
        elif info['type'] == 'video':
            remove_appids.add(app_id)
            if app_id not in remove_reasons:
                remove_reasons[app_id] = f"API验证: type=video (API名称: {info['name']})"
    
    # 3. 特殊处理：重复条目（同名不同appid，保留较新/较主要的那个）
    # 月亮三部曲: 3480210 和 3478200 同名，检查API结果
    # 我和七个俏房客: 2774960 和 2774830 同名，检查API结果
    duplicate_pairs = [
        (3480210, 3478200, "月亮三部曲 (Trilogy of the Moon)"),
        (2774960, 2774830, "我和七个俏房客"),
    ]
    
    for appid1, appid2, name in duplicate_pairs:
        info1 = api_results.get(appid1, {})
        info2 = api_results.get(appid2, {})
        type1 = info1.get('type', 'unknown')
        type2 = info2.get('type', 'unknown')
        
        if type1 == 'dlc' and type2 != 'dlc':
            remove_appids.add(appid1)
            remove_reasons[appid1] = f"重复条目-DLC版本: {name} (type={type1})"
        elif type2 == 'dlc' and type1 != 'dlc':
            remove_appids.add(appid2)
            remove_reasons[appid2] = f"重复条目-DLC版本: {name} (type={type2})"
        elif type1 == type2:
            # 类型相同，保留第一个（序号较小的），移除第二个
            remove_appids.add(appid2)
            remove_reasons[appid2] = f"重复条目-保留前者: {name} (appid1={appid1} type={type1}, appid2={appid2} type={type2})"
    
    # 4. Not For Broadcast 系列特殊处理
    # 主游戏: 1147550 不予播出 ( Not For Broadcast )
    # 移除所有衍生: DLC, VR, Prologue, Season Pass, 支持者包
    nfb_main = 1147550
    nfb_derivatives = [2303602, 2303601, 2303600, 2199310, 1201400, 2257770]
    for did in nfb_derivatives:
        if did not in remove_appids:
            remove_appids.add(did)
            remove_reasons[did] = f"Not For Broadcast 系列衍生内容 (主游戏appid={nfb_main})"
    
    # ======== 第三步: 生成精简后的列表 ========
    print("\n" + "=" * 60)
    print("第三步: 生成精简后的列表")
    print("=" * 60)
    
    filtered_games = [g for g in games if g['appid'] not in remove_appids]
    
    # 按原序号重新编号
    for i, game in enumerate(filtered_games, 1):
        game['序号'] = i
    
    print(f"\n原始: {len(games)} 条")
    print(f"移除: {len(remove_appids)} 条")
    print(f"保留: {len(filtered_games)} 条")
    
    # 输出移除详情
    print("\n--- 移除的条目详情 ---")
    for game in games:
        if game['appid'] in remove_appids:
            reason = remove_reasons.get(game['appid'], '未知原因')
            print(f"  ✗ [{game['序号']:3d}] appid={game['appid']:>8} | {game['name']} | 原因: {reason}")
    
    # 输出保留的条目
    print(f"\n--- 保留的条目 ({len(filtered_games)} 条) ---")
    for game in filtered_games:
        print(f"  ✓ [{game['序号']:3d}] appid={game['appid']:>8} | {game['name']}")
    
    # 保存结果
    output_file = "output/output_filtered.json"
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(filtered_games, f, ensure_ascii=False, indent=2)
    print(f"\n精简后的文件已保存到: {output_file}")
    
    # 保存移除详情到日志文件
    log_file = "output/removed_entries.log"
    with open(log_file, 'w', encoding='utf-8') as f:
        f.write("移除的衍生内容详情\n")
        f.write("=" * 80 + "\n\n")
        for game in games:
            if game['appid'] in remove_appids:
                reason = remove_reasons.get(game['appid'], '未知原因')
                f.write(f"序号={game['序号']:3d} | appid={game['appid']:>8} | {game['name']}\n")
                f.write(f"  原因: {reason}\n\n")
        f.write(f"\n总计移除: {len(remove_appids)} 条\n")
        f.write(f"保留: {len(filtered_games)} 条\n")
    print(f"移除详情日志已保存到: {log_file}")
    
    # 保存 API 查询结果
    api_log = "output/api_check_results.json"
    with open(api_log, 'w', encoding='utf-8') as f:
        json.dump(api_results, f, ensure_ascii=False, indent=2)
    print(f"API 查询结果已保存到: {api_log}")

if __name__ == "__main__":
    main()
