#!/usr/bin/env python3
"""
基于供应商的Steam游戏库分类工具
基于publisher.txt中的供应商信息，从SteamDB抓取游戏ID并实现分类
"""

import json
import os
import re
import requests
from pathlib import Path
from collections import defaultdict
from typing import List, Dict, Set, Any, Optional, Tuple
import logging
from bs4 import BeautifulSoup
import time
import random

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class PublisherBasedAutoCat:
    """基于供应商的分类器"""
    
    def __init__(self):
        self.publishers = {}  # 供应商名称 -> 游戏ID列表
        self.game_publisher_map = {}  # 游戏ID -> 供应商名称
        self.publisher_file = Path('json-config/support/publisher.txt')
        self.cookie_file = Path('json-config/support/cookies.txt')  # 添加cookie文件路径
        self.use_selenium = False  # 是否使用Selenium
        
    def load_cookies(self):
        """从文件加载cookies"""
        cookies = {}
        if self.cookie_file.exists():
            try:
                with open(self.cookie_file, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if line and '=' in line and not line.startswith('#'):
                            key, value = line.split('=', 1)
                            cookies[key] = value
            except Exception as e:
                logger.warning(f"加载cookie文件失败: {e}")
        return cookies
        
    def set_use_selenium(self, use_selenium: bool):
        """设置是否使用Selenium"""
        self.use_selenium = use_selenium
    
    def load_publishers_from_file(self) -> Dict[str, List[str]]:
        """从publisher.txt文件加载供应商信息"""
        publishers = {}
        
        if not self.publisher_file.exists():
            logger.error(f"供应商文件不存在: {self.publisher_file}")
            return publishers
        
        try:
            with open(self.publisher_file, 'r', encoding='utf-8') as f:
                content = f.read()
        except Exception as e:
            logger.error(f"读取供应商文件失败: {e}")
            return publishers
        
        current_publisher = None
        urls = []
        
        for line in content.split('\n'):
            line = line.strip()
            if not line:
                continue
                
            # 检查是否是供应商名称行（以★或☆开头）
            if line.startswith('★') or line.startswith('☆'):
                # 保存前一个供应商
                if current_publisher and urls:
                    publishers[current_publisher] = urls.copy()
                
                # 开始新供应商
                current_publisher = line[1:].strip()  # 去掉标记符号
                urls = []
            
            # 检查是否是URL
            elif line.startswith('http'):
                urls.append(line)
        
        # 保存最后一个供应商
        if current_publisher and urls:
            publishers[current_publisher] = urls
        
        logger.info(f"从文件加载了 {len(publishers)} 个供应商")
        for pub, urls in publishers.items():
            logger.info(f"  {pub}: {len(urls)} 个URL")
        
        return publishers
    
    def fetch_game_ids_from_steamdb(self, url: str) -> List[int]:
        """从SteamDB页面抓取游戏ID"""
        if self.use_selenium:
            return self.fetch_game_ids_with_selenium(url)
        else:
            return self.fetch_game_ids_with_requests(url)
    
    def fetch_game_ids_with_requests(self, url: str) -> List[int]:
        """使用requests从SteamDB页面抓取游戏ID"""
        game_ids = []
        
        try:
            # 添加随机延迟避免被反爬
            time.sleep(random.uniform(1, 3))
            
            # 加载cookies
            cookies = self.load_cookies()
            
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
            
            logger.info(f"发送请求到 {url}")
            
            response = requests.get(url, headers=headers, cookies=cookies, timeout=30)
            logger.info(f"响应状态码: {response.status_code}")
            
            # 检查是否被Cloudflare等防护拦截
            if response.status_code == 403:
                logger.warning(f"请求被拒绝 (403)，可能是由于反爬虫防护。URL: {url}")
                logger.warning("请检查您的cookies是否有效，或者尝试使用浏览器自动化工具")
                return game_ids
            
            response.raise_for_status()
            
            # 检查内容编码
            content_type = response.headers.get('content-type', '')
            logger.info(f"响应内容类型: {content_type}")
            
            soup = BeautifulSoup(response.text, 'html.parser')
            
            # 查找包含游戏信息的表格行
            # SteamDB的游戏列表通常在具有特定类的表格中
            game_rows = soup.find_all('tr', class_=['app', 'app-row'])
            
            if not game_rows:
                # 尝试其他选择器
                game_rows = soup.find_all('tr', {'data-appid': True})
            
            if not game_rows:
                # 尝试查找包含应用链接的元素
                links = soup.find_all('a', href=re.compile(r'/app/\d+'))
                for link in links:
                    href = link['href']
                    match = re.search(r'/app/(\d+)/', href)
                    if match:
                        try:
                            game_ids.append(int(match.group(1)))
                        except ValueError:
                            pass
            
            for row in game_rows:
                # 从data-appid属性获取游戏ID
                appid = row.get('data-appid')
                if appid:
                    try:
                        game_ids.append(int(appid))
                    except ValueError:
                        pass
                else:
                    # 尝试从链接中提取
                    links = row.find_all('a', href=True)
                    for link in links:
                        href = link['href']
                        # 匹配类似 /app/123456/ 的链接
                        match = re.search(r'/app/(\d+)/', href)
                        if match:
                            try:
                                game_ids.append(int(match.group(1)))
                            except ValueError:
                                pass
            
            logger.info(f"从 {url} 获取到 {len(game_ids)} 个游戏ID")
            
        except requests.exceptions.RequestException as e:
            logger.error(f"网络请求失败 {url}: {e}")
            logger.error(f"错误类型: {type(e).__name__}")
        except Exception as e:
            logger.error(f"从 {url} 获取游戏ID失败: {e}")
            logger.error(f"错误类型: {type(e).__name__}")
        
        return list(set(game_ids))  # 去重
    
    def fetch_game_ids_with_selenium(self, url: str) -> List[int]:
        """使用Selenium从SteamDB页面抓取游戏ID"""
        try:
            # 导入Selenium相关模块
            from selenium import webdriver
            from selenium.webdriver.common.by import By
            from selenium.webdriver.support.ui import WebDriverWait
            from selenium.webdriver.support import expected_conditions as EC
            from selenium.webdriver.chrome.options import Options
            from selenium.common.exceptions import TimeoutException
            
            game_ids = []
            
            # 设置Chrome驱动
            chrome_options = Options()
            chrome_options.add_argument('--headless')  # 无头模式
            chrome_options.add_argument('--no-sandbox')
            chrome_options.add_argument('--disable-dev-shm-usage')
            chrome_options.add_argument('--disable-gpu')
            chrome_options.add_argument('--window-size=1920,1080')
            chrome_options.add_argument('--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36')
            
            # 创建驱动
            driver = webdriver.Chrome(options=chrome_options)
            
            try:
                # 访问页面
                logger.info(f"使用Selenium访问页面: {url}")
                driver.get(url)
                
                # 加载cookies
                cookies = self.load_cookies()
                for key, value in cookies.items():
                    try:
                        driver.add_cookie({
                            'name': key,
                            'value': value,
                            'domain': '.steamdb.info'
                        })
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
                
            finally:
                try:
                    driver.quit()
                except:
                    pass
            
            return list(set(game_ids))  # 去重
            
        except ImportError:
            logger.error("Selenium未安装，请运行: pip install selenium")
            return []
        except Exception as e:
            logger.error(f"使用Selenium抓取 {url} 失败: {e}")
            return []
    
    def build_publisher_game_mapping(self) -> Dict[str, List[int]]:
        """构建供应商到游戏ID的映射"""
        publishers = self.load_publishers_from_file()
        publisher_game_map = {}
        
        total_urls = sum(len(urls) for urls in publishers.values())
        processed_urls = 0
        
        for publisher_name, urls in publishers.items():
            all_game_ids = []
            
            for url in urls:
                processed_urls += 1
                logger.info(f"处理进度: {processed_urls}/{total_urls} - 正在处理 {publisher_name} 的 {url}")
                game_ids = self.fetch_game_ids_from_steamdb(url)
                all_game_ids.extend(game_ids)
            
            # 去重
            unique_game_ids = list(set(all_game_ids))
            
            if unique_game_ids:
                publisher_game_map[publisher_name] = unique_game_ids
                
                # 更新游戏到供应商的映射
                for game_id in unique_game_ids:
                    self.game_publisher_map[game_id] = publisher_name
            
            logger.info(f"供应商 {publisher_name}: {len(unique_game_ids)} 个游戏")
        
        self.publishers = publisher_game_map
        return publisher_game_map
    
    def categorize_games(self, games_data: Dict[int, Dict[str, Any]]) -> Dict[int, List[str]]:
        """对游戏进行分类"""
        categorized_games = {}
        
        # 构建供应商映射
        self.build_publisher_game_mapping()
        
        for game_id, game_info in games_data.items():
            categories = []
            
            # 基于供应商分类
            if game_id in self.game_publisher_map:
                publisher = self.game_publisher_map[game_id]
                categories.append(f"供应商-{publisher}")
            
            categorized_games[game_id] = categories
        
        return categorized_games
    
    def get_statistics(self) -> Dict[str, Any]:
        """获取分类统计信息"""
        stats = {
            'total_publishers': len(self.publishers),
            'total_games_mapped': len(self.game_publisher_map),
            'publisher_distribution': {},
            'unclassified_games': 0
        }
        
        for publisher, game_ids in self.publishers.items():
            stats['publisher_distribution'][publisher] = len(game_ids)
        
        return stats

class EnhancedPublisherAutoCat:
    """增强版供应商分类器，结合原有分类功能"""
    
    def __init__(self):
        self.publisher_cat = PublisherBasedAutoCat()
        
    def extract_games_from_merged_data(self, merged_data: List) -> Dict[int, Dict[str, Any]]:
        """从合并数据中提取游戏信息"""
        games_data = {}
        
        for item in merged_data:
            # 确保item格式正确
            if not isinstance(item, list) or len(item) < 2:
                continue
                
            # 确保第二个元素是字典且包含'value'键
            if not isinstance(item[1], dict) or 'value' not in item[1]:
                continue
                
            try:
                value_data = json.loads(item[1]['value'])
                
                # 检查是否是游戏节点 - 需要包含name和added字段
                if 'name' in value_data and 'added' in value_data:
                    # 尝试从节点名称中提取游戏ID
                    node_name = item[0]
                    game_id = self.extract_game_id_from_node_name(node_name)
                    
                    if game_id:
                        games_data[game_id] = {
                            'name': value_data.get('name', ''),
                            'tags': self.extract_tags_from_value(value_data),
                            'node_name': node_name,
                            'value_data': value_data
                        }
            except json.JSONDecodeError:
                # JSON解析失败，跳过该项
                continue
            except Exception as e:
                # 其他异常，记录日志并继续
                logger.warning(f"处理游戏数据时出现异常: {e}")
                continue
        
        logger.info(f"从合并数据中提取了 {len(games_data)} 个游戏")
        return games_data
    
    def extract_game_id_from_node_name(self, node_name: str) -> Optional[int]:
        """从节点名称中提取游戏ID"""
        patterns = [
            r'app_([0-9]+)',  # app_123456
            r'game_([0-9]+)',  # game_123456
            r'([0-9]+)$',     # 纯数字
        ]
        
        for pattern in patterns:
            match = re.search(pattern, node_name)
            if match:
                try:
                    return int(match.group(1))
                except ValueError:
                    continue
        
        # 如果上述模式都不匹配，尝试直接从节点名称中提取数字
        # 这对于格式如 "app_123456" 的节点名称特别有用
        match = re.search(r'(\d+)', node_name)
        if match:
            try:
                return int(match.group(1))
            except ValueError:
                pass
        
        return None
    
    def extract_tags_from_value(self, value_data: Dict) -> List[str]:
        """从value数据中提取标签"""
        tags = []
        
        if 'name' in value_data:
            name = value_data['name'].lower()
            
            genre_keywords = {
                'action': ['action', 'shooter', 'fps', 'tps'],
                'rpg': ['rpg', 'role-playing'],
                'strategy': ['strategy', 'rts', 'tbs'],
                'adventure': ['adventure', 'point-and-click'],
                'simulation': ['simulation', 'sim'],
                'sports': ['sports', 'football', 'basketball'],
                'racing': ['racing', 'driving'],
                'puzzle': ['puzzle', 'logic'],
                'horror': ['horror', 'survival horror'],
                'indie': ['indie', 'independent'],
                'multiplayer': ['multiplayer', 'co-op', 'coop'],
                'singleplayer': ['singleplayer', 'single-player']
            }
            
            for genre, keywords in genre_keywords.items():
                if any(keyword in name for keyword in keywords):
                    tags.append(genre)
        
        return tags
    
    def process_with_publisher_categorization(self):
        """执行完整的供应商分类流程"""
        
        # 步骤1: 读取合并后的数据
        print("=== 步骤1: 读取合并数据 ===")
        input_file = Path('json-config/formatted-cloud-storage-namespace.json')
        
        if not input_file.exists():
            logger.error(f"输入文件不存在: {input_file}")
            return
        
        with open(input_file, 'r', encoding='utf-8') as f:
            merged_data = json.load(f)
        
        print(f"读取到 {len(merged_data)} 个条目")
        
        # 步骤2: 提取游戏信息
        print("\n=== 步骤2: 提取游戏信息 ===")
        games_data = self.extract_games_from_merged_data(merged_data)
        
        # 步骤3: 供应商分类
        print("\n=== 步骤3: 供应商分类 ===")
        categorization_results = self.publisher_cat.categorize_games(games_data)
        
        # 步骤4: 生成分类后的配置
        print("\n=== 步骤4: 生成分类配置 ===")
        categorized_data = self.generate_categorized_config(merged_data, categorization_results, games_data)
        
        # 步骤5: 保存结果
        output_file = Path('json-config/publisher-categorized-cloud-storage-namespace.json')
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(categorized_data, f, indent=2, ensure_ascii=False)
        
        print(f"分类结果已保存到: {output_file}")
        
        # 步骤6: 输出统计信息
        print("\n=== 步骤5: 分类统计 ===")
        self.print_statistics(categorization_results, games_data)
    
    def generate_categorized_config(self, original_data: List, 
                                  categorization_results: Dict[int, List[str]],
                                  games_data: Dict[int, Dict[str, Any]]) -> List:
        """生成分类后的配置"""
        categorized_data = []
        
        for item in original_data:
            if len(item) > 1 and 'value' in item[1]:
                try:
                    value_data = json.loads(item[1]['value'])
                    
                    # 检查是否是游戏节点
                    if 'name' in value_data and 'added' in value_data:
                        node_name = item[0]
                        game_id = self.extract_game_id_from_node_name(node_name)
                        
                        if game_id and game_id in categorization_results:
                            categories = categorization_results[game_id]
                            
                            # 更新value数据，添加分类信息
                            if categories:
                                value_data['categories'] = categories
                            
                            # 添加供应商信息
                            if game_id in self.publisher_cat.game_publisher_map:
                                publisher = self.publisher_cat.game_publisher_map[game_id]
                                value_data['publisher'] = publisher
                            
                            # 创建新的item
                            new_item = [
                                item[0],  # 保持原有节点名称
                                {
                                    'value': json.dumps(value_data, ensure_ascii=False),
                                    'timestamp': item[1].get('timestamp', item[1].get('timestamp', ''))
                                }
                            ]
                            categorized_data.append(new_item)
                        else:
                            # 非游戏节点或未分类的游戏，保持原样
                            categorized_data.append(item)
                    else:
                        # 非游戏节点，保持原样
                        categorized_data.append(item)
                except json.JSONDecodeError:
                    # 保持原样
                    categorized_data.append(item)
            else:
                # 格式不正确的节点，保持原样
                categorized_data.append(item)
        
        return categorized_data
    
    def print_statistics(self, categorization_results: Dict[int, List[str]], 
                        games_data: Dict[int, Dict[str, Any]]):
        """打印统计信息"""
        total_games = len(games_data)
        classified_games = len(categorization_results)
        classification_rate = classified_games / total_games if total_games > 0 else 0
        
        print(f"总游戏数: {total_games}")
        print(f"已分类游戏数: {classified_games}")
        print(f"分类率: {classification_rate:.1%}")
        
        # 供应商分布统计
        publisher_stats = defaultdict(int)
        for game_id, categories in categorization_results.items():
            for category in categories:
                if category.startswith('供应商-'):
                    publisher = category[4:]  # 去掉"供应商-"前缀
                    publisher_stats[publisher] += 1
        
        if publisher_stats:
            print("\n供应商分布:")
            print("-" * 40)
            
            sorted_publishers = sorted(publisher_stats.items(), key=lambda x: x[1], reverse=True)
            
            for i, (publisher, count) in enumerate(sorted_publishers[:20]):  # 显示前20个
                print(f"{i+1:2d}. {publisher}: {count} 个游戏")
            
            if len(sorted_publishers) > 20:
                print(f"... 还有 {len(sorted_publishers) - 20} 个供应商")
        
        # 显示前几个游戏的分类结果
        print("\n前10个游戏的分类结果:")
        print("-" * 60)
        
        classified_game_ids = list(categorization_results.keys())
        for i, game_id in enumerate(classified_game_ids[:10]):
            if game_id in games_data:
                game_info = games_data[game_id]
                categories = categorization_results[game_id]
                
                publisher = "未知"
                if game_id in self.publisher_cat.game_publisher_map:
                    publisher = self.publisher_cat.game_publisher_map[game_id]
                
                print(f"{i+1:2d}. {game_info['name']}")
                print(f"    游戏ID: {game_id}")
                print(f"    供应商: {publisher}")
                print(f"    分类: {', '.join(categories) if categories else '无分类'}")
                print()

def main():
    """主函数"""
    print("=== 基于供应商的Steam游戏库分类工具 ===")
    print("功能: 1) 从publisher.txt读取供应商信息")
    print("      2) 从SteamDB抓取游戏ID")
    print("      3) 按供应商进行游戏分类")
    print("      4) 生成分类结果文件")
    print()
    
    try:
        auto_cat = EnhancedPublisherAutoCat()
        auto_cat.process_with_publisher_categorization()
        print("\n=== 处理完成 ===")
    except FileNotFoundError as e:
        logger.error(f"文件未找到: {e}")
        print("\n=== 处理失败 ===")
    except Exception as e:
        logger.error(f"处理过程中出现错误: {e}")
        import traceback
        traceback.print_exc()
        print("\n=== 处理失败 ===")

if __name__ == "__main__":
    main()