#!/usr/bin/env python3
"""
Steam用户数据API扩展模块
基于Steam Web API实现对Steam用户数据的获取

使用的Steam Web API接口：
- ISteamUser/GetPlayerSummaries       获取用户资料信息
- IPlayerService/GetOwnedGames        获取用户游戏列表
- ISteamUser/GetFriendList            获取用户好友列表
- ISteamUserStats/GetPlayerAchievements  获取用户游戏成就
- ISteamUserStats/GetUserStatsForGame 获取用户游戏统计
- ISteamUser/ResolveVanityURL         通过自定义URL获取Steam ID

注意：大部分接口需要：
1. Steam Web API密钥（在 https://steamcommunity.com/dev/apikey 申请）
2. 用户资料设置为公开
"""

import json
import time
import logging
import requests
import urllib3
from typing import Dict, List, Optional, Any, Union
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

# 禁用SSL警告
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# ============================================================
# 数据模型
# ============================================================

@dataclass
class SteamUserProfile:
    """Steam用户资料数据类"""
    steam_id: str = ""
    username: str = ""
    real_name: Optional[str] = None
    avatar_url: str = ""
    avatar_medium: str = ""
    avatar_full: str = ""
    profile_url: str = ""
    country_code: Optional[str] = None
    state_code: Optional[str] = None
    city_id: Optional[int] = None
    member_since: Optional[str] = None
    last_logoff: Optional[str] = None
    persona_state: int = 0
    persona_state_text: str = ""
    game_id: Optional[int] = None
    game_name: Optional[str] = None
    game_server_ip: Optional[str] = None
    game_server_steam_id: Optional[str] = None
    community_visibility_state: int = 0
    profile_state: Optional[int] = None
    comment_permission: Optional[int] = None

@dataclass
class SteamUserGame:
    """Steam用户游戏数据类"""
    app_id: int = 0
    name: str = ""
    playtime_forever: int = 0
    playtime_2weeks: Optional[int] = 0
    img_icon_url: str = ""
    has_community_visible_stats: bool = False
    rtime_last_played: Optional[int] = 0

@dataclass
class SteamUserAchievement:
    """Steam用户成就数据类"""
    app_id: int = 0
    achievement_name: str = ""
    achieved: bool = False
    unlock_time: Optional[int] = 0
    description: str = ""

@dataclass
class SteamUserGameStats:
    """Steam用户游戏统计数据类"""
    app_id: int = 0
    game_name: str = ""
    stats: Dict[str, Any] = field(default_factory=dict)
    achievements: List[SteamUserAchievement] = field(default_factory=list)

@dataclass
class SteamFriendInfo:
    """Steam好友信息数据类"""
    steam_id: str = ""
    username: str = ""
    avatar_url: str = ""
    profile_url: str = ""
    persona_state: int = 0
    friend_since: Optional[int] = 0
    relationship: str = ""
    game_id: Optional[int] = None
    game_name: Optional[str] = None

# ============================================================
# 状态码映射
# ============================================================

PERSONA_STATE_MAP = {
    0: "离线",
    1: "在线",
    2: "忙碌",
    3: "离开",
    4: "打盹",
    5: "想交易",
    6: "想玩"
}

VISIBILITY_STATE_MAP = {
    1: "私密",
    2: "仅限好友可见",
    3: "公开"
}


# ============================================================
# Steam Web API客户端
# ============================================================

