import json
import os
import re
from pathlib import Path

def parse_custom_json(content):
    """解析custom文件的特殊格式"""
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

def merge_all_custom_files():
    """合并所有custom文件夹中的JSON文件"""
    custom_dir = Path('json-config/custom')
    output_file = Path('json-config/formatted-cloud-storage-namespace.json')
    
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
        new_items = [item for item in custom_data if item[0] not in existing_keys]
        
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

if __name__ == "__main__":
    merge_all_custom_files()