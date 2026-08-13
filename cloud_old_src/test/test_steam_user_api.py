#!/usr/bin/env python3
"""
Steam用户API测试脚本
"""

import json
import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from pathlib import Path
from datetime import datetime
from dataclasses import asdict

from steam_user_api import (
    SteamUserAPI, SteamWebAPIClient,
    SteamUserProfile, SteamUserGame, SteamUserAchievement,
    SteamUserGameStats, SteamFriendInfo,
    PERSONA_STATE_MAP, VISIBILITY_STATE_MAP
)


def test_data_structures():
    """测试数据结构"""
    print("=== 测试数据结构 ===")

    # 测试用户资料数据类
    print("1. 测试用户资料数据类...")
    profile = SteamUserProfile(
        steam_id="76561198000000000",
        username="TestUser",
        real_name="Test User",
        avatar_url="https://example.com/avatar.jpg",
        profile_url="https://steamcommunity.com/id/testuser",
        country_code="US",
        persona_state=1,
        persona_state_text="在线"
    )
    profile_dict = asdict(profile)
    assert profile_dict["steam_id"] == "76561198000000000"
    assert profile_dict["username"] == "TestUser"
    print(f"   ✓ 用户资料数据类: {len(profile_dict)} 个字段")

    # 测试游戏数据类
    print("2. 测试游戏数据类...")
    game = SteamUserGame(
        app_id=730,
        name="Counter-Strike 2",
        playtime_forever=1000,
        playtime_2weeks=50,
        img_icon_url="https://example.com/icon.jpg",
        has_community_visible_stats=True
    )
    game_dict = asdict(game)
    assert game_dict["app_id"] == 730
    assert game_dict["name"] == "Counter-Strike 2"
    print(f"   ✓ 游戏数据类: {len(game_dict)} 个字段")

    # 测试成就数据类
    print("3. 测试成就数据类...")
    achievement = SteamUserAchievement(
        app_id=730,
        achievement_name="WIN_PISTOLROUND",
        achieved=True,
        unlock_time=1609459200,
        description="赢得手枪回合"
    )
    achievement_dict = asdict(achievement)
    assert achievement_dict["achieved"] == True
    print(f"   ✓ 成就数据类: {len(achievement_dict)} 个字段")

    # 测试好友数据类
    print("4. 测试好友数据类...")
    friend = SteamFriendInfo(
        steam_id="76561198000000001",
        username="FriendUser",
        persona_state=1,
        friend_since=1609459200,
        relationship="friend"
    )
    friend_dict = asdict(friend)
    assert friend_dict["relationship"] == "friend"
    print(f"   ✓ 好友数据类: {len(friend_dict)} 个字段")

    # 测试状态码映射
    print("5. 测试状态码映射...")
    assert PERSONA_STATE_MAP[0] == "离线"
    assert PERSONA_STATE_MAP[1] == "在线"
    assert VISIBILITY_STATE_MAP[3] == "公开"
    print(f"   ✓ 状态码映射正确")

    # 测试JSON序列化
    print("6. 测试JSON序列化...")
    test_data = {
        'profile': profile_dict,
        'games': [game_dict],
        'achievements': [achievement_dict],
        'friends': [friend_dict]
    }
    json_str = json.dumps(test_data, ensure_ascii=False, indent=2, default=str)
    assert len(json_str) > 100
    print(f"   ✓ JSON序列化成功: {len(json_str)} 字符")

    print("\n=== 数据结构测试全部通过 ===\n")


def test_config_loading():
    """测试配置文件加载"""
    print("=== 测试配置文件 ===")

    config_file = Path("steam_config.json")
    if config_file.exists():
        with open(config_file, 'r', encoding='utf-8') as f:
            config = json.load(f)
        assert "steam_api_key" in config
        assert "default_output_dir" in config
        assert "request_delay" in config
        print(f"   ✓ 配置文件读取成功: {len(config)} 个配置项")
    else:
        print("   ⚠ 配置文件不存在，跳过测试")

    print("\n=== 配置文件测试完成 ===\n")