class SteamWebAPIClient:
    """
    Steam Web API底层客户端
    封装所有对Steam Web API的HTTP请求
    """

    BASE_URL = "https://api.steampowered.com"

    def __init__(self, api_key: str, request_delay: float = 0.5,
                 max_retries: int = 3, timeout: int = 30):
        """
        初始化API客户端

        Args:
            api_key: Steam Web API密钥
            request_delay: 请求间隔（秒），防止触发频率限制
            max_retries: 请求失败最大重试次数
            timeout: 请求超时时间（秒）
        """
        self.api_key = api_key
        self.request_delay = request_delay
        self.max_retries = max_retries
        self.timeout = timeout
        self.session = requests.Session()
        self.session.verify = False
        self._last_request_time = 0

    def _throttle(self):
        """请求节流，确保请求间隔不低于指定时间"""
        elapsed = time.time() - self._last_request_time
        if elapsed < self.request_delay:
            time.sleep(self.request_delay - elapsed)
        self._last_request_time = time.time()

    def _request(self, interface: str, method: str, version: str = "v1",
                 params: Optional[Dict] = None) -> Optional[Dict]:
        """
        发送API请求

        Args:
            interface: API接口名（如 ISteamUser）
            method: 方法名（如 GetPlayerSummaries）
            version: 版本号（如 v2）
            params: 额外查询参数

        Returns:
            dict: API响应JSON，失败返回None
        """
        url = f"{self.BASE_URL}/{interface}/{method}/{version}/"

        all_params = {"key": self.api_key}
        if params:
            all_params.update(params)

        for attempt in range(1, self.max_retries + 1):
            self._throttle()
            try:
                resp = self.session.get(url, params=all_params, timeout=self.timeout)
                resp.raise_for_status()
                return resp.json()
            except requests.exceptions.RequestException as e:
                logger.warning(f"请求失败 (第{attempt}次): {e}")
                if attempt < self.max_retries:
                    time.sleep(2 ** attempt)
                else:
                    logger.error(f"请求最终失败: {url} - {e}")
                    return None

    def get_player_summaries(self, steam_ids: List[str]) -> Optional[Dict]:
        """
        获取玩家摘要信息

        Args:
            steam_ids: Steam ID列表（最多100个）

        Returns:
            dict: 包含players列表的字典
        """
        if len(steam_ids) > 100:
            logger.warning("单次最多查询100个Steam ID，将截断")
            steam_ids = steam_ids[:100]

        return self._request(
            "ISteamUser", "GetPlayerSummaries", "v2",
            {"steamids": ",".join(steam_ids)}
        )

    def get_owned_games(self, steam_id: str, include_appinfo: bool = True,
                        include_played_free_games: bool = True) -> Optional[Dict]:
        """
        获取用户拥有的游戏列表

        Args:
            steam_id: Steam ID
            include_appinfo: 是否包含游戏信息（名称、图标等）
            include_played_free_games: 是否包含玩过的免费游戏

        Returns:
            dict: 包含game_count和games列表的字典
        """
        return self._request(
            "IPlayerService", "GetOwnedGames", "v1",
            {
                "steamid": steam_id,
                "include_appinfo": 1 if include_appinfo else 0,
                "include_played_free_games": 1 if include_played_free_games else 0,
                "format": "json"
            }
        )

    def get_friend_list(self, steam_id: str, relationship: str = "friend") -> Optional[Dict]:
        """
        获取用户好友列表

        Args:
            steam_id: Steam ID
            relationship: 关系类型（friend）

        Returns:
            dict: 包含friendslist的字典
        """
        return self._request(
            "ISteamUser", "GetFriendList", "v1",
            {"steamid": steam_id, "relationship": relationship}
        )

    def get_player_achievements(self, steam_id: str, app_id: int,
                                 language: str = "schinese") -> Optional[Dict]:
        """
        获取用户特定游戏的成就

        Args:
            steam_id: Steam ID
            app_id: 游戏App ID
            language: 语言（默认简体中文）

        Returns:
            dict: 包含成就信息的字典
        """
        return self._request(
            "ISteamUserStats", "GetPlayerAchievements", "v1",
            {"steamid": steam_id, "appid": app_id, "l": language}
        )

    def get_user_stats_for_game(self, steam_id: str, app_id: int) -> Optional[Dict]:
        """
        获取用户特定游戏的统计信息

        Args:
            steam_id: Steam ID
            app_id: 游戏App ID

        Returns:
            dict: 包含统计数据的字典
        """
        return self._request(
            "ISteamUserStats", "GetUserStatsForGame", "v2",
            {"steamid": steam_id, "appid": app_id}
        )

    def get_player_achievements_global(self, app_id: int,
                                        language: str = "schinese") -> Optional[Dict]:
        """
        获取游戏的全局成就信息

        Args:
            app_id: 游戏App ID
            language: 语言

        Returns:
            dict: 包含全局成就百分比的字典
        """
        return self._request(
            "ISteamUserStats", "GetGlobalAchievementPercentagesForApp", "v2",
            {"gameid": app_id}
        )

    def resolve_vanity_url(self, vanity_url: str) -> Optional[Dict]:
        """
        通过自定义URL获取Steam ID

        Args:
            vanity_url: 用户自定义URL

        Returns:
            dict: 包含steamid的字典
        """
        return self._request(
            "ISteamUser", "ResolveVanityURL", "v1",
            {"vanityurl": vanity_url}
        )

    def get_schema_for_game(self, app_id: int,
                             language: str = "schinese") -> Optional[Dict]:
        """
        获取游戏的成就/统计架构信息

        Args:
            app_id: 游戏App ID
            language: 语言

        Returns:
            dict: 包含游戏成就和统计定义的字典
        """
        return self._request(
            "ISteamUserStats", "GetSchemaForGame", "v2",
            {"appid": app_id, "l": language}
        )

    def get_recently_played_games(self, steam_id: str,
                                   count: int = 5) -> Optional[Dict]:
        """
        获取用户最近玩过的游戏

        Args:
            steam_id: Steam ID
            count: 返回数量（默认5，最多50）

        Returns:
            dict: 包含最近游戏列表的字典
        """
        return self._request(
            "IPlayerService", "GetRecentlyPlayedGames", "v1",
            {"steamid": steam_id, "count": min(count, 50)}
        )

    def get_player_badges(self, steam_id: str) -> Optional[Dict]:
        """
        获取用户徽章信息

        Args:
            steam_id: Steam ID

        Returns:
            dict: 包含徽章信息的字典
        """
        return self._request(
            "IPlayerService", "GetBadges", "v1",
            {"steamid": steam_id}
        )

    def get_community_badge_progress(self, steam_id: str,
                                      badge_id: Optional[int] = None) -> Optional[Dict]:
        """
        获取社区徽章进度

        Args:
            steam_id: Steam ID
            badge_id: 徽章ID（可选）

        Returns:
            dict: 包含徽章任务进度的字典
        """
        params = {"steamid": steam_id}
        if badge_id is not None:
            params["badgeid"] = badge_id
        return self._request(
            "IPlayerService", "GetCommunityBadgeProgress", "v1", params
        )


