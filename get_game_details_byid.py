import pandas as pd
import requests
import time
import json
import urllib3
import sys

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
            
            return {
                'app_id': app_id,
                '名称': name,
                '价格': price_str,
                '原价': price_original,
                '好评率': positive_ratio,
                '总评价数': total_recommendations,
                '发布日期': release_date_str,
                '开发商': developer_str,
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
            'Steam链接': f"https://store.steampowered.com/app/{app_id}/"
        }

def main():
    """ 主函数：读取CSV文件并获取所有游戏信息 """
    print("开始获取Steam游戏信息...")
    
    try:
        # 读取CSV文件
        # 假设CSV文件有一个名为'app_id'的列，或者每行只有一个ID
        df_ids = pd.read_csv('id.csv')
        
        # 检查列名，适应不同的CSV格式
        if 'app_id' in df_ids.columns:
            app_ids = df_ids['app_id'].tolist()
        elif 'id' in df_ids.columns:
            app_ids = df_ids['id'].tolist()
        else:
            # 如果没有特定列名，假设第一列是ID
            app_ids = df_ids.iloc[:, 0].tolist()
        
        print(f"从CSV文件中读取到 {len(app_ids)} 个游戏ID")
        
        # 存储所有游戏信息
        all_games_info = []
        
        # 逐个获取游戏信息
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
            
            game_info = get_steam_game_info(app_id)
            all_games_info.append(game_info)
        
        # 进度条完成后换行
        print()
        
        # 转换为DataFrame
        df_results = pd.DataFrame(all_games_info)
        
        # 保存到CSV文件（包含日期）
        from datetime import datetime
        current_date = datetime.now().strftime('%Y-%m-%d')
        output_filename = f'steam_games_info_{current_date}.csv'
        df_results.to_csv(output_filename, index=False, encoding='utf-8-sig')
        
        # 打印统计信息
        print(f"\n{'='*50}")
        print(f"处理完成！")
        print(f"总计: {len(app_ids)} 个游戏")
        print(f"{'='*50}")
        print(f"结果已保存到: {output_filename} (CSV格式)")
        
        # 显示前几个游戏作为示例
        if not df_results.empty:
            print(f"\n前5个游戏示例:")
            for _, row in df_results.head(5).iterrows():
                print(f" - {row['名称']} (ID: {row['app_id']}): {row['价格']}, 好评率: {row['好评率']}")
        
    except FileNotFoundError:
        print("错误: 未找到 'id.csv' 文件")
     