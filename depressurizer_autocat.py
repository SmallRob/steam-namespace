#!/usr/bin/env python3
"""
Depressurizer AutoCat Python脚本
基于Depressurizer项目的AutoCat分类算法优化的Steam游戏分类脚本
"""

import json
import os
import re
from pathlib import Path
from collections import defaultdict
from typing import List, Dict, Set, Any, Optional
from datetime import datetime
import logging

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class GameInfo:
    """游戏信息类，对应Depressurizer中的GameInfo"""
    
    def __init__(self, game_id: int, name: str = ""):
        self.id = game_id
        self.name = name
        self.categories: Set[str] = set()
        self.favorite = False
        self.hidden = False
        self.tags: List[str] = []
        self.genres: List[str] = []
        self.release_year: Optional[int] = None
        self.user_score: Optional[float] = None
    
    def add_category(self, category: str) -> None:
        """添加分类"""
        self.categories.add(category)
    
    def remove_category(self, category: str) -> None:
        """移除分类"""
        if category in self.categories:
            self.categories.remove(category)
    
    def contains_category(self, category: str) -> bool:
        """检查是否包含指定分类"""
        return category in self.categories
    
    def get_cat_string(self, uncategorized_text: str = "Uncategorized") -> str:
        """获取分类字符串，对应Depressurizer中的GetCatString方法"""
        if not self.categories:
            return uncategorized_text
        return ", ".join(sorted(self.categories))

class GameDB:
    """游戏数据库类，对应Depressurizer中的GameDB"""
    
    def __init__(self):
        self.games: Dict[int, Dict[str, Any]] = {}
        self.genres: Set[str] = set()
        self.tags: Set[str] = set()
    
    def load_from_steam_config(self, steam_config_path: str) -> None:
        """从Steam配置文件加载游戏数据"""
        try:
            with open(steam_config_path, 'r', encoding='utf-8') as f:
                config_data = json.load(f)
            
            # 解析Steam配置格式
            if 'UserLocalConfigStore' in config_data:
                self._parse_steam_config_v3(config_data)
            elif 'Software' in config_data:
                self._parse_steam_config_v2(config_data)
            
            logger.info(f"从Steam配置加载了 {len(self.games)} 个游戏")
        except Exception as e:
            logger.error(f"加载Steam配置失败: {e}")
    
    def _parse_steam_config_v3(self, config_data: Dict) -> None:
        """解析Steam V3配置格式"""
        try:
            if 'apps' in config_data['UserLocalConfigStore']:
                apps = config_data['UserLocalConfigStore']['apps']
                for app_id, app_data in apps.items():
                    try:
                        game_id = int(app_id)
                        if game_id > 0:  # 排除非游戏条目
                            self.games[game_id] = {
                                'name': app_data.get('name', ''),
                                'tags': app_data.get('tags', []),
                                'last_played': app_data.get('LastPlayed', 0),
                                'playtime': app_data.get('Playtime', 0)
                            }
                            
                            # 收集标签
                            if 'tags' in app_data:
                                self.tags.update(app_data['tags'])
                    except ValueError:
                        continue
        except Exception as e:
            logger.error(f"解析V3配置失败: {e}")
    
    def _parse_steam_config_v2(self, config_data: Dict) -> None:
        """解析Steam V2配置格式"""
        try:
            if 'apps' in config_data['Software']['Valve']['Steam']:
                apps = config_data['Software']['Valve']['Steam']['apps']
                for app_id, app_data in apps.items():
                    try:
                        game_id = int(app_id)
                        if game_id > 0:
                            self.games[game_id] = {
                                'name': app_data.get('name', ''),
                                'tags': app_data.get('tags', []),
                                'last_played': app_data.get('LastPlayed', 0),
                                'playtime': app_data.get('Playtime', 0)
                            }
                            
                            if 'tags' in app_data:
                                self.tags.update(app_data['tags'])
                    except ValueError:
                        continue
        except Exception as e:
            logger.error(f"解析V2配置失败: {e}")
    
    def get_name(self, game_id: int) -> str:
        """获取游戏名称"""
        if game_id in self.games:
            return self.games[game_id].get('name', '')
        return ""
    
    def get_tag_list(self, game_id: int) -> List[str]:
        """获取游戏标签列表"""
        if game_id in self.games:
            return self.games[game_id].get('tags', [])
        return []
    
    def get_all_genres(self) -> Set[str]:
        """获取所有类型集合"""
        return self.genres
    
    def get_all_tags(self) -> Set[str]:
        """获取所有标签集合"""
        return self.tags

