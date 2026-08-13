# Steam用户数据API扩展

基于steam.py库扩展的Steam用户数据获取API，与现有steam-namespace项目集成。

## 功能特性

### 用户数据获取
- **用户资料**: 获取用户基本信息、头像、个人资料URL等
- **游戏列表**: 获取用户拥有的所有游戏及游戏时间统计
- **好友列表**: 获取用户的好友信息
- **成就数据**: 获取用户在特定游戏中的成就完成情况
- **游戏统计**: 获取用户在特定游戏中的详细统计数据

### 数据导出
- **JSON格式**: 完整的用户数据导出
- **CSV格式**: 游戏列表、好友列表等表格数据
- **Excel格式**: 多工作表的数据导出（可选）

### 集成功能
- **与现有项目集成**: 结合现有的游戏详情获取功能
- **数据分析**: 用户游戏习惯分析
- **批量处理**: 支持批量获取多个用户数据

## 安装指南

### 1. 安装依赖

```bash
# 安装核心依赖
pip install -r requirements.txt

# 或者手动安装主要依赖
pip install steamio pandas requests beautifulsoup4
```

### 2. 配置API密钥

编辑 `steam_config.json` 文件，填入你的Steam Web API密钥：

```json
{
    "steam_api_key": "YOUR_STEAM_API_KEY_HERE",
    "default_output_dir": "output",
    "request_delay": 1.0,
    "max_retries": 3,
    "timeout": 30
}
```

**获取Steam Web API密钥:**
1. 访问 https://steamcommunity.com/dev/apikey
2. 使用你的Steam账户登录
3. 注册一个域名（可以使用localhost）
4. 获取API密钥

### 3. 获取Steam ID

用户的Steam ID是64位格式的数字，获取方法：
1. 访问用户的Steam个人资料页面
2. 查看URL中的数字ID
3. 或者使用 https://steamid.io/ 网站查询

## 使用示例

### 基础使用

```python
import asyncio
from steam_user_api import SteamUserAPI

async def main():
    api = SteamUserAPI("YOUR_API_KEY")
    
    try:
        await api.initialize()
        
        # 获取用户资料
        profile = await api.get_user_profile("76561198000000000")
        if profile:
            print(f"用户名: {profile.username}")
            print(f"个人资料: {profile.profile_url}")
        
        # 获取用户游戏
        games = await api.get_user_games("76561198000000000")
        print(f"游戏数量: {len(games)}")
        
        # 保存用户数据
        await api.save_user_data_to_json("76561198000000000")
        
    finally:
        await api.close()

asyncio.run(main())
```

### 集成使用

```python
import asyncio
from integration_example import SteamDataIntegration

async def main():
    integration = SteamDataIntegration("steam_config.json")
    
    try:
        await integration.initialize()
        
        # 获取综合数据
        data = await integration.get_comprehensive_user_data("76561198000000000")
        
        # 保存数据
        await integration.save_comprehensive_data("76561198000000000", data)
        
        # 分析数据
        analysis = await integration.analyze_user_data(data)
        print(analysis)
        
    finally:
        await integration.close()

asyncio.run(main())
```

## 文件说明

### 核心文件
- `steam_user_api.py` - Steam用户数据API核心模块
- `integration_example.py` - 集成示例代码
- `steam_config.json` - 配置文件
- `requirements.txt` - 依赖列表

### 现有项目文件
- `get_game_details_byid.py` - 游戏详情获取模块
- `publisher_based_autocat.py` - 基于供应商的分类工具
- `merge_all_custom.py` - 数据合并工具

## 注意事项

### 1. API限制
- Steam API有请求频率限制，建议设置合理的请求延迟
- 部分用户数据需要用户授权才能访问
- 隐私设置为"仅限好友"或"私密"的用户数据无法获取

### 2. 安全建议
- 不要将API密钥提交到版本控制系统
- 使用环境变量或配置文件存储敏感信息
- 定期更换API密钥

### 3. 错误处理
- 网络请求失败时会自动重试
- 详细的错误日志记录
- 优雅的异常处理机制

### 4. 性能优化
- 支持异步并发请求
- 可配置的请求延迟
- 批量数据处理支持

## 测试

```bash
# 运行测试
pytest test/

# 或者运行特定测试
python test/test_steam_user_api.py
```

## 扩展功能

### 自定义数据获取
可以通过继承 `SteamUserAPI` 类来添加自定义的数据获取功能：

```python
class CustomSteamAPI(SteamUserAPI):
    async def get_custom_data(self, steam_id):
        # 自定义数据获取逻辑
        pass
```

### 数据格式转换
支持将数据转换为多种格式：

```python
# 转换为Pandas DataFrame
df = pd.DataFrame(games_data)

# 转换为CSV
df.to_csv('games.csv', index=False)

# 转换为Excel
df.to_excel('games.xlsx', index=False)
```

## 常见问题

### Q: 为什么获取不到某些用户的数据？
A: 可能的原因：
1. 用户隐私设置限制
2. 用户已将账户设为私密
3. 需要用户授权才能访问
4. API密钥权限不足

### Q: 如何提高数据获取速度？
A: 优化建议：
1. 使用异步并发请求
2. 合理设置请求延迟
3. 批量处理多个用户
4. 缓存已获取的数据

### Q: 支持哪些数据格式？
A: 目前支持：
1. JSON格式（完整数据）
2. CSV格式（表格数据）
3. Excel格式（多工作表）

## 更新日志

### v1.0.0 (2026-06-27)
- 初始版本发布
- 实现基础用户数据获取功能
- 支持JSON和CSV格式导出
- 集成现有游戏详情获取功能

## 许可证

MIT License

## 贡献指南

欢迎提交Issue和Pull Request来改进这个项目。

## 联系方式

如有问题，请通过GitHub Issues联系我们。