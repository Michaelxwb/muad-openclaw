"""
安全体检评分计算脚本
====================
根据评分表定义的计分逻辑，从本地 Excel 数据源读取数据，计算各项安全评分。

评分体系结构:
  总分 = 资产防护得分 × DEFAULT_ASSETS_RATIO + 日常运营得分 × (1-DEFAULT_ASSETS_RATIO)

  L1-资产防护得分 = 托管资产得分 × ASSETS_RATIO + 组件检测得分 × COMPONENTS_RATIO
  L1-日常运营得分 = 事件得分 × EVENTS_RATIO + 勒索风险得分 × VULNERABILITIES_RATIO

  L2-托管资产得分 = 服务器得分 × SERVER_RATIO + 终端得分 × PC_SCORE
  L2-组件检测得分 = 设备离线得分 × DEVICE_K + 策略隐患得分 × POLICY_K

  L3-服务器得分 = (a1+a2+a3)/(a1+a2+a3+a4) × 100
  L3-终端得分   = (b1+b2+b3)/(b1+b2+b3+b4) × 100
  L3-设备离线得分 = (d1-d2)/d1 × 100
  L3-策略隐患得分 = check_cnt>0 → (check_cnt-risk_cnt)/check_cnt, else 0

  L2-事件得分 = max(0, 100 - Σ每个资产扣分)
    服务器扣分 = SERVER_MAJOR_EVENT_K×严重 + SERVER_GENERAL_EVENT_K×高危
               + SERVER_OTHER_EVENT_K×中危 + SERVER_MAJOR_THREAT_K×低危
    非服务器扣分 = PC_MAJOR_EVENT_K×严重 + PC_GENERAL_EVENT_K×高危
                + PC_OTHER_EVENT_K×中危 + PC_MAJOR_THREAT_K×低危

  L2-勒索风险得分 = 漏洞得分×VULNERABILITY_K + 弱密码得分×WEAK_PASSWORD_K
                   + 端口得分×PORT_K

  L3-漏洞得分 = max(0, 100 - AGENT_FIX_VULN_K×va - FAST_FIX_VULN_K×vb - SUGGEST_FIX_VULN_K×vc)
  L3-端口得分 = max(0, 100 - RISK_PORT_K×rp)
  L3-弱密码得分 = 弱密码基础分 + 脆弱性事件分
    弱密码基础分 = max(0, 100-HIGH_LEVEL_WEAKPWD_K×wh-MIDDLE_LEVEL_WEAKPWD_K×wm
                      -LOW_LEVEL_WEAKPWD_K×wl-UNKNOWN_LEVEL_WEAKPWD_K×wu)
                  × WEAK_PASSWORD_BASE_K
    脆弱性事件分 = 事件扣分后得分 × (1-WEAK_PASSWORD_BASE_K)

用法:
    python scoring.py
    python scoring.py --config config.yaml
    python scoring.py --output result.json
"""

import argparse
import json
import os
import re

import yaml

from data_reader import load_data_sources

# ── 等级映射：将不同来源的等级文本统一 ──

# 得分等级分段（等级-颜色）：
#   优-绿色: 90-100
#   良-蓝色: 80-89
#   中-橙色: 60-79
#   差-红色: 60以下
SCORE_GRADE_RANGES = (
    (90, "优", "绿色"),
    (80, "良", "蓝色"),
    (60, "中", "橙色"),
    (-float("inf"), "差", "红色"),
)


def calc_grade(score: float) -> dict:
    """
    根据得分返回等级信息。

    分段:
      优-绿色: 90-100
      良-蓝色: 80-89
      中-橙色: 60-79
      差-红色: 60以下

    Returns:
        {"grade": "优"/"良"/"中"/"差", "color": "绿色"/"蓝色"/"橙色"/"红色"}
    """
    for threshold, grade, color in SCORE_GRADE_RANGES:
        if score >= threshold:
            return {"grade": grade, "color": color}
    return {"grade": "差", "color": "红色"}


