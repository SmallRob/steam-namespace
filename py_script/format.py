import json

with open(r'D:\Code\steam\Json\appids.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

appids = data['appids']
baseline = data.get('apps_baseline', {})

result = []
for idx, appid in enumerate(appids, start=1):
    name = baseline.get(appid, {}).get('name', '未知')
    result.append({
        "序号": idx,
        "date": "未知",
        "appid": int(appid),
        "name": name
    })

# 输出为每个对象一行的 JSON 数组（横板）
output_path = r'D:\Code\steam\Json\output.json'
with open(output_path, 'w', encoding='utf-8') as f:
    f.write('[\n')
    for i, item in enumerate(result):
        json_str = json.dumps(item, ensure_ascii=False)
        f.write('  ' + json_str)
        if i < len(result) - 1:
            f.write(',\n')
        else:
            f.write('\n')
    f.write(']')

print(f"✅ 已生成 output.json，共 {len(result)} 条记录")
print(f"   文件路径：{output_path}")