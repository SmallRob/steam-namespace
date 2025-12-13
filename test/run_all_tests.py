#!/usr/bin/env python3
"""
运行所有测试脚本
"""

import subprocess
import sys
import os

def run_test_script(script_name):
    """运行指定的测试脚本"""
    print(f"\n{'='*50}")
    print(f"运行测试脚本: {script_name}")
    print(f"{'='*50}")
    
    try:
        # 使用subprocess.run运行测试脚本
        result = subprocess.run([sys.executable, script_name], 
                              cwd=os.path.dirname(os.path.abspath(__file__)),
                              capture_output=True, 
                              text=True, 
                              timeout=60)
        
        # 输出结果
        print(result.stdout)
        if result.stderr:
            print("STDERR:", result.stderr)
        
        # 检查返回码
        if result.returncode == 0:
            print(f"✓ {script_name} 运行成功")
        else:
            print(f"✗ {script_name} 运行失败 (返回码: {result.returncode})")
            
    except subprocess.TimeoutExpired:
        print(f"✗ {script_name} 运行超时")
    except Exception as e:
        print(f"✗ 运行 {script_name} 时出错: {e}")

def main():
    """主函数"""
    print("开始运行所有测试脚本...")
    
    # 定义要运行的测试脚本列表
    test_scripts = [
        "test_get_game_details.py",
        "test_modified_script.py",
        "test_small_collection.py"
    ]
    
    # 运行每个测试脚本
    for script in test_scripts:
        script_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), script)
        if os.path.exists(script_path):
            run_test_script(script)
        else:
            print(f"警告: 测试脚本 {script} 不存在")
    
    print(f"\n{'='*50}")
    print("所有测试脚本运行完成")
    print(f"{'='*50}")

if __name__ == "__main__":
    main()