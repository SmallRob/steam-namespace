import pandas as pd
import requests
import time
import json
import urllib3
import sys
import os
from pathlib import Path
from datetime import datetime

# 禁用SSL警告
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

def get_steam_game_info(app_id):
    """ 通过Steam API获取游戏信息 """
    url = f"https://store.steampowered.com/api/appdetails?appids={app_id}"
    
    try:
        # 发送请求（禁用SSL验证以解决证书问题）
        response = requests.get(url, timeout=10, verify=False)
        response.raise_for_status()
        
        data = response.json()
        
        # 检查API是否返回了有效数据
        if str(app_id) in data and data[str(app_id)]['success']:
            game_data = data[str(app_id)]['data']
            
            # 提取基本信息
            name = game_data.get('name', 'N/A')
            
            # 提取价格信息（处理免费游戏和打折情况）
            price_info = game_data.get('price_overview', {})
            if price_info:
                # 原价（分转元/美元）
                price_original = price_info.get('initial', 0) / 100
                # 折后价
                price_final = price_info.get('final', 0) / 100
                # 折扣百分比
                discount = price_info.get('discount_percent', 0)
                # 货币符号
                currency = price_info.get('currency', 'USD')
                
                if price_final == 0:
                    price_str = "免费"
                elif discount > 0:
                    price_str = f"{price_final:.2f} {currency} (-{discount}%)"
                else:
                    price_str = f"{price_final:.2f} {currency}"
            else:
                # 可能是免费游戏或价格信息不可用
                is_free = game_data.get('is_free', False)
                price_str = "免费" if is_free else "价格信息缺失"
                price_original = 0
                price_final = 0
                discount = 0
                currency = "N/A"
            
            # 提取评价信息
            recommendations = game_data.get('recommendations', {})
            total_recommendations = recommendations.get('total', 0)
            
            # Steam API的这个端点不提供好评率信息，所以统一返回N/A
            positive_ratio = "N/A"
            
            # 获取简短描述
            short_description = game_data.get('short_description', 'N/A')
            # 清理描述文本（移除HTML标签和换行符）
            if short_description != 'N/A':
                short_description = short_description.replace('<br>', ' ').replace('\r', ' ').replace('\n', ' ')
                # 截断过长的描述
                if len(short_description) > 150:
                    short_description = short_description[:147] + "..."
            
            # 获取发布日期
            release_date = game_data.get('release_date', {})
            release_date_str = release_date.get('date', 'N/A')
            # 如果日期存在，尝试格式化为YYYY-MM-DD格式
            if release_date_str != 'N/A':
                # 移除可能的多余空格
                release_date_str = release_date_str.strip()
                # 如果不是N/A，保持原样（Steam API通常已经提供合适的格式）
            
            # 获取开发者
            developers = game_data.get('developers', [])
            developer_str = ', '.join(developers) if developers else 'N/A'
            
            # 获取类型
            genres = game_data.get('genres', [])
            genre_list = [genre['description'] for genre in genres]
            genre_str = ', '.join(genre_list) if genre_list else 'N/A'
            
            # 获取游戏推荐配置（categories）
            categories = game_data.get('categories', [])
            category_list = [category['description'] for category in categories]
            category_str = ', '.join(category_list) if category_list else 'N/A'
            
            return {
                'app_id': app_id,
                '名称': name,
                '价格': price_str,
                '原价': price_original,
                '好评率': positive_ratio,
                '总评价数': total_recommendations,
                '发布日期': release_date_str,
                '开发商': developer_str,
                '类型': genre_str,
                '推荐配置': category_str,  # 新增推荐配置列
                'Steam链接': f"https://store.steampowered.com/app/{app_id}/"
            }
        else:
            return {
                'app_id': app_id,
                '名称': 'N/A',
                '价格': 'N/A',
                '原价': 0,
                '好评率': 'N/A',
                '总评价数': 0,
                '发布日期': 'N/A',
                '开发商': 'N/A',
                '类型': 'N/A',
                '推荐配置': 'N/A',
                'Steam链接': f"https://store.steampowered.com/app/{app_id}/"
            }
            
    except requests.exceptions.RequestException as e:
        print(f"请求出错 (ID: {app_id}): {e}")
        return {
            'app_id': app_id,
            '名称': 'N/A',
            '价格': 'N/A',
            '原价': 0,
            '好评率': 'N/A',
            '总评价数': 0,
            '发布日期': 'N/A',
            '开发商': 'N/A',
            '类型': 'N/A',
            '推荐配置': 'N/A',
            'Steam链接': f"https://store.steampowered.com/app/{app_id}/"
        }
    except Exception as e:
        print(f"处理出错 (ID: {app_id}): {e}")
        return {
            'app_id': app_id,
            '名称': 'N/A',
            '价格': 'N/A',
            '原价': 0,
            '好评率': 'N/A',
            '总评价数': 0,
            '发布日期': 'N/A',
            '开发商': 'N/A',
            '类型': 'N/A',
            '推荐配置': 'N/A',
            'Steam链接': f"https://store.steampowered.com/app/{app_id}/"
        }

