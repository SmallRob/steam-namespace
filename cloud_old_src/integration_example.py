#!/usr/bin/env python3
"""
Steam数据集成示例
结合现有的steam-namespace项目和新的用户数据API
"""

import json
import sys
import os
from pathlib import Path
from datetime import datetime
from dataclasses import asdict

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from steam_user_api import SteamUserAPI


def load_config(config_file: str = "steam_config.json") -> dict:
    """加载配置文件"""
    try:
        with open(config_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"配置文件 {config_file} 不存在，使用默认配置")
        return {}
    except json.JSONDecodeError as e:
        print(f"配置文件格式错误: {e}")
        return {}


def run_integration_example():
    """运行集成示例"""
    print("=" * 60)
    print("Steam数据集成示例")
    print("=" * 60)

    # 加载配置
    config = load_config("steam_config.json")
    api_key = config.get("steam_api_key", "")

    if not api_key or api_key == "YOUR_STEAM_API_KEY_HERE":
        print("\n请先配置Steam Web API密钥！")
        print("1. 访问 https://steamcommunity.com/dev/apikey 申请API密钥")
        print("2. 将密钥填入 steam_config.json 文件")
        return

    # 初始化API
    api = SteamUserAPI(api_key, request_delay=config.get("request_delay", 0.5))

    # 示例Steam ID（请替换为真实的Steam ID）
    example_steam_id = "76561198000000000"

    if len(sys.argv) > 1:
        arg = sys.argv[1]
        if not arg.isdigit():
            print(f"正在解析自定义URL: {arg}")
            resolved = api.resolve_vanity_url(arg)
            if resolved:
                example_steam_id = resolved
                print(f"解析结果: {example_steam_id}")
            else:
                print(f"无法解析自定义URL: {arg}")
                return
        else:
            example_steam_id = arg

    # 1. 获取用户资料
    print(f"\n[1/5] 获取用户资料 (Steam ID: {example_steam_id})...")
    profile = api.get_user_profile(example_steam_id)
    if profile:
        print(f"  用户名: {profile.username}")
        print(f"  在线状态: {profile.persona_state_text}")
        print(f"  个人资料: {profile.profile_url}")
        print(f"  资料可见性: {'公开' if profile.community_visibility_state == 3 else '受限'}")
    else:
        print("  无法获取用户资料，终止操作。")
        return

    # 2. 获取游戏列表
    print("\n[2/5] 获取游戏列表...")
    games = api.get_user_games(example_steam_id)
    if games:
        total_time = sum(g.playtime_forever for g in games)
        print(f"  游戏总数: {len(games)}")
        print(f"  总游戏时间: {round(total_time / 60, 1)} 小时")
        print(f"\n  游戏时间排行前5:")
        for i, g in enumerate(games[:5], 1):
            hours = round(g.playtime_forever / 60, 1)
            print(f"  {i}. {g.name} - {hours} 小时")

    # 3. 获取最近游玩
    print("\n[3/5] 获取最近游玩...")
    recent = api.get_recently_played_games(example_steam_id, 5)
    if recent:
        for g in recent:
            hours = round(g.playtime_2weeks / 60, 1) if g.playtime_2weeks else 0
            print(f"  - {g.name} (近两周: {hours}小时)")
    else:
        print("  没有最近游玩记录")

    # 4. 获取好友列表
    print("\n[4/5] 获取好友列表...")
    friends = api.get_user_friends(example_steam_id)
    if friends:
        print(f"  好友总数: {len(friends)}")
        online_friends = [f for f in friends if f.persona_state > 0]
        print(f"  当前在线: {len(online_friends)}")
        print(f"\n  前5位好友:")
        for f in friends[:5]:
            state_text = "在线" if f.persona_state > 0 else "离线"
            game_info = f" (正在玩: {f.game_name})" if f.game_name else ""
            print(f"  - {f.username} [{state_text}]{game_info}")
    else:
        print("  无法获取好友列表（用户可能将资料设为私密）")

    # 5. 保存数据
    print("\n[5/5] 保存数据...")
    output_dir = config.get("default_output_dir", "output")

    # 保存JSON
    json_path = api.save_user_data_to_json(example_steam_id, output_dir)
    if json_path:
        print(f"  JSON已保存: {json_path}")

    # 保存CSV
    csv_path = api.save_user_games_to_csv(example_steam_id, output_dir)
    if csv_path:
        print(f"  CSV已保存: {csv_path}")

    print("\n" + "=" * 60)
    print("集成示例执行完成！")


if __name__ == "__main__":
    run_integration_example()
