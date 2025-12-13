# 游戏详情获取脚本使用说明

## 功能概述

该脚本用于从Steam API获取游戏详情信息，并按照分类保存到CSV文件中。主要特点：

1. 从JSON配置文件和CSV文件中读取游戏ID
2. 按分类获取游戏信息
3. 每获取一个游戏信息就立即保存到CSV文件
4. 自动处理请求频率，避免被Steam限制

## 输入文件格式

### JSON配置文件格式

JSON配置文件包含多个集合，每个集合有：
- `name`: 集合名称（分类名称）
- `added`: 游戏ID数组

### CSV文件格式

CSV文件包含游戏ID列表，支持以下列名：
- `app_id`
- `id`
- 或第一列作为ID

## 输出文件格式

输出文件保存在`output`目录下，文件名格式为：
`{分类名称}_{日期}.csv`

CSV文件包含以下列：
- app_id: 游戏ID
- 名称: 游戏名称
- 价格: 当前价格
- 原价: 原始价格
- 好评率: 好评率（暂不可用）
- 总评价数: 评价总数
- 发布日期: 发布日期
- 开发商: 开发商
- 类型: 游戏类型
- 推荐配置: 推荐配置要求
- Steam链接: Steam商店链接

## 使用方法

1. 确保已安装依赖：
   ```
   pip install pandas requests
   ```

2. 运行主脚本：
   ```
   python get_game_details_byid.py
   ```

3. 运行测试脚本：
   ```
   python test/test_get_game_details.py
   python test/test_modified_script.py
   python test/test_small_collection.py
   ```

4. 查看输出文件：
   输出文件保存在`output`目录下

## 注意事项

1. 脚本会自动添加延迟以避免过于频繁的请求
2. 如果中途停止，可以重新运行脚本，会从已有的数据继续处理
3. 文件名中的特殊字符会被自动过滤