class AutoCat:
    """自动分类基类，对应Depressurizer中的AutoCat抽象类"""
    
    def __init__(self, name: str):
        self.name = name
        self.games = None
        self.db = None
    
    def pre_process(self, games: Dict[int, GameInfo], db: GameDB) -> None:
        """预处理，对应Depressurizer中的PreProcess"""
        self.games = games
        self.db = db
    
    def categorize_game(self, game: GameInfo) -> bool:
        """分类游戏，对应Depressurizer中的CategorizeGame"""
        raise NotImplementedError("子类必须实现此方法")
    
    def de_process(self) -> None:
        """后处理，对应Depressurizer中的DeProcess"""
        self.games = None
        self.db = None

class AutoCatGenre(AutoCat):
    """基于游戏类型的自动分类，对应Depressurizer中的AutoCatGenre"""
    
    def __init__(self, name: str, prefix: str = "", max_categories: int = 0, 
                 remove_other_genres: bool = False, tag_fallback: bool = True, 
                 ignored_genres: Optional[List[str]] = None):
        super().__init__(name)
        self.prefix = prefix
        self.max_categories = max_categories
        self.remove_other_genres = remove_other_genres
        self.tag_fallback = tag_fallback
        self.ignored_genres = ignored_genres or []
        self.genre_categories: Set[str] = set()
    
    def pre_process(self, games: Dict[int, GameInfo], db: GameDB) -> None:
        super().pre_process(games, db)
        
        if self.remove_other_genres:
            # 准备要移除的类型分类列表
            genre_strings = db.get_all_genres()
            for genre in genre_strings:
                category_name = self.prefix + genre if self.prefix else genre
                self.genre_categories.add(category_name)
    
    def categorize_game(self, game: GameInfo) -> bool:
        if not self.games or not self.db:
            logger.error("AutoCatGenre: 游戏列表或数据库未初始化")
            return False
        
        if game.id not in self.db.games:
            return False
        
        # 移除其他类型分类（如果启用）
        if self.remove_other_genres:
            for category in list(game.categories):
                if category in self.genre_categories and category not in self.ignored_genres:
                    game.remove_category(category)
        
        # 获取游戏类型（这里简化处理，实际应该从数据库获取）
        game_genres = self._get_game_genres(game)
        
        if game_genres:
            added = 0
            for genre in game_genres:
                if genre not in self.ignored_genres:
                    category_name = self.prefix + genre if self.prefix else genre
                    game.add_category(category_name)
                    added += 1
                    
                    if self.max_categories > 0 and added >= self.max_categories:
                        break
            
            return True
        
        return False
    
    def _get_game_genres(self, game: GameInfo) -> List[str]:
        """获取游戏类型列表"""
        # 这里简化处理，实际应该根据游戏ID从数据库获取详细信息
        # 可以根据游戏名称、标签等信息推断类型
        
        # 从标签推断类型（标签回退机制）
        if self.tag_fallback and game.tags:
            return self._genres_from_tags(game.tags)
        
        return []
    
    def _genres_from_tags(self, tags: List[str]) -> List[str]:
        """从标签推断类型"""
        # 常见的游戏类型映射
        genre_mapping = {
            'action': ['action', 'shooter', 'fps', 'tps'],
            'rpg': ['rpg', 'role-playing'],
            'strategy': ['strategy', 'rts', 'tbs'],
            'adventure': ['adventure', 'point-and-click'],
            'simulation': ['simulation', 'sim'],
            'sports': ['sports', 'football', 'basketball'],
            'racing': ['racing', 'driving'],
            'puzzle': ['puzzle', 'logic'],
            'horror': ['horror', 'survival horror'],
            'indie': ['indie', 'independent']
        }
        
        detected_genres = []
        for tag in tags:
            tag_lower = tag.lower()
            for genre, genre_tags in genre_mapping.items():
                if any(genre_tag in tag_lower for genre_tag in genre_tags):
                    if genre not in detected_genres:
                        detected_genres.append(genre)
        
        return detected_genres