LEVEL_MAPPING = {
    "event_level": {
        "严重": "critical",
        "高危": "high",
        "中危": "medium",
        "低危": "low",
    },
    "vuln_priority": {
        "急需修复": "urgent",
        "尽快修复": "fast",
        "按照风险等级来映射": "suggest",
        "建议修复": "suggest",
    },
    "vuln_risk_level": {
        "超危": "critical",
        "严重": "critical",
        "高危": "high",
        "中危": "medium",
        "低危": "low",
    },
    "weak_pwd_risk_level": {
        "严重": "critical",
        "高危": "high",
        "中危": "medium",
        "低危": "low",
    },
    "asset_type": {
        "服务器": "server",
        "终端": "pc",
        "其他": "other",
    },
}

# 设备类型映射：devType → 设备类别
# 网侧设备 = AF(3), SIP(9), STA(25), NTA(?)；端侧设备 = EDR(12)
DEVICE_TYPE_MAP = {
    3: "AF",  # AF 下一代防火墙
    9: "SIP",  # SIP 态势感知
    25: "STA",  # STA 流量审计
    12: "EDR",  # EDR 终端检测响应
}

# 网侧设备类型集合（SIP/STA/NTA/AF）
NET_SIDE_DEVICE_TYPES = {"sip", "sta", "nta", "af"}
# 端侧设备类型集合（EDR 及其产品别名）
CLIENT_SIDE_DEVICE_TYPES = {"edr"}


def _determine_coverage_type(dev_types: set) -> str:
    """
    根据设备类型集合判定覆盖类型

    网侧设备: sip, sta, nta, af
    端侧设备: edr

    返回: "both_coverage" / "client_only" / "net_only" / "no_coverage"
    """
    has_net = bool(dev_types & NET_SIDE_DEVICE_TYPES)
    has_client = bool(dev_types & CLIENT_SIDE_DEVICE_TYPES)

    if has_net and has_client:
        return "both_coverage"
    elif has_client:
        return "client_only"
    elif has_net:
        return "net_only"
    else:
        return "no_coverage"


def _count_coverage_types(asset_rows: list, datasource_col: str) -> dict:
    """
    对一组资产行统计各覆盖类型计数。

    Args:
        asset_rows: 同类资产的行列表
        datasource_col: "数据源"列名

    Returns:
        {both_coverage, client_only, net_only, no_coverage}
    """
    counts = {"both_coverage": 0, "client_only": 0, "net_only": 0, "no_coverage": 0}
    for row in asset_rows:
        datasource_text = str(row.get(datasource_col, "")).strip()
        dev_types = _parse_dev_types_from_datasource(datasource_text)
        coverage_type = _determine_coverage_type(dev_types)
        counts[coverage_type] += 1
    return counts


def _build_ip_type_map(asset_data: list) -> dict:
    """
    从资产清单构建 IP → 资产类型(一级) 的映射。

    Returns:
        ip_type_map: {"192.168.1.1": "服务器", ...}
    """
    ip_type_map = {}
    for row in asset_data:
        ip = str(row.get("IP地址", "")).strip()
        asset_type = str(row.get("资产类型(一级)", "")).strip()
        if ip:
            ip_type_map[ip] = asset_type
    return ip_type_map


def _classify_events_by_level(event_rows: list, ip_type_map: dict,
                              level_map: dict, level_col: str = "等级") -> dict:
    """
    按资产类型分组统计事件各等级数量。

    Args:
        event_rows: 事件行列表（已按需过滤）
        ip_type_map: IP → 资产类型映射
        level_map: 原始等级文本 → 标准等级键的映射
        level_col: 等级列名

    Returns:
        {"server_events": {critical, high, medium, low},
         "pc_events": {critical, high, medium, low}}
    """
    server_events = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    pc_events = {"critical": 0, "high": 0, "medium": 0, "low": 0}

    for evt in event_rows:
        raw_level = str(evt.get(level_col, "")).strip()
        level_key = level_map.get(raw_level, "")

        affected = str(evt.get("影响资产", "")).strip()
        ip = affected.split("(")[0].strip() if "(" in affected else affected

        asset_type = ip_type_map.get(ip, "其他")
        target = server_events if asset_type == "服务器" else pc_events

        if level_key in target:
            target[level_key] += 1

    return {"server_events": server_events, "pc_events": pc_events}