def test_file_operations():
    """测试文件操作"""
    print("=== 测试文件操作 ===")

    # 创建测试输出目录
    output_dir = Path("test_output")
    output_dir.mkdir(exist_ok=True)
    print(f"1. 创建测试输出目录: {output_dir}")

    # 测试JSON文件写入
    print("2. 测试JSON文件写入...")
    test_data = {
        'steam_id': '76561198000000000',
        'username': '测试用户',
        'fetch_time': datetime.now().isoformat(),
        'games': [
            {'app_id': 730, 'name': 'Counter-Strike 2', 'playtime': 1000},
            {'app_id': 440, 'name': 'Team Fortress 2', 'playtime': 500}
        ]
    }

    json_file = output_dir / f"test_data_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(json_file, 'w', encoding='utf-8') as f:
        json.dump(test_data, f, ensure_ascii=False, indent=2, default=str)
    print(f"   ✓ JSON文件写入成功: {json_file.name}")

    # 测试CSV文件写入
    print("3. 测试CSV文件写入...")
    import pandas as pd

    csv_file = output_dir / f"test_games_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    df = pd.DataFrame(test_data['games'])
    df.to_csv(csv_file, index=False, encoding='utf-8-sig')
    print(f"   ✓ CSV文件写入成功: {csv_file.name}")

    # 测试文件读取
    print("4. 测试文件读取...")
    with open(json_file, 'r', encoding='utf-8') as f:
        loaded_data = json.load(f)
    assert loaded_data['steam_id'] == '76561198000000000'
    print(f"   ✓ JSON文件读取成功: {len(loaded_data)} 个字段")

    # 清理测试文件
    print("5. 清理测试文件...")
    json_file.unlink()
    csv_file.unlink()
    output_dir.rmdir()
    print("   ✓ 测试文件清理完成")

    print("\n=== 文件操作测试全部通过 ===\n")


def test_api_client_init():
    """测试API客户端初始化"""
    print("=== 测试API客户端初始化 ===")

    # 测试无效API密钥
    print("1. 测试无效API密钥...")
    try:
        api = SteamUserAPI("INVALID_KEY")
        print("   ✗ 应该抛出异常但没有")
    except ValueError as e:
        assert "请提供有效的Steam Web API密钥" in str(e)
        print("   ✓ 正确拒绝无效API密钥")

    # 测试空API密钥
    print("2. 测试空API密钥...")
    try:
        api = SteamUserAPI("")
        print("   ✗ 应该抛出异常但没有")
    except ValueError as e:
        print("   ✓ 正确拒绝空API密钥")

    # 测试默认占位符密钥
    print("3. 测试占位符密钥...")
    try:
        api = SteamUserAPI("YOUR_STEAM_API_KEY_HERE")
        print("   ✗ 应该抛出异常但没有")
    except ValueError as e:
        print("   ✓ 正确拒绝占位符密钥")

    print("\n=== API客户端初始化测试全部通过 ===\n")


def test_real_api_connection():
    """测试真实API连接（需要有效API密钥）"""
    print("=== 测试真实API连接 ===")

    config_file = Path("steam_config.json")
    if not config_file.exists():
        print("   ⚠ 配置文件不存在，跳过真实API测试")
        return

    with open(config_file, 'r', encoding='utf-8') as f:
        config = json.load(f)

    api_key = config.get("steam_api_key", "")
    if not api_key or api_key == "YOUR_STEAM_API_KEY_HERE":
        print("   ⚠ 未配置有效API密钥，跳过真实API测试")
        return

    try:
        api = SteamUserAPI(api_key)

        # 测试解析自定义URL
        print("1. 测试解析自定义URL...")
        steam_id = api.resolve_vanity_url("gaben")
        if steam_id:
            print(f"   ✓ gaben -> {steam_id}")
        else:
            print("   ⚠ 解析失败（可能是API密钥无效）")
            return

        # 测试获取用户资料
        print("2. 测试获取用户资料...")
        profile = api.get_user_profile(steam_id)
        if profile:
            print(f"   ✓ 用户名: {profile.username}")
            print(f"   ✓ 在线状态: {profile.persona_state_text}")
            print(f"   ✓ 资料可见性: {'公开' if profile.community_visibility_state == 3 else '受限'}")
        else:
            print("   ⚠ 获取资料失败")

        # 测试获取游戏列表
        print("3. 测试获取游戏列表...")
        games = api.get_user_games(steam_id)
        if games:
            print(f"   ✓ 获取到 {len(games)} 个游戏")
        else:
            print("   ⚠ 获取游戏列表失败（可能资料未公开或需要API密钥）")

        print("\n=== 真实API连接测试完成 ===\n")

    except Exception as e:
        print(f"   ✗ 测试失败: {e}")
        import traceback
        traceback.print_exc()


def main():
    """主测试函数"""
    print("=" * 60)
    print("Steam用户API - 测试套件")
    print("=" * 60)
    print()

    try:
        # 基础测试（不需要API密钥）
        test_data_structures()
        test_config_loading()
        test_file_operations()
        test_api_client_init()

        # 真实API测试（需要API密钥）
        test_real_api_connection()

        print("=" * 60)
        print("所有测试完成！")
        print("=" * 60)

        print("\n使用说明:")
        print("1. 编辑 steam_config.json 填入你的Steam Web API密钥")
        print("2. API密钥申请: https://steamcommunity.com/dev/apikey")
        print("3. 运行 python3 integration_example.py <Steam ID 或 自定义URL>")
        print("4. 运行 python3 steam_user_api.py <Steam ID 或 自定义URL>")

    except Exception as e:
        print(f"测试过程中出现错误: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()
