#!/usr/bin/env python3
"""
完整功能测试脚本
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from publisher_based_autocat import PublisherBasedAutoCat
import json
from pathlib import Path

def test_complete_functionality():
    """测试完整功能"""
    print("=== 测试完整功能 ===")
    
    # 创建测试cookie文件
    cookie_file = Path('json-config/support/cookies.txt')
    if not cookie_file.exists():
        test_cookie_content = """# 请在这里添加您的真实cookies
# 格式: key=value
# 例如:
# sessionid=your_real_session_id
# steamLoginSecure=your_real_steam_login_secure
"""
        with open(cookie_file, 'w', encoding='utf-8') as f:
            f.write(test_cookie_content)
        print("已创建cookie模板文件，请添加您的真实cookies后再测试")
    
    auto_cat = PublisherBasedAutoCat()
    
    # 测试加载供应商信息
    print("\n1. 测试加载供应商信息...")
    publishers = auto_cat.load_publishers_from_file()
    print(f"加载到 {len(publishers)} 个供应商")
    
    # 显示前3个供应商
    for i, (name, urls) in enumerate(list(publishers.items())[:3]):
        print(f"  {i+1}. {name}: {len(urls)} 个URL")
    
    # 测试cookie加载
    print("\n2. 测试cookie加载...")
    cookies = auto_cat.load_cookies()
    print(f"加载到 {len(cookies)} 个cookies")
    if cookies:
        for key in list(cookies.keys())[:3]:  # 只显示前3个key（避免显示敏感信息）
            print(f"  {key}: ***")
    
    # 测试使用requests的抓取（预期会失败）
    print("\n3. 测试使用requests的抓取...")
    auto_cat.set_use_selenium(False)  # 使用requests
    test_url = "https://steamdb.info/publisher/Valve/?displayOnly=Game"
    game_ids = auto_cat.fetch_game_ids_from_steamdb(test_url)
    print(f"使用requests获取到 {len(game_ids)} 个游戏ID")
    
    # 如果requests失败，建议使用Selenium
    if len(game_ids) == 0:
        print("\n4. 建议使用Selenium进行抓取...")
        print("   请安装Selenium: pip install selenium")
        print("   并下载ChromeDriver: https://chromedriver.chromium.org/")
        print("   然后设置 use_selenium = True")

def test_selenium_availability():
    """测试Selenium是否可用"""
    print("\n=== 测试Selenium可用性 ===")
    
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        print("✓ Selenium已安装")
        
        # 测试ChromeDriver
        chrome_options = Options()
        chrome_options.add_argument('--headless')
        chrome_options.add_argument('--no-sandbox')
        chrome_options.add_argument('--disable-dev-shm-usage')
        
        try:
            driver = webdriver.Chrome(options=chrome_options)
            driver.quit()
            print("✓ ChromeDriver可用")
        except Exception as e:
            print(f"✗ ChromeDriver不可用: {e}")
            print("  请下载并安装ChromeDriver: https://chromedriver.chromium.org/")
            
    except ImportError:
        print("✗ Selenium未安装")
        print("  请运行: pip install selenium")

if __name__ == "__main__":
    print("开始完整功能测试")
    
    try:
        test_complete_functionality()
        test_selenium_availability()
        
        print("\n=== 测试完成 ===")
        print("\n使用建议:")
        print("1. 如果requests方式失败（403错误），请:")
        print("   a) 安装Selenium: pip install selenium")
        print("   b) 下载ChromeDriver并确保其在PATH中")
        print("   c) 设置 use_selenium = True")
        print("2. 确保cookies.txt文件包含有效的SteamDB cookies")
        
    except Exception as e:
        print(f"测试过程中出现错误: {e}")
        import traceback
        traceback.print_exc()