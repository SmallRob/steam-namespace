#!/usr/bin/env python3
"""
终极版Steam游戏库分类工具
结合供应商分类和AutoCat自动分类，提供完整的分类解决方案
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

# 导入原有的AutoCat分类器
from depressurizer_autocat import (
    GameInfo, GameDB, AutoCat, AutoCatGenre, AutoCatTags, AutoCatYear, 
    DepressurizerAutoCat, parse_custom_json
)

class PublisherBasedAutoCat:
    """基于供应商的分类器"""
    
    def __init__(self):
        self.publishers = {}  # 供应商名称 -> 游戏ID列表
        self.game_publisher_map = {}  # 游戏ID -> 供应商名称
        self.publisher_file = Path('json-config/support/publisher.txt')
        
    def load_publishers_from_file(self) -> Dict[str, List[str]]:
        """从publisher.txt文件加载供应商信息"""
        publishers = {}
        
        if not self.publisher_file.exists():
            logger.error(f"供应商文件不存在: {self.publisher_file}")
            return publishers
        
        with open(self.publisher_file, 'r', encoding='utf-8') as f:
            content = f.read()
        
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
        game_ids = []
        
        try:
            # 添加随机延迟避免被反爬
            time.sleep(random.uniform(1, 3))
            
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
            
            response = requests.get(url, headers=headers, timeout=30)
            response.raise_for_status()
            
            soup = BeautifulSoup(response.text, 'html.parser')
            
            # 查找包含游戏信息的表格行
            game_rows = soup.find_all('tr', class_=['app', 'app-row'])
            
            if not game_rows:
                # 尝试其他选择器
                game_rows = soup.find_all('tr', {'data-appid': True})
            
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
            
        except Exception as e:
            logger.error(f"从 {url} 获取游戏ID失败: {e}")
        
        return game_ids
    
    def build_publisher_game_mapping(self) -> Dict[str, List[int]]:
        """构建供应商到游戏ID的映射"""
        publishers = self.load_publishers_from_file()
        publisher_game_map = {}
        
        for publisher_name, urls in publishers.items():
            all_game_ids = []
            
            for url in urls:
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

class UltimateAutoCat:
    """终极版分类器，结合供应商分类和AutoCat自动分类"""
    
    def __init__(self):
        self.publisher_cat = PublisherBasedAutoCat()
        self.depressurizer_cat = DepressurizerAutoCat()
        
    def extract_games_from_merged_data(self, merged_data: List) -> Dict[int, Dict[str, Any]]:
        """从合并数据中提取游戏信息"""
        games_data = {}
        
        for item in merged_data:
            if len(item) > 1 and 'value' in item[1]:
                try:
                    value_data = json.loads(item[1]['value'])
                    
                    # 检查是否是游戏节点
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
    
    def configure_autocat_classifier(self, games_data: Dict[int, Dict[str, Any]]) -> DepressurizerAutoCat:
        """配置AutoCat分类器"""
        auto_cat = DepressurizerAutoCat()
        
        # 创建游戏数据库
        auto_cat.game_db.games = games_data
        
        # 创建GameInfo对象
        for game_id, game_data in games_data.items():
            game = GameInfo(game_id, game_data.get('name', ''))
            game.tags = game_data.get('tags', [])
            auto_cat.games[game_id] = game
        
        # 添加分类器
        # 1. 基于类型的分类器
        auto_cat_genre = AutoCatGenre(
            name="类型分类",
            prefix="类型-",
            max_categories=3,
            remove_other_genres=False,
            tag_fallback=True,
            ignored_genres=['indie']
        )
        auto_cat.add_auto_cat(auto_cat_genre)
        
        # 2. 基于标签的分类器
        auto_cat_tags = AutoCatTags(
            name="标签分类",
            prefix="标签-",
            included_tags=None,
            max_tags=5
        )
        auto_cat.add_auto_cat(auto_cat_tags)
        
        # 3. 基于年份的分类器
        auto_cat_year = AutoCatYear(
            name="年份分类",
            prefix="年份-"
        )
        auto_cat.add_auto_cat(auto_cat_year)
        
        return auto_cat
    
    def ultimate_categorization(self):
        """执行终极版分类流程"""
        
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
        publisher_categories = self.publisher_cat.categorize_games(games_data)
        
        # 步骤4: AutoCat自动分类
        print("\n=== 步骤4: AutoCat自动分类 ===")
        self.depressurizer_cat = self.configure_autocat_classifier(games_data)
        autocat_results = self.depressurizer_cat.autocategorize()
        
        # 步骤5: 合并分类结果
        print("\n=== 步骤5: 合并分类结果 ===")
        ultimate_categories = self.merge_categories(publisher_categories)
        
        # 步骤6: 生成分类后的配置
        print("\n=== 步骤6: 生成分类配置 ===")
        categorized_data = self.generate_ultimate_config(merged_data, ultimate_categories, games_data)
        
        # 步骤7: 保存结果
        output_file = Path('json-config/ultimate-categorized-cloud-storage-namespace.json')
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(categorized_data, f, indent=2, ensure_ascii=False)
        
        print(f"终极分类结果已保存到: {output_file}")
        
        # 步骤8: 输出统计信息
        print("\n=== 步骤7: 终极分类统计 ===")
        self.print_ultimate_statistics(ultimate_categories, games_data, autocat_results)
    
    def merge_categories(self, publisher_categories: Dict[int, List[str]]) -> Dict[int, List[str]]:
        """合并供应商分类和AutoCat分类结果"""
        ultimate_categories = {}
        
        # 先添加供应商分类
        for game_id, pub_categories in publisher_categories.items():
            ultimate_categories[game_id] = pub_categories.copy()
        
        # 再添加AutoCat分类（避免重复）
        for game_id, game in self.depressurizer_cat.games.items():
            if game_id not in ultimate_categories:
                ultimate_categories[game_id] = []
            
            # 添加AutoCat分类
            autocat_categories = game.get_cat_string()
            if autocat_categories:
                # 解析AutoCat分类字符串
                for cat in autocat_categories.split(','):
                    cat = cat.strip()
                    if cat and cat not in ultimate_categories[game_id]:
                        ultimate_categories[game_id].append(cat)
        
        return ultimate_categories
    
    def generate_ultimate_config(self, original_data: List, 
                               ultimate_categories: Dict[int, List[str]],
                               games_data: Dict[int, Dict[str, Any]]) -> List:
        """生成终极版分类配置"""
        categorized_data = []
        
        for item in original_data:
            if len(item) > 1 and 'value' in item[1]:
                try:
                    value_data = json.loads(item[1]['value'])
                    
                    # 检查是否是游戏节点
                    if 'name' in value_data and 'added' in value_data:
                        node_name = item[0]
                        game_id = self.extract_game_id_from_node_name(node_name)
                        
                        if game_id and game_id in ultimate_categories:
                            categories = ultimate_categories[game_id]
                            
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
    
    def print_ultimate_statistics(self, ultimate_categories: Dict[int, List[str]], 
                                games_data: Dict[int, Dict[str, Any]],
                                autocat_results: Dict[str, Any]):
        """打印终极版统计信息"""
        total_games = len(games_data)
        classified_games = len(ultimate_categories)
        classification_rate = classified_games / total_games if total_games > 0 else 0
        
        print(f"总游戏数: {total_games}")
        print(f"已分类游戏数: {classified_games}")
        print(f"分类率: {classification_rate:.1%}")
        
        # 供应商分布统计
        publisher_stats = defaultdict(int)
        for game_id, categories in ultimate_categories.items():
            for category in categories:
                if category.startswith('供应商-'):
                    publisher = category[4:]  # 去掉"供应商-"前缀
                    publisher_stats[publisher] += 1
        
        if publisher_stats:
            print("\n供应商分布:")
            print("-" * 40)
            
            sorted_publishers = sorted(publisher_stats.items(), key=lambda x: x[1], reverse=True)
            
            for i, (publisher, count) in enumerate(sorted_publishers[:15]):  # 显示前15个
                print(f"{i+1:2d}. {publisher}: {count} 个游戏")
            
            if len(sorted_publishers) > 15:
                print(f"... 还有 {len(sorted_publishers) - 15} 个供应商")
        
        # AutoCat分类统计
        print("\nAutoCat分类统计:")
        print("-" * 30)
        for cat_name, cat_result in autocat_results['auto_cat_results'].items():
            print(f"{cat_name}: {cat_result['success_rate']:.1%} 成功率")
        
        # 显示前几个游戏的分类结果
        print("\n前8个游戏的分类结果:")
        print("-" * 70)
        
        classified_game_ids = list(ultimate_categories.keys())
        for i, game_id in enumerate(classified_game_ids[:8]):
            if game_id in games_data:
                game_info = games_data[game_id]
                categories = ultimate_categories[game_id]
                
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
    print("=== 终极版Steam游戏库分类工具 ===")
    print("功能: 1) 供应商分类（基于publisher.txt）")
    print("      2) AutoCat自动分类（基于游戏类型、标签、年份）")
    print("      3) 合并分类结果")
    print("      4) 生成终极分类配置")
    print()
    
    try:
        ultimate_cat = UltimateAutoCat()
        ultimate_cat.ultimate_categorization()
        print("\n=== 终极分类处理完成 ===")
    except Exception as e:
        logger.error(f"处理过程中出现错误: {e}")
        import traceback
        traceback.print_exc()
        print("\n=== 处理失败 ===")

if __name__ == "__main__":
    main()