def extract_collections_from_json(json_file_path):
    """从JSON配置文件中提取所有集合（分类）及其游戏ID"""
    collections = []
    try:
        with open(json_file_path, 'r', encoding='utf-8') as f:
            # 读取整个文件内容
            content = f.read()
            # 分割成独立的JSON对象数组
            json_objects = content.split('],[')
            
            # 处理第一个对象
            first_obj = json_objects[0][1:] if json_objects[0].startswith('[') else json_objects[0]
            json_objects[0] = first_obj
            
            # 处理最后一个对象
            last_index = len(json_objects) - 1
            last_obj = json_objects[last_index][:-1] if json_objects[last_index].endswith(']') else json_objects[last_index]
            json_objects[last_index] = last_obj
            
            # 解析每个JSON对象
            for json_str in json_objects:
                try:
                    data = json.loads(f"[{json_str}]")
                    # 检查是否是用户集合
                    if data[0].startswith("user-collections."):
                        # 解析"value"字段中的JSON字符串
                        value_data = json.loads(data[1]['value'])
                        collection_name = value_data.get('name', 'Unknown')
                        app_ids = value_data.get('added', [])
                        if app_ids:  # 只添加非空的集合
                            collections.append({
                                'name': collection_name,
                                'ids': app_ids
                            })
                except Exception as e:
                    # 跳过解析错误的对象
                    continue
                    
    except Exception as e:
        print(f"从JSON文件 {json_file_path} 读取集合时出错: {e}")
    
    return collections

def extract_app_ids_from_csv(csv_file_path):
    """从CSV文件中提取游戏ID"""
    try:
        df = pd.read_csv(csv_file_path)
        # 检查列名，适应不同的CSV格式
        if 'app_id' in df.columns:
            return df['app_id'].tolist()
        elif 'id' in df.columns:
            return df['id'].tolist()
        else:
            # 如果没有特定列名，假设第一列是ID
            return df.iloc[:, 0].tolist()
    except Exception as e:
        print(f"从CSV文件 {csv_file_path} 读取游戏ID时出错: {e}")
        return []

def process_collection_and_save(collection_name, app_ids):
    """处理单个集合的游戏信息并保存到CSV文件"""
    print(f"开始获取集合 '{collection_name}' 的Steam游戏信息...")
    
    # 确保output目录存在
    output_dir = Path('output')
    output_dir.mkdir(exist_ok=True)
    
    # 生成文件名
    safe_collection_name = "".join(c for c in collection_name if c.isalnum() or c in (' ', '-', '_')).rstrip()
    current_date = datetime.now().strftime('%Y-%m-%d')
    output_filename = f'output/{safe_collection_name}_{current_date}.csv'
    
    # 如果文件已存在，读取现有数据
    existing_data = []
    if os.path.exists(output_filename):
        try:
            existing_df = pd.read_csv(output_filename)
            existing_data = existing_df.to_dict('records')
            print(f"从现有文件加载了 {len(existing_data)} 条记录")
        except Exception as e:
            print(f"读取现有文件时出错: {e}")
    
    # 处理每个游戏ID
    total_games = len(app_ids)
    for i, app_id in enumerate(app_ids, 1):
        # 显示进度条
        progress = i / total_games
        bar_length = 50
        filled_length = int(bar_length * progress)
        bar = '█' * filled_length + '-' * (bar_length - filled_length)
        percent = round(100 * progress, 1)
        
        # \r 表示回到行首，end='' 表示不换行
        sys.stdout.write(f'\r进度: |{bar}| {percent}% ({i}/{total_games}) - 正在处理ID: {app_id}')
        sys.stdout.flush()
        
        # 获取游戏信息
        game_info = get_steam_game_info(app_id)
        
        # 添加到现有数据
        existing_data.append(game_info)
        
        # 立即保存到文件
        df_results = pd.DataFrame(existing_data)
        df_results.to_csv(output_filename, index=False, encoding='utf-8-sig')
        
        # 添加延迟以避免过于频繁的请求
        time.sleep(1)  # 增加延迟到1秒
    
    # 进度条完成后换行
    print()
    
    # 打印统计信息
    print(f"\n{'='*50}")
    print(f"集合 '{collection_name}' 处理完成！")
    print(f"总计: {len(app_ids)} 个游戏")
    print(f"{'='*50}")
    print(f"结果已保存到: {output_filename} (CSV格式)")
    
    # 显示前几个游戏作为示例
    if existing_data:
        print(f"\n前3个游戏示例:")
        for row in existing_data[:3]:
            print(f" - {row['名称']} (ID: {row['app_id']}): {row['价格']}, 好评率: {row['好评率']}")

def main():
    """ 主函数：从JSON配置文件和CSV文件中读取游戏ID并获取游戏信息 """
    print("开始获取Steam游戏信息...")
    
    # 处理json-config/custom目录下的所有JSON文件
    custom_dir = Path('json-config/custom')
    if custom_dir.exists():
        json_files = list(custom_dir.glob('*.json'))
        print(f"找到 {len(json_files)} 个JSON配置文件")
        
        for json_file in json_files:
            print(f"\n处理JSON文件: {json_file.name}")
            collections = extract_collections_from_json(json_file)
            print(f"从 {json_file.name} 提取到 {len(collections)} 个集合")
            
            # 处理每个集合
            for collection in collections:
                collection_name = collection['name']
                app_ids = collection['ids']
                print(f"\n处理集合: {collection_name} ({len(app_ids)} 个游戏)")
                process_collection_and_save(collection_name, app_ids)
    
    # 处理data目录下的CSV文件
    data_dir = Path('data')
    if data_dir.exists():
        csv_files = list(data_dir.glob('*.csv'))
        print(f"\n找到 {len(csv_files)} 个CSV文件")
        
        for csv_file in csv_files:
            print(f"\n处理CSV文件: {csv_file.name}")
            app_ids = extract_app_ids_from_csv(csv_file)
            if app_ids:
                # 使用文件名（不含扩展名）作为集合名称
                collection_name = csv_file.stem
                print(f"从 {csv_file.name} 提取到 {len(app_ids)} 个游戏ID")
                process_collection_and_save(collection_name, app_ids)
            else:
                print(f"CSV文件 {csv_file.name} 中没有找到游戏ID")

if __name__ == "__main__":
    main()