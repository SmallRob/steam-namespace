#!/usr/bin/env python3
"""
测试修改后的游戏详情获取脚本
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 导入我们的主模块
import get_game_details_byid

def test_collection_extraction():
    """测试从JSON文件中提取集合的功能"""
    print("=== 测试集合提取功能 ===")
    
    # 测试从JSON文件提取集合
    print("\n1. 测试从JSON文件提取集合:")
    json_file = "json-config/custom/custom.json"
    if os.path.exists(json_file):
        collections = get_game_details_byid.extract_collections_from_json(json_file)
        print(f"从 {json_file} 提取到 {len(collections)} 个集合")
        for collection in collections[:3]:  # 只显示前3个集合
            print(f"  集合名称: {collection['name']}, 游戏数量: {len(collection['ids'])}")
    else:
        print(f"文件 {json_file} 不存在")

def test_single_game_info():
    """测试获取单个游戏信息的功能"""
    print("\n=== 测试单个游戏信息获取 ===")
    
    # 使用一个已知的游戏ID进行测试
    test_app_id = 570  # Dota 2
    print(f"获取游戏ID {test_app_id} 的信息...")
    
    game_info = get_game_details_byid.get_steam_game_info(test_app_id)
    
    print("游戏信息:")
    for key, value in game_info.items():
        print(f"  {key}: {value}")

if __name__ == "__main__":
    print("开始测试修改后的游戏详情获取脚本")
    
    try:
        test_collection_extraction()
        test_single_game_info()
        
        print("\n=== 测试完成 ===")
        print("\n接下来可以运行主脚本来处理所有游戏:")
        print("python get_game_details_byid.py")
        
    except Exception as e:
        print(f"测试过程中出现错误: {e}")
        import traceback
        traceback.print_exc()