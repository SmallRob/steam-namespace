#!/usr/bin/env python3
"""
增强版合并脚本：结合原有JSON合并功能和Depressurizer AutoCat分类算法
"""

import json
import os
import re
from pathlib import Path
from collections import defaultdict
from typing import List, Dict, Set, Any, Optional
import logging

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# 导入Depressurizer AutoCat分类器
from depressurizer_autocat import (
    GameInfo, GameDB, AutoCat, AutoCatGenre, AutoCatTags, AutoCatYear, 
    DepressurizerAutoCat, parse_custom_json
)

def merge_all_custom_files_with_autocat():
    """增强版合并函数：结合JSON合并和AutoCat分类"""
    
    custom_dir = Path('json-config/custom')
    output_file = Path('json-config/formatted-cloud-storage-namespace.json')
    categorized_output = Path('json-config/categorized-cloud-storage-namespace.json')
    
    # 步骤1: 执行原有的JSON合并功能
    print("=== 步骤1: 执行JSON文件合并 ===")
    
    # 初始从现有的formatted-cloud-storage-namespace.json读取
    with open(output_file, 'r', encoding='utf-8') as f:
        formatted_data = json.load(f)
    
    print("初始文件有 " + str(len(formatted_data)) + " 个条目")
    
    # 遍历custom文件夹中的所有json文件
    for json_file in custom_dir.glob('*.json'):
        print("\n处理文件: " + json_file.name)
        
        # 读取文件内容
        with open(json_file, 'r', encoding='utf-8') as f:
            custom_content = f.read()
        
        # 解析custom文件
        custom_data = parse_custom_json(custom_content)
        print("成功解析 " + json_file.name + "，包含 " + str(len(custom_data)) + " 个条目")
        
        # 检查是否有重复的key
        existing_keys = {item[0] for item in formatted_data}
        new_items = [item for item in custom_data if item[0] not in existing_keys}
        
        print("新增 " + str(len(new_items)) + " 个条目")
        
        # 合并数据
        formatted_data.extend(new_items)
    
    # 删除所有以"NewContentRollup_"开头的节点
    print("\n删除所有以'NewContentRollup_'开头的节点...")
    before_count = len(formatted_data)
    formatted_data = [item for item in formatted_data if not item[0].startswith('NewContentRollup_')]
    after_count = len(formatted_data)
    print("删除了 " + str(before_count - after_count) + " 个NewContentRollup_节点")
    
    # 对每个节点的added属性进行去重和升序排序
    print("\n处理added属性，进行去重和升序排序...")
    processed_count = 0
    for item in formatted_data:
        if len(item) > 1 and 'value' in item[1]:
            # 解析value字符串
            try:
                value_data = json.loads(item[1]['value'])
                # 检查是否有added属性
                if 'added' in value_data and isinstance(value_data['added'], list):
                    # 去重并排序
                    unique_sorted = sorted(set(value_data['added']))
                    value_data['added'] = unique_sorted
                    # 更新value字符串，保持原始字符编码
                    item[1]['value'] = json.dumps(value_data, ensure_ascii=False)
                    processed_count += 1
            except (json.JSONDecodeError, TypeError, AttributeError) as e:
                pass  # 忽略解析错误
    
    print("处理了 " + str(processed_count) + " 个节点的added属性")
    
    # 移除value字段不是有效JSON格式的节点
    print("\n检查并移除无效的JSON节点...")
    before_count = len(formatted_data)
    valid_items = []
    
    for item in formatted_data:
        is_valid = True
        if len(item) > 1 and 'value' in item[1]:
            try:
                # 尝试解析value字段
                json.loads(item[1]['value'])
            except json.JSONDecodeError:
                # 如果解析失败，标记为无效
                print("移除无效节点: " + item[0])
                is_valid = False
        
        if is_valid:
            valid_items.append(item)
    
    formatted_data = valid_items
    after_count = len(formatted_data)
    print("移除了 " + str(before_count - after_count) + " 个无效节点")
    
    # 写入合并后的文件，使用缩进格式化
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(formatted_data, f, indent=2, ensure_ascii=False)
    
    print("\n合并完成！最终文件包含 " + str(len(formatted_data)) + " 个条目")
    print("输出文件: " + str(output_file))
    
    # 步骤2: 执行AutoCat分类
    print("\n=== 步骤2: 执行AutoCat自动分类 ===")
    
    # 从合并后的数据中提取游戏信息
    games_data = extract_games_from_merged_data(formatted_data)
    
    # 创建并配置AutoCat分类器
    auto_cat = configure_autocat_classifier(games_data)
    
    # 执行分类
    classification_results = auto_cat.autocategorize()
    
    # 输出分类结果
    print_classification_results(classification_results, auto_cat)
    
    # 步骤3: 生成分类后的配置
    print("\n=== 步骤3: 生成分类后的配置 ===")
    
    categorized_data = generate_categorized_config(formatted_data, auto_cat)
    
    # 写入分类后的文件
    with open(categorized_output, 'w', encoding='utf-8') as f:
        json.dump(categorized_data, f, indent=2, ensure_ascii=False)
    
    print(f"分类后的配置已保存到: {categorized_output}")
    
    # 步骤4: 输出统计信息
    print("\n=== 步骤4: 统计信息 ===")
    
    stats = auto_cat.get_statistics()
    print(f"总游戏数: {stats['total_games']}")
    print(f"总分类数: {stats['total_categories']}")
    print(f"\n分类分布:")
    
    # 按游戏数量排序分类
    sorted_categories = sorted(stats['category_distribution'].items(), 
                               key=lambda x: x[1], reverse=True)
    
    for i, (category, count) in enumerate(sorted_categories[:10]):  # 显示前10个
        print(f"  {i+1:2d}. {category}: {count} 个游戏")
    
    if len(sorted_categories) > 10:
        print(f"  ... 还有 {len(sorted_categories) - 10} 个分类")
    
    # 输出所有节点的name属性
    print("\n所有节点的name属性:")
    print("=" * 50)
    
    # 收集所有name属性并排序
    names = []
    for item in formatted_data:
        if len(item) > 1 and 'value' in item[1]:
            try:
                value_data = json.loads(item[1]['value'])
                if 'name' in value_data:
                    names.append(value_data['name'])
            except:
                pass
    
    # 按名称排序并输出
    sorted_names = sorted(names)
    for i in range(len(sorted_names)):
        name = sorted_names[i]
        print("{0:3d}. {1}".format(i+1, name))
    
    print("=" * 50)
    print("共 " + str(len(names)) + " 个name属性")

