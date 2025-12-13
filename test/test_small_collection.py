#!/usr/bin/env python3
"""
测试处理小集合的游戏详情获取脚本
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 导入我们的主模块
import get_game_details_byid

def test_small_collection():
    """测试处理一个小集合"""
    print("=== 测试处理小集合 ===")
    
    # 创建一个只包含几个游戏ID的小集合用于测试
    test_collection_name = "测试集合"
    test_app_ids = [570, 730, 235320]  # Dota 2, CS:GO, Insurgency
    
    print(f"处理集合: {test_collection_name}")
    print(f"游戏ID: {test_app_ids}")
    
    # 处理集合并保存
    get_game_details_byid.process_collection_and_save(test_collection_name, test_app_ids)

if __name__ == "__main__":
    print("开始测试处理小集合")
    
    try:
        test_small_collection()
        
        print("\n=== 测试完成 ===")
        
    except Exception as e:
        print(f"测试过程中出现错误: {e}")
        import traceback
        traceback.print_exc()