# ============================================================
# 高级API封装
# ============================================================

class SteamUserAPI:
    """
    Steam用户数据高级API

    提供对Steam Web API的高级封装，返回结构化的数据对象。
    """

    def __init__(self, api_key: str, **kwargs):
        """
        初始化Steam用户API

        Args:
            api_key: Steam Web API密钥
            **kwargs: 传递给底层客户端的参数
        """
        if not api_key or api_key == "YOUR_STEAM_API_KEY_HERE" or len(api_key) < 10:
            raise ValueError(
                "请提供有效的Steam Web API密钥！\n"
                "申请地址: https://steamcommunity.com/dev/apikey"
            )
        self.client = SteamWebAPIClient(api_key, **kwargs)

    # ------ 用户资料 ------

    def get_user_profile(self, steam_id: Union[str, int]) -> Optional[SteamUserProfile]:
        """
        获取用户资料信息

        Args:
            steam_id: Steam ID（64位格式）

        Returns:
            SteamUserProfile: 用户资料对象，失败返回None
        """
        steam_id_str = str(steam_id)
        data = self.client.get_player_summaries([steam_id_str])

        if not data or "response" not in data:
            logger.error(f"获取用户资料失败: 无效的API响应")
            return None

        players = data["response"].get("players", [])
        if not players:
            logger.warning(f"未找到用户: {steam_id_str}")
            return None

        player = players[0]
        persona_state = player.get("personastate", 0)

        profile = SteamUserProfile(
            steam_id=steam_id_str,
            username=player.get("personaname", ""),
            real_name=player.get("realname"),
            avatar_url=player.get("avatar", ""),
            avatar_medium=player.get("avatarmedium", ""),
            avatar_full=player.get("avatarfull", ""),
            profile_url=player.get("profileurl", ""),
            country_code=player.get("loccountrycode"),
            state_code=player.get("locstatecode"),
            city_id=player.get("loccityid"),
            member_since=player.get("timecreated"),
            last_logoff=player.get("lastlogoff"),
            persona_state=persona_state,
            persona_state_text=PERSONA_STATE_MAP.get(persona_state, "未知"),
            game_id=player.get("gameid"),
            game_name=player.get("gameextrainfo"),
            game_server_ip=player.get("gameserverip"),
            game_server_steam_id=player.get("gameserversteamid"),
            community_visibility_state=player.get("communityvisibilitystate", 0),
            profile_state=player.get("profilestate"),
            comment_permission=player.get("commentpermission")
        )

        logger.info(f"成功获取用户资料: {profile.username} ({steam_id_str})")
        return profile

    # ------ 游戏列表 ------

    def get_user_games(self, steam_id: Union[str, int]) -> List[SteamUserGame]:
        """
        获取用户拥有的游戏列表

        Args:
            steam_id: Steam ID

        Returns:
            List[SteamUserGame]: 游戏列表
        """
        steam_id_str = str(steam_id)
        data = self.client.get_owned_games(steam_id_str)

        if not data or "response" not in data:
            logger.error(f"获取游戏列表失败: 无效的API响应")
            return []

        games_data = data["response"].get("games", [])
        games = []

        for g in games_data:
            icon_hash = g.get("img_icon_url", "")
            icon_url = f"https://media.steampowered.com/steamcommunity/public/images/apps/{g['appid']}/{icon_hash}.jpg" if icon_hash else ""

            game = SteamUserGame(
                app_id=g["appid"],
                name=g.get("name", ""),
                playtime_forever=g.get("playtime_forever", 0),
                playtime_2weeks=g.get("playtime_2weeks", 0),
                img_icon_url=icon_url,
                has_community_visible_stats=g.get("has_community_visible_stats", False),
                rtime_last_played=g.get("rtime_last_played", 0)
            )
            games.append(game)

        # 按游戏时间降序排序
        games.sort(key=lambda x: x.playtime_forever, reverse=True)
        logger.info(f"获取到 {len(games)} 个游戏")
        return games

    # ------ 最近游玩 ------

    def get_recently_played_games(self, steam_id: Union[str, int],
                                   count: int = 5) -> List[SteamUserGame]:
        """
        获取用户最近玩过的游戏

        Args:
            steam_id: Steam ID
            count: 返回数量（默认5）

        Returns:
            List[SteamUserGame]: 最近游戏列表
        """
        steam_id_str = str(steam_id)
        data = self.client.get_recently_played_games(steam_id_str, count)

        if not data or "response" not in data:
            return []

        games_data = data["response"].get("games", [])
        games = []
        for g in games_data:
            icon_hash = g.get("img_icon_url", "")
            icon_url = f"https://media.steampowered.com/steamcommunity/public/images/apps/{g['appid']}/{icon_hash}.jpg" if icon_hash else ""

            game = SteamUserGame(
                app_id=g["appid"],
                name=g.get("name", ""),
                playtime_forever=g.get("playtime_forever", 0),
                playtime_2weeks=g.get("playtime_2weeks", 0),
                img_icon_url=icon_url,
                rtime_last_played=g.get("rtime_last_played", 0)
            )
            games.append(game)

        return games

    # ------ 成就 ------

    def get_user_achievements(self, steam_id: Union[str, int],
                               app_id: int,
                               language: str = "schinese") -> List[SteamUserAchievement]:
        """
        获取用户特定游戏的成就

        Args:
            steam_id: Steam ID
            app_id: 游戏App ID
            language: 语言（默认简体中文）

        Returns:
            List[SteamUserAchievement]: 成就列表
        """
        steam_id_str = str(steam_id)
        data = self.client.get_player_achievements(steam_id_str, app_id, language)

        if not data or "playerstats" not in data:
            logger.warning(f"无法获取游戏 {app_id} 的成就数据（可能需要公开资料或游戏不支持）")
            return []

        playerstats = data["playerstats"]
        if not playerstats.get("success", False):
            logger.warning(f"获取成就失败: {playerstats.get('error', '未知错误')}")
            return []

        achievements = []
        for ach in playerstats.get("achievements", []):
            achievement = SteamUserAchievement(
                app_id=app_id,
                achievement_name=ach.get("apiname", ""),
                achieved=ach.get("achieved", 0) == 1,
                unlock_time=ach.get("unlocktime", 0),
                description=ach.get("name", ach.get("description", ""))
            )
            achievements.append(achievement)

        achieved_count = sum(1 for a in achievements if a.achieved)
        logger.info(f"游戏 {app_id} 成就: {achieved_count}/{len(achievements)} 已达成")
        return achievements

    # ------ 游戏统计 ------

    def get_user_game_stats(self, steam_id: Union[str, int],
                             app_id: int,
                             language: str = "schinese") -> Optional[SteamUserGameStats]:
        """
        获取用户特定游戏的统计数据

        Args:
            steam_id: Steam ID
            app_id: 游戏App ID
            language: 语言

        Returns:
            SteamUserGameStats: 统计数据对象
        """
        steam_id_str = str(steam_id)

        # 获取统计数据
        stats_data = self.client.get_user_stats_for_game(steam_id_str, app_id)
        stats = {}
        game_name = ""

        if stats_data and "playerstats" in stats_data:
            result = stats_data["playerstats"]
            game_name = result.get("gameName", "")
            for s in result.get("stats", []):
                stats[s["name"]] = s["value"]

        # 获取成就数据
        achievements = self.get_user_achievements(steam_id, app_id, language)

        return SteamUserGameStats(
            app_id=app_id,
            game_name=game_name,
            stats=stats,
            achievements=achievements
        )

    # ------ 好友列表 ------

    def get_user_friends(self, steam_id: Union[str, int]) -> List[SteamFriendInfo]:
        """
        获取用户好友列表

        Args:
            steam_id: Steam ID

        Returns:
            List[SteamFriendInfo]: 好友信息列表
        """
        steam_id_str = str(steam_id)
        data = self.client.get_friend_list(steam_id_str)

        if not data or "friendslist" not in data:
            logger.warning(f"无法获取好友列表（用户可能将资料设为私密）")
            return []

        friends_data = data["friendslist"].get("friends", [])
        friend_ids = [str(f["steamid"]) for f in friends_data]

        # 批量获取好友资料（每批最多100个）
        friend_profiles = {}
        for i in range(0, len(friend_ids), 100):
            batch = friend_ids[i:i + 100]
            summaries = self.client.get_player_summaries(batch)
            if summaries and "response" in summaries:
                for p in summaries["response"].get("players", []):
                    friend_profiles[str(p["steamid"])] = p

        friends = []
        for f in friends_data:
            fid = str(f["steamid"])
            profile = friend_profiles.get(fid, {})

            friend = SteamFriendInfo(
                steam_id=fid,
                username=profile.get("personaname", "未知"),
                avatar_url=profile.get("avatar", ""),
                profile_url=profile.get("profileurl", ""),
                persona_state=profile.get("personastate", 0),
                friend_since=f.get("friend_since", 0),
                relationship=f.get("relationship", "friend"),
                game_id=profile.get("gameid"),
                game_name=profile.get("gameextrainfo")
            )
            friends.append(friend)

        logger.info(f"获取到 {len(friends)} 个好友")
        return friends

    # ------ Steam ID 解析 ------

    def resolve_vanity_url(self, vanity_url: str) -> Optional[str]:
        """
        通过自定义URL获取Steam ID

        Args:
            vanity_url: 用户自定义URL（如 https://steamcommunity.com/id/XXXXX 中的 XXXXX）

        Returns:
            str: Steam ID，失败返回None
        """
        data = self.client.resolve_vanity_url(vanity_url)

        if data and "response" in data:
            resp = data["response"]
            if resp.get("success") == 1:
                return str(resp["steamid"])

        logger.warning(f"无法解析自定义URL: {vanity_url}")
        return None

    # ------ 徽章 ------

    def get_player_badges(self, steam_id: Union[str, int]) -> Optional[Dict]:
        """
        获取用户徽章信息

        Args:
            steam_id: Steam ID

        Returns:
            dict: 徽章信息
        """
        steam_id_str = str(steam_id)
        return self.client.get_player_badges(steam_id_str)

    # ------ 游戏架构（成就定义） ------

    def get_game_schema(self, app_id: int,
                        language: str = "schinese") -> Optional[Dict]:
        """
        获取游戏的成就/统计架构定义

        Args:
            app_id: 游戏App ID
            language: 语言

        Returns:
            dict: 游戏架构信息
        """
        return self.client.get_schema_for_game(app_id, language)

    # ------ 全局成就百分比 ------

    def get_global_achievement_percentages(self, app_id: int) -> Dict[str, float]:
        """
        获取游戏的全局成就达成百分比

        Args:
            app_id: 游戏App ID

        Returns:
            dict: {achievement_name: percent}
        """
        data = self.client.get_player_achievements_global(app_id)

        if not data or "achievementpercentages" not in data:
            return {}

        percentages = {}
        for ach in data["achievementpercentages"].get("achievements", []):
            percentages[ach["name"]] = ach["percent"]

        return percentages

    # ------ 综合数据获取 ------

    def get_comprehensive_user_data(self, steam_id: Union[str, int],
                                     fetch_achievements_for: Optional[List[int]] = None,
                                     max_games_for_achievements: int = 5) -> Dict[str, Any]:
        """
        获取用户综合数据

        Args:
            steam_id: Steam ID
            fetch_achievements_for: 指定要获取成就的游戏ID列表
            max_games_for_achievements: 自动获取成就的最大游戏数

        Returns:
            dict: 综合用户数据
        """
        steam_id_str = str(steam_id)
        logger.info(f"开始获取用户 {steam_id_str} 的综合数据...")

        # 获取用户资料
        profile = self.get_user_profile(steam_id)

        # 获取游戏列表
        games = self.get_user_games(steam_id)

        # 获取最近游玩
        recent_games = self.get_recently_played_games(steam_id, 10)

        # 获取好友列表
        friends = self.get_user_friends(steam_id)

        # 获取指定游戏的成就
        achievement_games = []
        if fetch_achievements_for:
            achievement_games = fetch_achievements_for
        elif games:
            # 默认获取游戏时间最长的几个游戏的成就
            achievement_games = [g.app_id for g in games[:max_games_for_achievements]]

        games_achievements = {}
        for app_id in achievement_games:
            try:
                achievements = self.get_user_achievements(steam_id, app_id)
                if achievements:
                    achieved = sum(1 for a in achievements if a.achieved)
                    games_achievements[app_id] = {
                        "total": len(achievements),
                        "achieved": achieved,
                        "percentage": round(achieved / len(achievements) * 100, 1) if achievements else 0,
                        "achievements": [asdict(a) for a in achievements]
                    }
            except Exception as e:
                logger.warning(f"获取游戏 {app_id} 的成就失败: {e}")

        # 统计信息
        total_playtime = sum(g.playtime_forever for g in games)
        recent_playtime = sum(g.playtime_2weeks or 0 for g in games)
        most_played = games[0] if games else None

        result = {
            "steam_id": steam_id_str,
            "fetch_time": datetime.now().isoformat(),
            "profile": asdict(profile) if profile else None,
            "games": {
                "total_count": len(games),
                "list": [asdict(g) for g in games]
            },
            "recent_games": {
                "total_count": len(recent_games),
                "list": [asdict(g) for g in recent_games]
            },
            "friends": {
                "total_count": len(friends),
                "list": [asdict(f) for f in friends]
            },
            "achievements": games_achievements,
            "statistics": {
                "total_playtime_minutes": total_playtime,
                "total_playtime_hours": round(total_playtime / 60, 1),
                "recent_playtime_minutes": recent_playtime,
                "recent_playtime_hours": round(recent_playtime / 60, 1),
                "total_games": len(games),
                "most_played_game": most_played.name if most_played else None,
                "most_played_game_time_hours": round(most_played.playtime_forever / 60, 1) if most_played else 0
            }
        }

        logger.info(
            f"用户 {steam_id_str} 数据获取完成: "
            f"{len(games)} 个游戏, "
            f"{len(friends)} 个好友, "
            f"总游戏时间 {total_playtime} 分钟"
        )

        return result

    # ------ 数据保存 ------

    def save_user_data_to_json(self, steam_id: Union[str, int],
                                output_dir: str = "output",
                                **kwargs) -> Optional[str]:
        """
        获取并保存用户综合数据到JSON文件

        Args:
            steam_id: Steam ID
            output_dir: 输出目录
            **kwargs: 传递给 get_comprehensive_user_data 的参数

        Returns:
            str: 保存的文件路径，失败返回None
        """
        try:
            output_path = Path(output_dir)
            output_path.mkdir(parents=True, exist_ok=True)

            data = self.get_comprehensive_user_data(steam_id, **kwargs)

            steam_id_str = str(steam_id)
            filename = output_path / f"user_{steam_id_str}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"

            with open(filename, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2, default=str)

            logger.info(f"用户数据已保存到: {filename}")
            return str(filename)

        except Exception as e:
            logger.error(f"保存用户数据失败: {e}")
            return None

    def save_user_games_to_csv(self, steam_id: Union[str, int],
                                output_dir: str = "output") -> Optional[str]:
        """
        获取并保存用户游戏列表到CSV文件

        Args:
            steam_id: Steam ID
            output_dir: 输出目录

        Returns:
            str: 保存的文件路径，失败返回None
        """
        try:
            import pandas as pd

            output_path = Path(output_dir)
            output_path.mkdir(parents=True, exist_ok=True)

            games = self.get_user_games(steam_id)

            if not games:
                logger.warning(f"没有游戏数据可保存")
                return None

            steam_id_str = str(steam_id)
            filename = output_path / f"user_games_{steam_id_str}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"

            games_data = []
            for g in games:
                games_data.append({
                    "App ID": g.app_id,
                    "游戏名称": g.name,
                    "总游戏时间(分钟)": g.playtime_forever,
                    "总游戏时间(小时)": round(g.playtime_forever / 60, 1),
                    "近两周(分钟)": g.playtime_2weeks or 0,
                    "上次游玩": datetime.fromtimestamp(g.rtime_last_played).strftime('%Y-%m-%d %H:%M:%S') if g.rtime_last_played else "",
                    "图标URL": g.img_icon_url
                })

            df = pd.DataFrame(games_data)
            df.to_csv(filename, index=False, encoding='utf-8-sig')

            logger.info(f"游戏列表已保存到: {filename}")
            return str(filename)

        except Exception as e:
            logger.error(f"保存游戏列表失败: {e}")
            return None


