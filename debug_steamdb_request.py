#!/usr/bin/env python3
"""
调试SteamDB请求的详细信息
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import requests
from bs4 import BeautifulSoup
import time
import random
from pathlib import Path

def load_cookies():
    """从文件加载cookies"""
    cookie_file = Path('json-config/support/cookies.txt')
    cookies = {}
    if cookie_file.exists():
        try:
            with open(cookie_file, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and '=' in line and not line.startswith('#'):
                        key, value = line.split('=', 1)
                        cookies[key] = value
        except Exception as e:
            print(f"加载cookie文件失败: {e}")
    return cookies

def debug_steamdb_request():
    """调试SteamDB请求"""
    url = "https://steamdb.info/publisher/Valve/?displayOnly=Game"
    
    # 加载cookies
    cookies = load_cookies()
    print(f"加载的cookies: {cookies}")
    
    # 设置请求头
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'max-age=0'
    }
    
    print(f"请求URL: {url}")
    print(f"请求头: {headers}")
    
    try:
        # 添加随机延迟
        time.sleep(random.uniform(1, 3))
        
        # 发送请求
        print("发送请求...")
        response = requests.get(url, headers=headers, cookies=cookies, timeout=30)
        
        print(f"响应状态码: {response.status_code}")
        print(f"响应头: {response.headers}")
        print(f"响应内容长度: {len(response.text)}")
        
        # 检查是否被拒绝
        if response.status_code == 403:
            print("收到403 Forbidden响应")
            print("响应内容预览:")
            print(response.text[:500])
        elif response.status_code == 200:
            print("收到200 OK响应")
            # 检查内容中是否包含错误信息
            if "Access Denied" in response.text or "Forbidden" in response.text:
                print("页面包含访问拒绝信息")
            
            # 尝试解析内容
            soup = BeautifulSoup(response.text, 'html.parser')
            print(f"页面标题: {soup.title.string if soup.title else '无标题'}")
            
            # 查找游戏相关的元素
            game_rows = soup.find_all('tr', class_=['app', 'app-row'])
            print(f"找到 {len(game_rows)} 个游戏行")
            
            if not game_rows:
                game_rows = soup.find_all('tr', {'data-appid': True})
                print(f"通过data-appid找到 {len(game_rows)} 个游戏行")
            
            # 显示前几个游戏行的信息
            for i, row in enumerate(game_rows[:5]):
                appid = row.get('data-appid')
                print(f"  游戏行 {i+1}: data-appid = {appid}")
                
        else:
            print(f"收到意外的状态码: {response.status_code}")
            
    except requests.exceptions.RequestException as e:
        print(f"请求异常: {e}")
        print(f"异常类型: {type(e).__name__}")
    except Exception as e:
        print(f"其他异常: {e}")
        print(f"异常类型: {type(e).__name__}")

if __name__ == "__main__":
    print("开始调试SteamDB请求")
    debug_steamdb_request()
    print("调试完成")