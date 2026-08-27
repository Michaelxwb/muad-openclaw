#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""健康体检报告（health-checkup-report）API 集中配置加载（Python 侧）。

供 branch*/ 与 scripts/ 下的 Python 脚本统一读取 `config/api_config.json`，
避免域名散落硬编码。功能与 Node 侧 `src/api_config.js` 对齐：

- get_origin(platform)        取平台 origin（协议+host+端口），env 覆盖
- get_host_header()           统一请求 Host 头（nginx 靠 Host 路由）
- get_endpoint(platform, key) 取完整 URL（origin + path）
- get_referer_path(platform)  取 referer 相对路径

用法：
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'shared'))
    from api_config_loader import get_origin, get_host_header, get_endpoint
"""

import json
import os

# skill 根目录（含 config/、shared/、scripts/、branch*/）
SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(SKILL_ROOT, "config", "api_config.json")

_CACHE = None


def load_api_config(force_reload=False):
    global _CACHE
    if _CACHE is not None and not force_reload:
        return _CACHE
    if not os.path.exists(CONFIG_PATH):
        raise RuntimeError(f"API 配置文件不存在: {CONFIG_PATH}")
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        _CACHE = json.load(f)
    return _CACHE


def _section(platform):
    cfg = load_api_config()
    platforms = cfg.get("platforms", {})
    if platform not in platforms:
        raise KeyError(f"api_config.json 缺少 platforms.{platform} 配置项")
    return platforms[platform]


def get_host_header():
    """取统一请求 Host 头；无配置时回退 inner.sangfor.com.cn。"""
    cfg = load_api_config()
    return str(cfg.get("host_header") or "inner.sangfor.com.cn")


def get_origin(platform):
    """取某平台 origin。优先平台级 env，其次配置文件 origin。"""
    section = _section(platform)
    env_name = section.get("env")
    if env_name:
        env_origin = os.environ.get(env_name)
        if env_origin:
            return str(env_origin).strip().rstrip("/")
    origin = section.get("origin")
    if not origin:
        raise KeyError(f"api_config.json 缺少 platforms.{platform}.origin 配置项")
    return str(origin).strip().rstrip("/")


def get_endpoint(platform, key):
    """取某平台某 endpoint 的完整 URL（origin + path）。"""
    section = _section(platform)
    endpoints = section.get("endpoints", {})
    if key not in endpoints:
        raise KeyError(f"api_config.json 缺少 platforms.{platform}.endpoints.{key} 配置项")
    return get_origin(platform) + str(endpoints[key])


def get_referer_path(platform):
    """取某平台 referer 相对路径（默认 /index.html）。"""
    section = _section(platform)
    return str(section.get("referer_path") or "/index.html")