# ============================================================
# 便捷函数
# ============================================================

def get_steam_user_profile(api_key: str, steam_id: Union[str, int]) -> Optional[Dict]:
    """
    获取Steam用户资料的便捷函数

    Args:
        api_key: Steam Web API密钥
        steam_id: Steam ID

    Returns:
        dict: 用户资料字典
    """
    api = SteamUserAPI(api_key)
    profile = api.get_user_profile(steam_id)
    return asdict(profile) if profile else None


def get_steam_user_games(api_key: str, steam_id: Union[str, int]) -> List[Dict]:
    """
    获取Steam用户游戏列表的便捷函数

    Args:
        api_key: Steam Web API密钥
        steam_id: Steam ID

    Returns:
        list: 游戏列表
    """
    api = SteamUserAPI(api_key)
    games = api.get_user_games(steam_id)
    return [asdict(g) for g in games]


def resolve_steam_id(api_key: str, vanity_url: str) -> Optional[str]:
    """
    通过自定义URL解析Steam ID

    Args:
        api_key: Steam Web API密钥
        vanity_url: 用户自定义URL

    Returns:
        str: Steam ID
    """
    api = SteamUserAPI(api_key)
    return api.resolve_vanity_url(vanity_url)


# ============================================================
# 主函数 / 示例
# ============================================================

