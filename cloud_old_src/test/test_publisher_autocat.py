#!/usr/bin/env python3
"""
测试publisher_based_autocat.py脚本
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from publisher_based_autocat import PublisherBasedAutoCat, EnhancedPublisherAutoCat
import json
from pathlib import Path

def test_publisher_loading():
    """测试供应商信息加载功能"""
    print("=== 测试供应商信息加载 ===")
    auto_cat = PublisherBasedAutoCat()
    publishers = auto_cat.load_publishers_from_file()
    
    print(f"加载到的供应商数量: {len(publishers)}")
    
    # 显示前几个供应商
    for i, (name, urls) in enumerate(list(publishers.items())[:5]):
        print(f"{i+1}. {name}: {len(urls)} 个URL")
        for url in urls[:2]:  # 只显示前2个URL
            print(f"   {url}")
        if len(urls) > 2:
            print(f"   ... 还有 {len(urls) - 2} 个URL")
    
    return publishers

def test_game_id_extraction():
    """测试从节点名称中提取游戏ID的功能"""
    print("\n=== 测试游戏ID提取 ===")
    enhanced_cat = EnhancedPublisherAutoCat()
    
    # 测试不同的节点名称格式
    test_cases = [
        "app_123456",
        "game_789012",
        "user-collections.from-tag-Valve-123",
        "some_random_text_456_with_numbers",
        "no_numbers_here"
    ]
    
    for test_case in test_cases:
        game_id = enhanced_cat.extract_game_id_from_node_name(test_case)
        print(f"节点名称: {test_case} -> 游戏ID: {game_id}")

def test_game_extraction():
    """测试从合并数据中提取游戏信息"""
    print("\n=== 测试游戏信息提取 ===")
    
    # 创建一个简化的测试数据
    test_data = [
        [
            "user-collections.test-Valve",
            {
                "key": "user-collections.test-Valve",
                "timestamp": 1761896687,
                "value": "{\"id\": \"from-tag-Valve\", \"name\": \"★V社\", \"added\": [10, 20, 30], \"removed\": []}"
            }
        ],
        [
            "user-collections.test-EA",
            {
                "key": "user-collections.test-EA",
                "timestamp": 1762617103,
                "value": "{\"id\": \"from-tag-Electronic Arts\", \"name\": \"★艺电\", \"added\": [3300, 3310], \"removed\": []}"
            }
        ]
    ]
    
    enhanced_cat = EnhancedPublisherAutoCat()
    games_data = enhanced_cat.extract_games_from_merged_data(test_data)
    
    print(f"提取的游戏数量: {len(games_data)}")
    
    for game_id, game_info in games_data.items():
        print(f"游戏ID: {game_id}")
        print(f"  名称: {game_info['name']}")
        print(f"  节点名称: {game_info['node_name']}")
        print()

if __name__ == "__main__":
    print("开始测试publisher_based_autocat.py脚本")
    
    try:
        test_publisher_loading()
        test_game_id_extraction()
        test_game_extraction()
        
        print("\n=== 所有测试完成 ===")
    except Exception as e:
        print(f"测试过程中出现错误: {e}")
        import traceback
        traceback.print_exc()