# SteamDB游戏ID抓取使用说明

## 问题说明

SteamDB网站具有反爬虫机制，直接使用requests库可能会遇到403 Forbidden错误。为了解决这个问题，我们提供了两种解决方案：

## 解决方案1：使用有效的Cookies（推荐）

### 1. 获取有效的SteamDB Cookies

1. 使用浏览器（如Chrome）登录SteamDB网站
2. 按F12打开开发者工具
3. 切换到"Network"（网络）标签
4. 刷新页面
5. 在网络请求列表中选择任意一个请求
6. 在"Headers"（请求头）中找到"Cookie"字段
7. 复制Cookie内容

### 2. 配置Cookies文件

将获取到的cookies添加到 `json-config/support/cookies.txt` 文件中：

```
# 格式: key=value
sessionid=your_real_session_id_here
steamLoginSecure=your_real_steam_login_secure_here
```

### 3. 测试Cookies

运行测试脚本验证cookies是否有效：

```bash
python test_complete_functionality.py
```

## 解决方案2：使用Selenium浏览器自动化

### 1. 安装依赖

```bash
pip install selenium
```

### 2. 下载ChromeDriver

1. 访问 https://chromedriver.chromium.org/
2. 下载与您Chrome浏览器版本匹配的ChromeDriver
3. 将ChromeDriver添加到系统PATH中

### 3. 修改代码启用Selenium

在[publisher_based_autocat.py](file:///e:/WorkSource/steam-py/steam-namespace/publisher_based_autocat.py)中设置：

```python
auto_cat = PublisherBasedAutoCat()
auto_cat.set_use_selenium(True)  # 启用Selenium
```

## 使用建议

1. **优先使用Cookies方案**：如果能获取到有效的SteamDB cookies，这是最简单和高效的方法
2. **备选Selenium方案**：如果无法获取cookies，可以使用Selenium，但需要额外安装依赖
3. **遵守网站规则**：请合理设置请求间隔，避免对网站造成过大压力

## 常见问题

### 1. 403 Forbidden错误

原因：缺少有效的cookies或触发了反爬虫机制
解决：使用上述两种方案之一

### 2. Selenium相关错误

原因：未安装Selenium或ChromeDriver配置不正确
解决：确保正确安装依赖并配置ChromeDriver

### 3. 获取不到游戏ID

原因：页面结构可能发生变化
解决：检查SteamDB页面结构并调整解析逻辑