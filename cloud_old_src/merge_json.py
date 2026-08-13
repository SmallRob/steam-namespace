import json

def parse_custom_json(content):
    """解析custom.json的特殊格式"""
    # 这个字符串看起来是一个包含多个数组元素的连续字符串
    # 我们需要找到每个数组元素的开始和结束
    
    result = []
    i = 0
    n = len(content)
    
    while i < n:
        # 找到下一个条目的开始
        if i >= n or content[i] != '[':
            break
            
        # 开始解析一个条目
        start = i
        bracket_count = 0
        in_string = False
        escape_next = False
        
        while i < n:
            char = content[i]
            
            if escape_next:
                escape_next = False
                i += 1
                continue
                
            if char == '\\':
                escape_next = True
                i += 1
                continue
                
            if char == '"' and not escape_next:
                in_string = not in_string
                i += 1
                continue
                
            if not in_string:
                if char == '[':
                    bracket_count += 1
                elif char == ']':
                    bracket_count -= 1
                    if bracket_count == 0:
                        # 找到完整的条目
                        i += 1
                        break
            
            i += 1
        
        if bracket_count == 0:
            item_str = content[start:i]
            try:
                item = json.loads(item_str)
                result.append(item)
            except json.JSONDecodeError as e:
                print(f"解析错误: {e}")
                print(f"尝试解析的字符串: {item_str[:100]}...")
    
    return result

# 读取文件
with open('e:/WorkSource/steam-py/steam-namespace/json-config/custom.json', 'r', encoding='utf-8') as f:
    custom_content = f.read()

# 解析custom.json
custom_data = parse_custom_json(custom_content)
print(f"成功解析custom.json，包含{len(custom_data)}个条目")

# 读取并解析formatted-cloud-storage-namespace.json文件
with open('e:/WorkSource/steam-py/steam-namespace/json-config/formatted-cloud-storage-namespace.json', 'r', encoding='utf-8') as f:
    formatted_data = json.load(f)

# 将custom_data添加到formatted_data中
# 首先检查是否有重复的key
existing_keys = [item[0] for item in formatted_data]
new_items = [item for item in custom_data if item[0] not in existing_keys]

# 合并数据
merged_data = formatted_data + new_items

# 写入合并后的文件，使用缩进格式化
with open('e:/WorkSource/steam-py/steam-namespace/json-config/formatted-cloud-storage-namespace.json', 'w', encoding='utf-8') as f:
    json.dump(merged_data, f, indent=2, ensure_ascii=False)

print(f'成功合并文件。原始条目数: {len(formatted_data)}, 新增条目数: {len(new_items)}, 总条目数: {len(merged_data)}')