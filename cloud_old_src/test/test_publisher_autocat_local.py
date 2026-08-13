#!/usr/bin/env python3
"""
本地测试publisher_based_autocat.py脚本（跳过网络请求）
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
    
    # 显示所有供应商
    for i, (name, urls) in enumerate(publishers.items()):
        print(f"{i+1:2d}. {name}: {len(urls)} 个URL")
    
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
        "no_numbers_here",
        "app_123",
        "game_456",
        "789"
    ]
    
    for test_case in test_cases:
        game_id = enhanced_cat.extract_game_id_from_node_name(test_case)
        print(f"节点名称: {test_case:<40} -> 游戏ID: {game_id}")

def test_game_extraction():
    """测试从合并数据中提取游戏信息"""
    print("\n=== 测试游戏信息提取 ===")
    
    # 创建一个更真实的测试数据，模拟实际的JSON格式
    test_data = [
        [
            "user-collections.from-tag-Valve",
            {
                "key": "user-collections.from-tag-Valve",
                "timestamp": 1761896687,
                "value": "{\"id\": \"from-tag-Valve\", \"name\": \"★V社\", \"added\": [10, 20, 30], \"removed\": []}"
            }
        ],
        [
            "user-collections.from-tag-Electronic Arts",
            {
                "key": "user-collections.from-tag-Electronic Arts", 
                "timestamp": 1762617103,
                "value": "{\"id\": \"from-tag-Electronic Arts\", \"name\": \"★艺电\", \"added\": [3300, 3310], \"removed\": []}"
            }
        ],
        [
            "user-collections.uc-8fgRxZny6sFQ",
            {
                "key": "user-collections.uc-8fgRxZny6sFQ",
                "timestamp": 1763129100,
                "value": "{\"id\": \"uc-8fgRxZny6sFQ\", \"name\": \"★K\", \"added\": [7670, 51077], \"removed\": []}"
            }
        ],
        [
            "showcases.0",
            {
                "key": "showcases.0",
                "timestamp": 1758968669,
                "value": "{\"nShowcaseId\":0,\"strCollectionId\":\"uc-IdqD3FCR2iiq\",\"eSortBy\":6,\"bExpanded\":true,\"nOrder\":1727221349699.75,\"nLastChangedMS\":1758968675752}"
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

def test_categorization():
    """测试分类功能（模拟）"""
    print("\n=== 测试分类功能 ===")
    
    # 创建模拟的游戏数据
    games_data = {
        10: {
            'name': 'Counter-Strike',
            'tags': ['action', 'multiplayer'],
            'node_name': 'user-collections.from-tag-Valve',
            'value_data': {}
        },
        20: {
            'name': 'Team Fortress Classic',
            'tags': ['action', 'multiplayer'],
            'node_name': 'user-collections.from-tag-Valve', 
            'value_data': {}
        },
        3300: {
            'name': 'FIFA 14',
            'tags': ['sports'],
            'node_name': 'user-collections.from-tag-Electronic Arts',
            'value_data': {}
        }
    }
    
    # 创建模拟的供应商映射
    auto_cat = PublisherBasedAutoCat()
    auto_cat.game_publisher_map = {
        10: 'V社',
        20: 'V社', 
        3300: '艺电'
    }
    
    # 测试分类（不调用网络请求）
    categorized_games = {}
    for game_id, game_info in games_data.items():
        categories = []
        # 基于供应商分类
        if game_id in auto_cat.game_publisher_map:
            publisher = auto_cat.game_publisher_map[game_id]
            categories.append(f"供应商-{publisher}")
        categorized_games[game_id] = categories
    
    print(f"分类结果数量: {len(categorized_games)}")
    
    for game_id, categories in categorized_games.items():
        if game_id in games_data:
            print(f"游戏ID: {game_id} ({games_data[game_id]['name']})")
            print(f"  分类: {', '.join(categories) if categories else '无分类'}")
            print()

def test_statistics():
    """测试统计功能"""
    print("\n=== 测试统计功能 ===")
    
    auto_cat = PublisherBasedAutoCat()
    # 模拟一些数据
    auto_cat.publishers = {
        'V社': [10, 20, 30],
        '艺电': [3300, 3310],
        '育碧': [13500, 13520, 13530]
    }
    auto_cat.game_publisher_map = {
        10: 'V社',
        20: 'V社',
        30: 'V社',
        3300: '艺电',
        3310: '艺电',
        13500: '育碧',
        13520: '育碧',
        13530: '育碧'
    }
    
    stats = auto_cat.get_statistics()
    
    print(f"总供应商数: {stats['total_publishers']}")
    print(f"总映射游戏数: {stats['total_games_mapped']}")
    print("供应商分布:")
    for publisher, count in stats['publisher_distribution'].items():
        print(f"  {publisher}: {count} 个游戏")

if __name__ == "__main__":
    print("开始本地测试publisher_based_autocat.py脚本（跳过网络请求）")
    
    try:
        test_publisher_loading()
        test_game_id_extraction()
        test_game_extraction()
        test_categorization()
        test_statistics()
        
        print("\n=== 所有本地测试完成 ===")
    except Exception as e:
        print(f"测试过程中出现错误: {e}")
        import traceback
        traceback.print_exc()