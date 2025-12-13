#!/usr/bin/env python3
"""
测试带cookie的SteamDB抓取功能
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from publisher_based_autocat import PublisherBasedAutoCat
import json
from pathlib import Path

def test_cookie_loading():
    """测试cookie加载功能"""
    print("=== 测试cookie加载功能 ===")
    auto_cat = PublisherBasedAutoCat()
    
    # 创建测试cookie文件
    test_cookie_content = """sessionid=test_session_id
steamLoginSecure=test_steam_login_secure
steamCountry=CN
"""
    
    with open(auto_cat.cookie_file, 'w', encoding='utf-8') as f:
        f.write(test_cookie_content)
    
    # 测试加载cookies
    cookies = auto_cat.load_cookies()
    print(f"加载的cookies数量: {len(cookies)}")
    for key, value in cookies.items():
        print(f"  {key}: {value}")
    
    return cookies

def test_steamdb_fetch_with_cookies():
    """测试带cookie的SteamDB抓取功能"""
    print("\n=== 测试带cookie的SteamDB抓取功能 ===")
    auto_cat = PublisherBasedAutoCat()
    
    # 使用一个简单的测试URL（如果可用）
    test_url = "https://steamdb.info/publisher/Valve/?displayOnly=Game"
    
    print(f"尝试从 {test_url} 抓取数据...")
    game_ids = auto_cat.fetch_game_ids_from_steamdb(test_url)
    
    print(f"获取到的游戏ID数量: {len(game_ids)}")
    print("前10个游戏ID:")
    for i, game_id in enumerate(game_ids[:10]):
        print(f"  {i+1}. {game_id}")

if __name__ == "__main__":
    print("开始测试带cookie的SteamDB抓取功能")
    
    try:
        test_cookie_loading()
        test_steamdb_fetch_with_cookies()
        
        print("\n=== 测试完成 ===")
    except Exception as e:
        print(f"测试过程中出现错误: {e}")
        import traceback
        traceback.print_exc()