class AutoCatTags(AutoCat):
    """基于标签的自动分类，对应Depressurizer中的AutoCatTags"""
    
    def __init__(self, name: str, prefix: str = "", included_tags: Optional[Set[str]] = None, 
                 max_tags: int = 0):
        super().__init__(name)
        self.prefix = prefix
        self.included_tags = included_tags or set()
        self.max_tags = max_tags
    
    def categorize_game(self, game: GameInfo) -> bool:
        if not self.games or not self.db:
            logger.error("AutoCatTags: 游戏列表或数据库未初始化")
            return False
        
        if game.id not in self.db.games:
            return False
        
        game_tags = self.db.get_tag_list(game.id)
        
        if game_tags:
            added = 0
            for tag in game_tags:
                if not self.included_tags or tag in self.included_tags:
                    category_name = self.prefix + tag if self.prefix else tag
                    game.add_category(category_name)
                    added += 1
                    
                    if self.max_tags > 0 and added >= self.max_tags:
                        break
            
            return True
        
        return False

class AutoCatYear(AutoCat):
    """基于发行年份的自动分类，对应Depressurizer中的AutoCatYear"""
    
    def __init__(self, name: str, prefix: str = ""):
        super().__init__(name)
        self.prefix = prefix
    
    def categorize_game(self, game: GameInfo) -> bool:
        if not self.games or not self.db:
            logger.error("AutoCatYear: 游戏列表或数据库未初始化")
            return False
        
        # 这里简化处理，实际应该从数据库获取发行年份
        # 可以根据游戏名称、发布日期等信息推断年份
        year = self._infer_release_year(game)
        
        if year:
            category_name = self.prefix + str(year) if self.prefix else str(year)
            game.add_category(category_name)
            return True
        
        return False
    
    def _infer_release_year(self, game: GameInfo) -> Optional[int]:
        """推断发行年份"""
        # 从游戏名称中提取年份（如果有的话）
        if game.name:
            year_match = re.search(r'\b(19|20)\d{2}\b', game.name)
            if year_match:
                try:
                    return int(year_match.group())
                except ValueError:
                    pass
        
        # 其他推断方法...
        return None

class DepressurizerAutoCat:
    """Depressurizer自动分类主类"""
    
    def __init__(self):
        self.game_db = GameDB()
        self.games: Dict[int, GameInfo] = {}
        self.auto_cats: List[AutoCat] = []
    
    def load_steam_config(self, steam_config_path: str) -> None:
        """加载Steam配置文件"""
        logger.info(f"加载Steam配置文件: {steam_config_path}")
        self.game_db.load_from_steam_config(steam_config_path)
        
        # 创建GameInfo对象
        for game_id, game_data in self.game_db.games.items():
            game = GameInfo(game_id, game_data.get('name', ''))
            game.tags = game_data.get('tags', [])
            self.games[game_id] = game
        
        logger.info(f"加载了 {len(self.games)} 个游戏")
    
    def add_auto_cat(self, auto_cat: AutoCat) -> None:
        """添加自动分类器"""
        self.auto_cats.append(auto_cat)
    
    def autocategorize(self) -> Dict[str, Any]:
        """执行自动分类，对应Depressurizer中的Autocategorize方法"""
        logger.info("开始自动分类...")
        
        results = {
            'total_games': len(self.games),
            'processed_games': 0,
            'auto_cat_results': {}
        }
        
        for auto_cat in self.auto_cats:
            logger.info(f"执行分类器: {auto_cat.name}")
            
            # 预处理
            auto_cat.pre_process(self.games, self.game_db)
            
            # 分类游戏
            processed = 0
            for game in self.games.values():
                if auto_cat.categorize_game(game):
                    processed += 1
            
            # 后处理
            auto_cat.de_process()
            
            results['auto_cat_results'][auto_cat.name] = {
                'processed': processed,
                'success_rate': processed / len(self.games) if len(self.games) > 0 else 0
            }
            
            logger.info(f"分类器 {auto_cat.name} 处理了 {processed} 个游戏")
        
        results['processed_games'] = len(self.games)
        
        logger.info("自动分类完成")
        return results
    
    def export_to_steam_config(self, output_path: str) -> None:
        """导出为Steam配置文件格式"""
        logger.info(f"导出分类结果到: {output_path}")
        
        # 构建Steam配置格式
        steam_config = {
            "UserLocalConfigStore": {
                "apps": {}
            }
        }
        
        for game_id, game in self.games.items():
            steam_config["UserLocalConfigStore"]["apps"][str(game_id)] = {
                "name": game.name,
                "tags": list(game.categories) if game.categories else [],
                "LastPlayed": self.game_db.games[game_id].get('last_played', 0) if game_id in self.game_db.games else 0,
                "Playtime": self.game_db.games[game_id].get('playtime', 0) if game_id in self.game_db.games else 0
            }
        
        # 写入文件
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(steam_config, f, indent=2, ensure_ascii=False)
        
        logger.info(f"导出完成，共导出 {len(self.games)} 个游戏")
    
    def get_statistics(self) -> Dict[str, Any]:
        """获取分类统计信息"""
        stats = {
            'total_games': len(self.games),
            'total_categories': 0,
            'games_per_category': defaultdict(int),
            'category_distribution': {}
        }
        
        all_categories = set()
        for game in self.games.values():
            all_categories.update(game.categories)
            stats['games_per_category'][len(game.categories)] += 1
        
        stats['total_categories'] = len(all_categories)
        
        # 分类分布
        for category in all_categories:
            count = sum(1 for game in self.games.values() if category in game.categories)
            stats['category_distribution'][category] = count
        
        return stats