def _calc_event_deduction(events: dict, weights: dict) -> float:
    """
    计算事件扣分值（服务器扣分 + 终端扣分）。

    Args:
        events: {server_events: {critical, high, medium, low},
                pc_events: {critical, high, medium, low}}
        weights: 权重字典 self.w

    Returns:
        总扣分值
    """
    se = events["server_events"]
    pe = events["pc_events"]

    server_deduction = (
        weights["SERVER_MAJOR_EVENT_K"] * se["critical"]
        + weights["SERVER_GENERAL_EVENT_K"] * se["high"]
        + weights["SERVER_OTHER_EVENT_K"] * se["medium"]
        + weights["SERVER_MAJOR_THREAT_K"] * se["low"]
    )
    pc_deduction = (
        weights["PC_MAJOR_EVENT_K"] * pe["critical"]
        + weights["PC_GENERAL_EVENT_K"] * pe["high"]
        + weights["PC_OTHER_EVENT_K"] * pe["medium"]
        + weights["PC_MAJOR_THREAT_K"] * pe["low"]
    )
    return server_deduction + pc_deduction


def _parse_dev_types_from_datasource(datasource_text: str) -> set:
    """
    从资产 Excel "数据源"列文本中提取设备类型集合。

    数据源列格式如: "青藤万相主机安全（青藤万相-85）、STA（STA_001_解决测试方案维护）、人工（admin）"
    解析步骤：
      1. 按 "、" 分隔为多个段
      2. 对每个段，正则提取括号 "（" 前的设备类型名称
      3. 小写化后作为 dev_type

    Args:
        datasource_text: 数据源列原始文本

    Returns:
        dev_type 集合，如 {"edr", "sta"}
    """
    if not datasource_text or not isinstance(datasource_text, str):
        return set()

    dev_types = set()
    segments = re.split(r"[、]", datasource_text)
    for seg in segments:
        seg = seg.strip()
        if not seg:
            continue
        # 提取括号前的部分（支持中文括号和英文括号）
        match = re.match(r"([^(（]+)", seg)
        if match:
            device_name = match.group(1).strip().lower()
            if device_name:
                dev_types.add(device_name)
        else:
            dev_types.add(seg.lower())
    return dev_types