def main():
    """示例用法"""
    import sys

    print("=" * 60)
    print("Steam用户数据API - 示例程序")
    print("=" * 60)

    # 从配置文件读取API密钥
    config_file = Path("steam_config.json")
    if config_file.exists():
        with open(config_file, 'r', encoding='utf-8') as f:
            config = json.load(f)
        api_key = config.get("steam_api_key", "")
    else:
        api_key = ""

    if not api_key or api_key == "YOUR_STEAM_API_KEY_HERE":
        print("\n请先配置Steam Web API密钥！")
        print("1. 访问 https://steamcommunity.com/dev/apikey 申请API密钥")
        print("2. 将密钥填入 steam_config.json 文件")
        return

    api = SteamUserAPI(api_key)

    # 示例Steam ID（替换为你想查询的用户）
    example_steam_id = "76561198000000000"

    if len(sys.argv) > 1:
        arg = sys.argv[1]
        # 如果输入的是自定义URL，先解析
        if not arg.isdigit():
            print(f"正在解析自定义URL: {arg}")
            resolved = api.resolve_vanity_url(arg)
            if resolved:
                example_steam_id = resolved
                print(f"解析结果: {example_steam_id}")
            else:
                print(f"无法解析自定义URL: {arg}")
                return
        else:
            example_steam_id = arg

    print(f"\n正在查询 Steam ID: {example_steam_id}")
    print("-" * 40)

    # 获取用户资料
    profile = api.get_user_profile(example_steam_id)
    if profile:
        print(f"\n用户资料:")
        print(f"  用户名: {profile.username}")
        print(f"  真实姓名: {profile.real_name or '未公开'}")
        print(f"  个人资料: {profile.profile_url}")
        print(f"  在线状态: {profile.persona_state_text}")
        print(f"  国家/地区: {profile.country_code or '未公开'}")
        if profile.game_name:
            print(f"  当前游戏: {profile.game_name}")
    else:
        print("无法获取用户资料（可能需要公开资料设置或有效API密钥）")
        return

    # 获取游戏列表
    games = api.get_user_games(example_steam_id)
    if games:
        print(f"\n游戏库:")
        print(f"  游戏总数: {len(games)}")
        total_time = sum(g.playtime_forever for g in games)
        print(f"  总游戏时间: {total_time} 分钟 ({round(total_time/60, 1)} 小时)")

        print(f"\n  游戏时间排行前10:")
        for i, g in enumerate(games[:10], 1):
            hours = round(g.playtime_forever / 60, 1)
            print(f"  {i:2d}. {g.name} - {hours} 小时")

    # 获取最近游玩
    recent = api.get_recently_played_games(example_steam_id, 5)
    if recent:
        print(f"\n最近游玩:")
        for g in recent:
            hours = round(g.playtime_2weeks / 60, 1) if g.playtime_2weeks else 0
            print(f"  - {g.name} (近两周: {hours}小时)")

    # 保存数据
    print("\n正在保存数据...")
    json_path = api.save_user_data_to_json(example_steam_id, "output")
    csv_path = api.save_user_games_to_csv(example_steam_id, "output")

    if json_path:
        print(f"  JSON: {json_path}")
    if csv_path:
        print(f"  CSV:  {csv_path}")

    print("\n" + "=" * 60)
    print("数据获取完成！")


if __name__ == "__main__":
    main()
