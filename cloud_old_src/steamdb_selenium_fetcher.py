#!/usr/bin/env python3
"""
使用Selenium从SteamDB抓取游戏ID的替代方案
"""

import json
import re
import time
import random
from pathlib import Path
from typing import List, Dict
import logging
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.common.exceptions import TimeoutException, NoSuchElementException

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class SteamDBSeleniumFetcher:
    """使用Selenium从SteamDB抓取游戏ID"""
    
    def __init__(self):
        self.cookie_file = Path('json-config/support/cookies.txt')
        
    def load_cookies(self) -> List[Dict]:
        """从文件加载cookies为Selenium格式"""
        cookies = []
        if self.cookie_file.exists():
            try:
                with open(self.cookie_file, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if line and '=' in line and not line.startswith('#'):
                            key, value = line.split('=', 1)
                            cookies.append({
                                'name': key,
                                'value': value,
                                'domain': '.steamdb.info'
                            })
            except Exception as e:
                logger.warning(f"加载cookie文件失败: {e}")
        return cookies
    
    def setup_driver(self) -> webdriver.Chrome:
        """设置Chrome驱动"""
        chrome_options = Options()
        chrome_options.add_argument('--headless')  # 无头模式
        chrome_options.add_argument('--no-sandbox')
        chrome_options.add_argument('--disable-dev-shm-usage')
        chrome_options.add_argument('--disable-gpu')
        chrome_options.add_argument('--window-size=1920,1080')
        chrome_options.add_argument('--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36')
        
        # 创建驱动
        driver = webdriver.Chrome(options=chrome_options)
        return driver
    
    def fetch_game_ids_from_steamdb(self, url: str) -> List[int]:
        """使用Selenium从SteamDB页面抓取游戏ID"""
        game_ids = []
        
        try:
            # 设置驱动
            driver = self.setup_driver()
            
            # 访问页面
            logger.info(f"访问页面: {url}")
            driver.get(url)
            
            # 加载cookies
            cookies = self.load_cookies()
            for cookie in cookies:
                try:
                    driver.add_cookie(cookie)
                except Exception as e:
                    logger.warning(f"添加cookie失败: {e}")
            
            # 刷新页面以应用cookies
            driver.refresh()
            
            # 等待页面加载
            wait = WebDriverWait(driver, 10)
            
            # 查找游戏行
            try:
                # 等待表格加载
                wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "tr.app, tr.app-row, tr[data-appid]")))
                
                # 查找所有游戏行
                game_rows = driver.find_elements(By.CSS_SELECTOR, "tr.app, tr.app-row, tr[data-appid]")
                logger.info(f"找到 {len(game_rows)} 个游戏行")
                
                for row in game_rows:
                    try:
                        # 尝试从data-appid属性获取
                        appid = row.get_attribute('data-appid')
                        if appid:
                            try:
                                game_ids.append(int(appid))
                            except ValueError:
                                pass
                        else:
                            # 尝试从链接中提取
                            links = row.find_elements(By.TAG_NAME, 'a')
                            for link in links:
                                href = link.get_attribute('href')
                                if href:
                                    match = re.search(r'/app/(\d+)/', href)
                                    if match:
                                        try:
                                            game_ids.append(int(match.group(1)))
                                        except ValueError:
                                            pass
                    except Exception as e:
                        logger.warning(f"处理游戏行时出错: {e}")
                        continue
                        
            except TimeoutException:
                logger.warning("页面加载超时，尝试其他方法")
                # 尝试查找所有包含/app/链接的元素
                try:
                    links = driver.find_elements(By.XPATH, "//a[contains(@href, '/app/')]")
                    for link in links:
                        href = link.get_attribute('href')
                        if href:
                            match = re.search(r'/app/(\d+)/', href)
                            if match:
                                try:
                                    game_ids.append(int(match.group(1)))
                                except ValueError:
                                    pass
                except Exception as e:
                    logger.error(f"查找链接时出错: {e}")
            
            logger.info(f"从 {url} 获取到 {len(game_ids)} 个游戏ID")
            
        except Exception as e:
            logger.error(f"使用Selenium抓取 {url} 失败: {e}")
        finally:
            try:
                driver.quit()
            except:
                pass
        
        return list(set(game_ids))  # 去重

def main():
    """主函数 - 测试Selenium抓取"""
    fetcher = SteamDBSeleniumFetcher()
    
    # 测试URL
    test_url = "https://steamdb.info/publisher/Valve/?displayOnly=Game"
    
    print("=== 使用Selenium测试SteamDB抓取 ===")
    game_ids = fetcher.fetch_game_ids_from_steamdb(test_url)
    
    print(f"获取到的游戏ID数量: {len(game_ids)}")
    print("前10个游戏ID:")
    for i, game_id in enumerate(game_ids[:10]):
        print(f"  {i+1}. {game_id}")

if __name__ == "__main__":
    main()