def load_config(config_path: str) -> dict:
    """加载 YAML 配置文件。"""
    with open(config_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


# ──────────────────────────────────────────────
# 评分引擎
# ──────────────────────────────────────────────

class ScoringEngine:
    """
    安全体检评分引擎。

    封装配置加载、数据采集和评分计算的完整流程。
    所有共用数据（配置、权重、采集结果）均为实例属性，方法之间无需传参。

    调用方式：
        engine = ScoringEngine(config_path)
        engine.load_data()
        result = engine.calc_total_score()
    """

    def __init__(self, config_path: str):
        self.config_path = config_path
        self.config = None
        self.w = None
        self.data_sources = None

        # 采集结果
        self.asset_info = None
        self.event_info = None
        self.weak_pwd_event_info = None
        self.vuln_info = None
        self.weak_info = None
        self.port_info = None
        self.policy_info = None

    def load_data(self):
        """加载配置文件并采集所有模块数据。"""
        self.config = load_config(self.config_path)
        self.w = self.config["weights"]
        self.data_sources = load_data_sources(self.config)

        self.asset_info = self._collect_asset_data()
        self.event_info = self._collect_event_data()
        self.weak_pwd_event_info = self._collect_weak_pwd_event_data()
        self.vuln_info = self._collect_vuln_data()
        self.weak_info = self._collect_weak_pwd_data()
        self.port_info = self._collect_port_data()
        self.policy_info = self._collect_policy_data()

    # ── 数据采集 ──

    def _collect_asset_data(self) -> dict:
        """
        从资产清单和设备表提取资产覆盖数据。

        覆盖判定逻辑：
          - 从资产 Excel "数据源"列提取每条资产关联的设备类型(dev_type)集合
          - 网侧覆盖 = dev_types 含 sip/sta/nta/af
          - 端侧覆盖 = dev_types 含 edr（或 agent 状态为"在线"）
          两者组合得到 both_coverage/client_only/net_only/no_coverage

        返回:
            server: {both_coverage, client_only, net_only, no_coverage, total}
            pc: {both_coverage, client_only, net_only, no_coverage, total}
            all_assets: 总资产数
            device: {activated_count, offline_count, total}
        """
        asset_data = self.data_sources.get("asset", [])
        device_data = self.data_sources.get("device", [])

        type_col = "资产类型(一级)"
        datasource_col = "数据源"

        servers = [r for r in asset_data if r.get(type_col) == "服务器"]
        pcs = [r for r in asset_data if r.get(type_col) == "终端"]

        # ── 覆盖判定：基于"数据源"列提取 dev_type ──
        s_counts = _count_coverage_types(servers, datasource_col)
        p_counts = _count_coverage_types(pcs, datasource_col)

        # 设备离线统计
        inactive_devices = [d for d in device_data if d.get("devStatus") == 3]
        offline_devices = [d for d in device_data if d.get("devStatus") == 2]
        activated_count = len(device_data) - len(inactive_devices)

        return {
            "server": {
                "both_coverage": s_counts["both_coverage"],
                "client_only": s_counts["client_only"],
                "net_only": s_counts["net_only"],
                "no_coverage": s_counts["no_coverage"],
                "total": len(servers),
            },
            "pc": {
                "both_coverage": p_counts["both_coverage"],
                "client_only": p_counts["client_only"],
                "net_only": p_counts["net_only"],
                "no_coverage": p_counts["no_coverage"],
                "total": len(pcs),
            },
            "all_assets": len(asset_data),
            "device": {
                "activated_count": activated_count,
                "offline_count": len(offline_devices),
                "total": len(device_data),
            },
        }

    def _collect_event_data(self) -> dict:
        """
        从安全事件表提取普通事件数据，按资产类型分组统计各等级事件数。

        返回:
            server_events: {critical, high, medium, low}
            pc_events: {critical, high, medium, low}
            total_events: 事件总数
        """
        event_data = self.data_sources.get("event", [])
        asset_data = self.data_sources.get("asset", [])
        level_map = LEVEL_MAPPING["event_level"]

        ip_type_map = _build_ip_type_map(asset_data)
        classified = _classify_events_by_level(event_data, ip_type_map, level_map)

        return {
            "server_events": classified["server_events"],
            "pc_events": classified["pc_events"],
            "total_events": len(event_data),
        }

    def _collect_weak_pwd_event_data(self) -> dict:
        """
        从安全事件表提取脆弱性事件数据（仅安全事件一级分类为"弱口令"的事件），
        按资产类型分组统计各等级事件数。

        返回:
            server_events: {critical, high, medium, low}
            pc_events: {critical, high, medium, low}
            total_events: 脆弱性事件总数
        """
        event_data = self.data_sources.get("event", [])
        asset_data = self.data_sources.get("asset", [])
        level_map = LEVEL_MAPPING["event_level"]

        category_col = "安全事件一级分类"
        weak_pwd_events = [evt for evt in event_data
                           if str(evt.get(category_col, "")).strip() == "弱口令"]

        ip_type_map = _build_ip_type_map(asset_data)
        classified = _classify_events_by_level(weak_pwd_events, ip_type_map, level_map)

        return {
            "server_events": classified["server_events"],
            "pc_events": classified["pc_events"],
            "total_events": len(weak_pwd_events),
        }

    def _collect_vuln_data(self) -> dict:
        """从漏洞清单提取漏洞数据，按修复优先级统计。"""
        vuln_data = self.data_sources.get("vuln", [])
        priority_map = LEVEL_MAPPING["vuln_priority"]
        risk_level_map = LEVEL_MAPPING["vuln_risk_level"]

        priority_col = "修复优先级"
        risk_col = "风险等级"

        urgent_count = 0
        fast_count = 0
        suggest_count = 0

        for row in vuln_data:
            priority = str(row.get(priority_col, "")).strip()
            priority_key = priority_map.get(priority, "")

            if priority_key == "urgent":
                urgent_count += 1
            elif priority_key == "fast":
                fast_count += 1
            elif priority_key == "suggest":
                suggest_count += 1
            else:
                risk = str(row.get(risk_col, "")).strip()
                risk_key = risk_level_map.get(risk, "")
                if risk_key == "critical":
                    urgent_count += 1
                elif risk_key == "high":
                    fast_count += 1
                elif risk_key in ("medium", "low"):
                    suggest_count += 1

        return {
            "urgent_count": urgent_count,
            "fast_count": fast_count,
            "suggest_count": suggest_count,
            "total_vulns": len(vuln_data),
        }

    def _collect_weak_pwd_data(self) -> dict:
        """从弱口令清单提取弱密码数据，按风险等级统计。"""
        weak_data = self.data_sources.get("weak_pwd", [])
        level_map = LEVEL_MAPPING["weak_pwd_risk_level"]

        risk_col = "风险等级"

        high_count = 0
        middle_count = 0
        low_count = 0
        unknown_count = 0

        for row in weak_data:
            level = str(row.get(risk_col, "")).strip()
            level_key = level_map.get(level, "") or "medium"

            if level_key in ("critical", "high"):
                high_count += 1
            elif level_key == "medium":
                middle_count += 1
            elif level_key == "low":
                low_count += 1
            else:
                unknown_count += 1

        return {
            "high_count": high_count,
            "middle_count": middle_count,
            "low_count": low_count,
            "unknown_count": unknown_count,
            "total_weak_pwd": len(weak_data),
        }

    def _collect_port_data(self) -> dict:
        """从暴露面清单-端口表提取风险端口数据。"""
        port_data = self.data_sources.get("expose", [])
        status_col = "端口连通性"

        open_count = sum(1 for row in port_data if str(row.get(status_col, "")).strip() == "开放")

        return {
            "risk_port_count": open_count,
            "total_ports": len(port_data),
        }

    def _collect_policy_data(self) -> dict:
        """
        从策略检查表提取策略隐患数据。

        策略检查 Excel 列:
          - 策略名称: 策略项名称
          - 策略状态: 正常 / 异常 / 策略获取失败
          - 风险状态: 存在风险 / 无风险

        计分逻辑:
          check_cnt = 策略检查总项数
          risk_cnt = 风险状态为"存在风险"的项数

        返回:
            check_cnt: 策略检查总项数
            risk_cnt: 风险项数
            policy_status_summary: 各策略状态计数
            risk_status_summary: 各风险状态计数
        """
        policy_data = self.data_sources.get("policy", [])

        risk_col = "风险状态"
        status_col = "策略状态"

        risk_cnt = sum(1 for row in policy_data
                       if str(row.get(risk_col, "")).strip() == "存在风险")
        check_cnt = len(policy_data)

        policy_status_summary = {}
        for row in policy_data:
            status = str(row.get(status_col, "")).strip()
            if status:
                policy_status_summary[status] = policy_status_summary.get(status, 0) + 1

        risk_status_summary = {}
        for row in policy_data:
            risk = str(row.get(risk_col, "")).strip()
            if risk:
                risk_status_summary[risk] = risk_status_summary.get(risk, 0) + 1

        return {
            "check_cnt": check_cnt,
            "risk_cnt": risk_cnt,
            "policy_status_summary": policy_status_summary,
            "risk_status_summary": risk_status_summary,
        }

    # ── L3 基础分数 ──

    def _calc_coverage_score(self, asset_key: str) -> float:
        """L3-覆盖得分 = (已覆盖数)/(总数) × 100，总数为0时返回0"""
        info = self.asset_info[asset_key]
        covered = info["both_coverage"] + info["client_only"] + info["net_only"]
        total = covered + info["no_coverage"]
        if total == 0:
            return 0.0
        return covered / total * 100

    def calc_server_score(self) -> float:
        """L3-服务器得分"""
        return self._calc_coverage_score("server")

    def calc_pc_score(self) -> float:
        """L3-终端得分"""
        return self._calc_coverage_score("pc")

    def calc_device_offline_score(self) -> float:
        """
        L3-设备离线得分 = max(0, (d1-d2)/d1 × 100)
        d1 = 激活设备数, d2 = 离线设备数
        增加 max(0, ...) 下限保护，防止离线数超过激活数时出现负分
        """
        dev = self.asset_info.get("device", {})
        activated = dev.get("activated_count", 0)
        offline = dev.get("offline_count", 0)

        if activated == 0:
            return 0.0

        return max(0, (activated - offline) / activated * 100)

    def calc_policy_score(self) -> float:
        """
        L3-策略隐患得分 = check_cnt>0 → (check_cnt-risk_cnt)/check_cnt × 100, else 0
        check_cnt = 策略检查总项数, risk_cnt = 风险状态为"存在风险"的项数
        """
        check_cnt = self.policy_info["check_cnt"]
        risk_cnt = self.policy_info["risk_cnt"]

        if check_cnt == 0:
            return 0.0

        return (check_cnt - risk_cnt) / check_cnt * 100

    # ── L3 事件/漏洞/端口/弱密码 ──

    def calc_event_score(self) -> float:
        """
        L2-事件得分 = max(0, 100 - Σ每个资产扣分)
        服务器扣分 = SERVER_MAJOR_EVENT_K×严重 + SERVER_GENERAL_EVENT_K×高危
                   + SERVER_OTHER_EVENT_K×中危 + SERVER_MAJOR_THREAT_K×低危
        非服务器扣分 = PC_MAJOR_EVENT_K×严重 + PC_GENERAL_EVENT_K×高危
                    + PC_OTHER_EVENT_K×中危 + PC_MAJOR_THREAT_K×低危
        """
        total_deduction = _calc_event_deduction(self.event_info, self.w)
        return max(0, 100 - total_deduction)

    def calc_vuln_score(self) -> float:
        """L3-漏洞得分 = max(0, 100 - AGENT_FIX_VULN_K×va - FAST_FIX_VULN_K×vb - SUGGEST_FIX_VULN_K×vc)"""
        return max(0, 100
                   - self.w["AGENT_FIX_VULN_K"] * self.vuln_info["urgent_count"]
                   - self.w["FAST_FIX_VULN_K"] * self.vuln_info["fast_count"]
                   - self.w["SUGGEST_FIX_VULN_K"] * self.vuln_info["suggest_count"])

    def calc_port_score(self) -> float:
        """L3-端口得分 = max(0, 100 - RISK_PORT_K×rp)"""
        return max(0, 100 - self.w["RISK_PORT_K"] * self.port_info["risk_port_count"])

    def calc_weak_pwd_base_score(self) -> float:
        """
        L4-弱密码基础分 = max(0, 100-HIGH_LEVEL_WEAKPWD_K×wh-MIDDLE_LEVEL_WEAKPWD_K×wm
                              -LOW_LEVEL_WEAKPWD_K×wl-UNKNOWN_LEVEL_WEAKPWD_K×wu)
                          × WEAK_PASSWORD_BASE_K
        """
        raw = max(0, 100
                  - self.w["HIGH_LEVEL_WEAKPWD_K"] * self.weak_info["high_count"]
                  - self.w["MIDDLE_LEVEL_WEAKPWD_K"] * self.weak_info["middle_count"]
                  - self.w["LOW_LEVEL_WEAKPWD_K"] * self.weak_info["low_count"]
                  - self.w["UNKNOWN_LEVEL_WEAKPWD_K"] * self.weak_info["unknown_count"])
        return raw * self.w["WEAK_PASSWORD_BASE_K"]

    def calc_vulnerability_event_score(self) -> float:
        """
        L4-脆弱性事件分 = 弱口令事件扣分后得分 × (1-WEAK_PASSWORD_BASE_K)
        仅统计安全事件一级分类为"弱口令"的事件。
        """
        ratio = 1 - self.w["WEAK_PASSWORD_BASE_K"]
        if ratio == 0:
            return 0.0

        total_deduction = _calc_event_deduction(self.weak_pwd_event_info, self.w)
        weak_pwd_event_score = max(0, 100 - total_deduction)
        return weak_pwd_event_score * ratio

    def calc_weak_pwd_score(self) -> float:
        """L3-弱密码得分 = 弱密码基础分 + 脆弱性事件分"""
        return self.calc_weak_pwd_base_score() + self.calc_vulnerability_event_score()

    # ── L2 汇总 ──

    def _get_adapted_ratios(self) -> tuple:
        """
        零资产权重自适应：返回 (server_ratio, pc_ratio)。

          - 两类资产都为 0 时：保持默认权重
          - 仅服务器为 0 时：服务器权重 → 0，终端权重 → 1
          - 仅终端为 0 时：终端权重 → 0，服务器权重 → 1
          - 都不为 0 时：使用配置权重
        """
        server_total = self.asset_info["server"]["total"]
        pc_total = self.asset_info["pc"]["total"]

        if server_total == 0 and pc_total == 0:
            return self.w["SERVER_RATIO"], self.w["PC_SCORE"]
        elif server_total == 0 and pc_total != 0:
            return 0, 1
        elif server_total != 0 and pc_total == 0:
            return 1, 0
        else:
            return self.w["SERVER_RATIO"], self.w["PC_SCORE"]

    def calc_managed_asset_score(self) -> float:
        """
        L2-托管资产得分 = 服务器得分 × server_ratio + 终端得分 × pc_ratio
        含零资产权重自适应。
        """
        server_ratio, pc_ratio = self._get_adapted_ratios()
        return self.calc_server_score() * server_ratio + self.calc_pc_score() * pc_ratio

    def calc_component_score(self) -> float:
        """L2-组件检测得分 = 设备离线得分 × DEVICE_K + 策略隐患得分 × POLICY_K"""
        return self.calc_device_offline_score() * self.w["DEVICE_K"] + self.calc_policy_score() * self.w["POLICY_K"]

    def calc_ransom_score(self) -> float:
        """L2-勒索风险得分 = 漏洞得分×VULNERABILITY_K + 弱密码得分×WEAK_PASSWORD_K + 端口得分×PORT_K"""
        return (self.calc_vuln_score() * self.w["VULNERABILITY_K"]
                + self.calc_weak_pwd_score() * self.w["WEAK_PASSWORD_K"]
                + self.calc_port_score() * self.w["PORT_K"])

    # ── L1 及总分 ──

    def calc_total_score(self) -> dict:
        """计算总分及所有中间分数，返回完整评分报告。"""
        # L3 基础分数
        server_score = self.calc_server_score()
        pc_score = self.calc_pc_score()
        device_offline_score = self.calc_device_offline_score()
        policy_score = self.calc_policy_score()
        event_score = self.calc_event_score()
        vuln_score = self.calc_vuln_score()
        port_score_val = self.calc_port_score()
        weak_pwd_base = self.calc_weak_pwd_base_score()
        vuln_event_score = self.calc_vulnerability_event_score()
        weak_pwd_score = self.calc_weak_pwd_score()

        # L2 汇总
        managed_asset_score = self.calc_managed_asset_score()
        actual_server_ratio, actual_pc_ratio = self._get_adapted_ratios()
        component_score = self.calc_component_score()
        ransom_score = self.calc_ransom_score()

        # L1 汇总
        asset_protection_score = managed_asset_score * self.w["ASSETS_RATIO"] + component_score * self.w[
            "COMPONENTS_RATIO"]
        daily_ops_score = event_score * self.w["EVENTS_RATIO"] + ransom_score * self.w["VULNERABILITIES_RATIO"]

        # 总分
        total = (asset_protection_score * self.w["DEFAULT_ASSETS_RATIO"]
                 + daily_ops_score * (1 - self.w["DEFAULT_ASSETS_RATIO"]))

        # 总分等级
        grade_info = calc_grade(total)

        return {
            "total_score": round(total, 2),
            "grade": grade_info["grade"],
            "grade_color": grade_info["color"],
            "L1": {
                "资产防护得分": round(asset_protection_score, 2),
                "日常运营得分": round(daily_ops_score, 2),
            },
            "L2": {
                "托管资产得分": round(managed_asset_score, 2),
                "组件检测得分": round(component_score, 2),
                "事件得分": round(event_score, 2),
                "勒索风险得分": round(ransom_score, 2),
            },
            "L3": {
                "服务器得分": round(server_score, 2),
                "终端得分": round(pc_score, 2),
                "服务器权重": actual_server_ratio,
                "终端权重": actual_pc_ratio,
                "设备离线得分": round(device_offline_score, 2),
                "策略隐患得分": round(policy_score, 2),
                "漏洞得分": round(vuln_score, 2),
                "端口得分": round(port_score_val, 2),
                "弱密码基础分": round(weak_pwd_base, 2),
                "脆弱性事件分": round(vuln_event_score, 2),
                "弱密码得分": round(weak_pwd_score, 2),
            },
            "data_summary": {
                "asset": self.asset_info,
                "event": self.event_info,
                "weak_pwd_event": self.weak_pwd_event_info,
                "vuln": self.vuln_info,
                "weak_pwd": self.weak_info,
                "port": self.port_info,
                "policy": self.policy_info,
            },
            "weights_used": {k: v for k, v in self.w.items()},
        }

    # ── 数据摘要打印 ──

    def print_data_summary(self):
        """打印采集到的数据摘要。"""
        print(f"  资产: 服务器 {self.asset_info['server']['total']} 台, "
              f"终端 {self.asset_info['pc']['total']} 台")
        print(f"  设备: 激活 {self.asset_info['device']['activated_count']} 台, "
              f"离线 {self.asset_info['device']['offline_count']} 台, "
              f"共 {self.asset_info['device']['total']} 台")
        print(f"  事件: 共 {self.event_info['total_events']} 条 "
              f"(服务器 严重{self.event_info['server_events']['critical']} "
              f"高危{self.event_info['server_events']['high']} "
              f"中危{self.event_info['server_events']['medium']} "
              f"低危{self.event_info['server_events']['low']})")
        print(f"  弱口令事件: 共 {self.weak_pwd_event_info['total_events']} 条 "
              f"(服务器 严重{self.weak_pwd_event_info['server_events']['critical']} "
              f"高危{self.weak_pwd_event_info['server_events']['high']} "
              f"中危{self.weak_pwd_event_info['server_events']['medium']} "
              f"低危{self.weak_pwd_event_info['server_events']['low']})")
        print(f"  漏洞: 急需修复 {self.vuln_info['urgent_count']}, "
              f"尽快修复 {self.vuln_info['fast_count']}, "
              f"建议修复 {self.vuln_info['suggest_count']}")
        print(f"  弱密码: 严重 {self.weak_info['high_count']}, "
              f"中危 {self.weak_info['middle_count']}, "
              f"低危 {self.weak_info['low_count']}, "
              f"未知 {self.weak_info['unknown_count']}")
        print(f"  风险端口: {self.port_info['risk_port_count']} 个开放端口")
        print(f"  策略检查: 共 {self.policy_info['check_cnt']} 项, "
              f"存在风险 {self.policy_info['risk_cnt']} 项")

    def print_score_result(self, result: dict):
        """打印评分结果。"""
        print(f"\n  总分: {result['total_score']}  等级: {result['grade']} ({result['grade_color']})")
        print(f"  资产防护得分: {result['L1']['资产防护得分']}")
        print(f"    托管资产得分: {result['L2']['托管资产得分']}")
        print(f"      服务器得分: {result['L3']['服务器得分']} (权重: {result['L3']['服务器权重']})")
        print(f"      终端得分: {result['L3']['终端得分']} (权重: {result['L3']['终端权重']})")
        print(f"    组件检测得分: {result['L2']['组件检测得分']}")
        print(f"      设备离线得分: {result['L3']['设备离线得分']}")
        print(f"      策略隐患得分: {result['L3']['策略隐患得分']}")
        print(f"  日常运营得分: {result['L1']['日常运营得分']}")
        print(f"    事件得分: {result['L2']['事件得分']}")
        print(f"    勒索风险得分: {result['L2']['勒索风险得分']}")
        print(f"      漏洞得分: {result['L3']['漏洞得分']}")
        print(f"      弱密码得分: {result['L3']['弱密码得分']}")
        print(f"      端口得分: {result['L3']['端口得分']}")


# ──────────────────────────────────────────────
# 主流程
# ──────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="安全体检评分计算")
    parser.add_argument("--config", default=None, help="配置文件路径")
    parser.add_argument("--output", default=None, help="输出文件路径(JSON)")
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    config_path = args.config or os.path.join(script_dir, "config.yaml")

    print("=" * 60)
    print("安全体检评分系统")
    print("=" * 60)
    print(f"\n配置文件: {config_path}\n")

    engine = ScoringEngine(config_path)

    # 采集数据
    print("\n--- 数据采集 ---")
    engine.load_data()
    engine.print_data_summary()

    # 计算评分
    print("\n--- 评分计算 ---")
    result = engine.calc_total_score()
    engine.print_score_result(result)

    # 输出
    output_path = args.output or os.path.join(script_dir, "scoring_result.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2, default=str)

    print(f"\n评分结果已保存: {output_path}")
    print("=" * 60)


if __name__ == "__main__":
    main()