def extract_games_from_merged_data(merged_data: List) -> Dict[int, Dict[str, Any]]:
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
                    game_id = extract_game_id_from_node_name(node_name)
                    
                    if game_id:
                        games_data[game_id] = {
                            'name': value_data.get('name', ''),
                            'tags': extract_tags_from_value(value_data),
                            'node_name': node_name,
                            'value_data': value_data
                        }
            except json.JSONDecodeError:
                continue
    
    logger.info(f"从合并数据中提取了 {len(games_data)} 个游戏")
    return games_data

def extract_game_id_from_node_name(node_name: str) -> Optional[int]:
    """从节点名称中提取游戏ID"""
    # 尝试不同的模式来提取游戏ID
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

def extract_tags_from_value(value_data: Dict) -> List[str]:
    """从value数据中提取标签"""
    tags = []
    
    # 从name字段提取可能的标签
    if 'name' in value_data:
        name = value_data['name'].lower()
        
        # 常见游戏类型关键词
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

def configure_autocat_classifier(games_data: Dict[int, Dict[str, Any]]) -> DepressurizerAutoCat:
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
        ignored_genres=['indie']  # 忽略独立游戏类型
    )
    auto_cat.add_auto_cat(auto_cat_genre)
    
    # 2. 基于标签的分类器
    auto_cat_tags = AutoCatTags(
        name="标签分类",
        prefix="标签-",
        included_tags=None,  # 包含所有标签
        max_tags=5
    )
    auto_cat.add_auto_cat(auto_cat_tags)
    
    # 3. 基于年份的分类器（尝试从名称中提取年份）
    auto_cat_year = AutoCatYear(
        name="年份分类",
        prefix="年份-"
    )
    auto_cat.add_auto_cat(auto_cat_year)
    
    return auto_cat

def print_classification_results(results: Dict, auto_cat: DepressurizerAutoCat):
    """打印分类结果"""
    print(f"\n分类结果:")
    print(f"总游戏数: {results['total_games']}")
    print(f"已处理游戏数: {results['processed_games']}")
    
    for cat_name, cat_result in results['auto_cat_results'].items():
        print(f"\n分类器 '{cat_name}':")
        print(f"  处理游戏数: {cat_result['processed']}")
        print(f"  成功率: {cat_result['success_rate']:.1%}")
    
    # 显示前几个游戏的分类结果
    print(f"\n前5个游戏的分类结果:")
    for i, (game_id, game) in enumerate(list(auto_cat.games.items())[:5]):
        print(f"\n{i+1}. {game.name} (ID: {game_id})")
        print(f"   分类: {game.get_cat_string()}")
        print(f"   标签: {', '.join(game.tags)}")

def generate_categorized_config(original_data: List, auto_cat: DepressurizerAutoCat) -> List:
    """生成分类后的配置"""
    categorized_data = []
    
    for item in original_data:
        if len(item) > 1 and 'value' in item[1]:
            try:
                value_data = json.loads(item[1]['value'])
                
                # 检查是否是游戏节点
                if 'name' in value_data and 'added' in value_data:
                    node_name = item[0]
                    game_id = extract_game_id_from_node_name(node_name)
                    
                    if game_id and game_id in auto_cat.games:
                        game = auto_cat.games[game_id]
                        
                        # 更新value数据，添加分类信息
                        if game.categories:
                            value_data['categories'] = list(game.categories)
                        
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
                        # 非游戏节点，保持原样
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

def main():
    """主函数"""
    print("=== 增强版Steam游戏库分类工具 ===")
    print("功能: 1) JSON文件合并 2) AutoCat自动分类 3) 分类结果导出")
    
    try:
        merge_all_custom_files_with_autocat()
        print("\n=== 处理完成 ===")
    except Exception as e:
        logger.error(f"处理过程中出现错误: {e}")
        print("\n=== 处理失败 ===")

if __name__ == "__main__":
    main()