def parse_custom_json(content: str) -> List[Any]:
    """解析custom文件的特殊格式（保留原有功能）"""
    # 这个字符串是一个包含多个数组元素的连续字符串
    # 每个元素之间是],["这样的分隔符
    
    # 首先添加外层的方括号，使其成为一个完整的数组
    # 将],["替换成],["，这样就成了一个完整的JSON数组
    formatted_content = '[' + content.replace('][', '],[') + ']'
    
    try:
        # 尝试直接解析
        return json.loads(formatted_content)
    except json.JSONDecodeError:
        # 如果直接解析失败，我们使用更复杂的处理
        result = []
        
        # 分割成单独的条目
        # 找到所有的],["模式
        pattern = r'],\s*\['
        parts = re.split(pattern, content)
        
        # 如果分割结果只有一个部分，尝试另一种方法
        if len(parts) == 1:
            # 尝试手动分割条目
            # 找到所有的]["模式（可能没有逗号）
            pattern2 = r'\]\s*\['
            parts = re.split(pattern2, content)
            
            # 重新组合，添加逗号
            for i in range(len(parts)):
                if not parts[i].startswith('['):
                    parts[i] = '[' + parts[i]
                if not parts[i].endswith(']'):
                    parts[i] = parts[i] + ']'
        
        # 尝试更细致的分割方法，针对custom4.json的特殊格式
        if len(parts) <= 7:  # 如果解析出的条目太少
            # 尝试查找每个条目的开始位置
            entries = []
            pos = 0
            content_len = len(content)
            
            while pos < content_len:
                # 查找下一个条目的开始
                start_match = re.search(r'\[\"user-collections\.', content[pos:])
                if not start_match:
                    break
                
                start_pos = pos + start_match.start()
                # 查找下一个条目的开始或文件结尾
                next_match = re.search(r'\[\"user-collections\.', content[start_pos + 1:])
                if next_match:
                    end_pos = start_pos + 1 + next_match.start()
                    # 提取当前条目
                    entry = content[start_pos:end_pos]
                    # 确保以]结尾
                    if not entry.endswith(']'):
                        entry += ']'
                    entries.append(entry)
                    pos = end_pos
                else:
                    # 最后一个条目
                    entry = content[start_pos:]
                    if not entry.endswith(']'):
                        entry += ']'
                    entries.append(entry)
                    break
            
            parts = entries
        
        for part in parts:
            # 确保每个部分都有方括号
            if not part.startswith('['):
                part = '[' + part
            if not part.endswith(']'):
                part = part + ']'
                
            try:
                item = json.loads(part)
                result.append(item)
            except json.JSONDecodeError:
                # 如果还是失败，尝试修复一些常见问题
                try:
                    # 检查是否有多余的反斜杠
                    fixed_part = part.replace('\\', '\\\\')
                    item = json.loads(fixed_part)
                    result.append(item)
                except:
                    # 尝试修复缺少逗号的问题
                    try:
                        # 在引号后添加缺少的逗号
                        fixed_part = re.sub(r'"\s*"', '",', part)
                        item = json.loads(fixed_part)
                        result.append(item)
                    except:
                        # 尝试修复JSON值之间缺少逗号的问题
                        try:
                            # 在每个}"后添加缺少的逗号（如果后面跟着"）
                            fixed_part = re.sub(r'"}\s*"', '"},', part)
                            item = json.loads(fixed_part)
                            result.append(item)
                        except:
                            # 如果还是失败，尝试手动修复常见的格式问题
                            try:
                                # 修复value字段中的引号之间缺少逗号的问题
                                fixed_part = re.sub(r'"\\"id\\"[^"]+"\\"name\\"', r'\"id\", \"name\"', part)
                                fixed_part = re.sub(r'"\\"name\\"[^"]+"\\"added\\"', r'\"name\", \"added\"', part)
                                fixed_part = re.sub(r'"\\"added\\"[^"]+"\\"removed\\"', r'\"added\", \"removed\"', part)
                                # 在每个}"后添加逗号
                                fixed_part = re.sub(r'"\}\"\s*\"\w+\\"', r'\"}, \"', fixed_part)
                                item = json.loads(fixed_part)
                                result.append(item)
                            except:
                                print("无法解析部分: " + part[:100] + "...")
        
        return result

def main():
    """主函数"""
    # 配置路径
    steam_config_path = "C:\\Program Files (x86)\\Steam\\userdata\\<user_id>\\config\\localconfig.vdf"
    output_path = "steam_config_categorized.json"
    
    # 创建自动分类器
    auto_cat = DepressurizerAutoCat()
    
    # 加载Steam配置
    if os.path.exists(steam_config_path):
        auto_cat.load_steam_config(steam_config_path)
    else:
        logger.warning(f"Steam配置文件不存在: {steam_config_path}")
        # 使用示例数据
        logger.info("使用示例数据进行演示")
        
        # 创建示例游戏数据库
        auto_cat.game_db.games = {
            730: {'name': 'Counter-Strike: Global Offensive', 'tags': ['FPS', 'Action', 'Multiplayer']},
            570: {'name': 'Dota 2', 'tags': ['MOBA', 'Strategy', 'Free to Play']},
            440: {'name': 'Team Fortress 2', 'tags': ['FPS', 'Action', 'Class-Based']},
            220: {'name': 'Half-Life 2', 'tags': ['FPS', 'Action', 'Sci-fi']},
            400: {'name': 'Portal', 'tags': ['Puzzle', 'First-Person', 'Sci-fi']}
        }
        
        # 创建GameInfo对象
        for game_id, game_data in auto_cat.game_db.games.items():
            game = GameInfo(game_id, game_data.get('name', ''))
            game.tags = game_data.get('tags', [])
            auto_cat.games[game_id] = game
    
    # 添加自动分类器
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
        included_tags={'FPS', 'MOBA', 'Strategy', 'Action', 'Puzzle'},
        max_tags=2
    )
    auto_cat.add_auto_cat(auto_cat_tags)
    
    # 3. 基于年份的分类器
    auto_cat_year = AutoCatYear(
        name="年份分类",
        prefix="年份-"
    )
    auto_cat.add_auto_cat(auto_cat_year)
    
    # 执行自动分类
    results = auto_cat.autocategorize()
    
    # 输出结果
    print("\n=== 分类结果 ===")
    print(f"总游戏数: {results['total_games']}")
    print(f"已处理游戏数: {results['processed_games']}")
    
    for cat_name, cat_result in results['auto_cat_results'].items():
        print(f"\n分类器 '{cat_name}':")
        print(f"  处理游戏数: {cat_result['processed']}")
        print(f"  成功率: {cat_result['success_rate']:.1%}")
    
    # 获取统计信息
    stats = auto_cat.get_statistics()
    print(f"\n=== 统计信息 ===")
    print(f"总分类数: {stats['total_categories']}")
    print(f"\n游戏分类分布:")
    for cat_count, game_count in sorted(stats['games_per_category'].items()):
        print(f"  有 {cat_count} 个分类的游戏: {game_count} 个")
    
    # 导出结果
    auto_cat.export_to_steam_config(output_path)
    print(f"\n分类结果已导出到: {output_path}")
    
    # 显示前几个游戏的分类结果
    print(f"\n=== 前5个游戏的分类结果 ===")
    for i, (game_id, game) in enumerate(list(auto_cat.games.items())[:5]):
        print(f"\n{i+1}. {game.name} (ID: {game_id})")
        print(f"   分类: {game.get_cat_string()}")
        print(f"   标签: {', '.join(game.tags)}")

if __name__ == "__main__":
    main()