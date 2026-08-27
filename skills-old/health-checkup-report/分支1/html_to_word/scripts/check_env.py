#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
html_to_word 环境诊断脚本

检查 html_to_word_export.py 中 _update_fields_via_word 调用 Word/WPS COM
所需的运行时环境是否就绪。覆盖以下检查项：

1. 平台与 Python 位数（COM 对位数敏感，32/64 不匹配会查不到 ProgID）
2. pywin32 / pythoncom 是否安装及版本
3. 注册表 ProgID 查询：Word.Application / Kwps.Application / wps.Application
4. DispatchEx 实际试探（与生产代码同路径，但 Visible=False，秒退）
5. 探测已安装的 Word / WPS 可执行路径
6. 读取 html_to_word_config.yaml 中 update_fields_after_save.backend，
   给出当前机器下的推荐 backend

用法：
    python scripts/check_env.py
    python scripts/check_env.py --config path/to/html_to_word_config.yaml

退出码：
    0  环境就绪，推荐 backend 可用
    1  缺少关键依赖或 ProgID 不可用（会触发 CO_E_CLASSSTRING 风险）
    2  脚本自身异常
"""

from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
from typing import Optional

# Windows 控制台默认 GBK，Python 输出 UTF-8 会乱码；尽量重打开为 UTF-8。
if platform.system() == "Windows":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass


# ---------- ANSI 着色（终端不支持时自动降级）----------
_COLOR_ENABLED = sys.stdout.isatty() and platform.system() == "Windows"


def _c(text: str, color: str) -> str:
    if not _COLOR_ENABLED:
        return text
    codes = {"red": "31", "green": "32", "yellow": "33",
             "blue": "34", "gray": "90", "bold": "1"}
    code = codes.get(color, "")
    if not code:
        return text
    return f"\033[{code}m{text}\033[0m"


def ok(msg: str) -> None:
    print(f"  [{_c('OK', 'green')}] {msg}")


def warn(msg: str) -> None:
    print(f"  [{_c('WARN', 'yellow')}] {msg}")


def fail(msg: str) -> None:
    print(f"  [{_c('FAIL', 'red')}] {msg}")


def info(msg: str) -> None:
    print(f"  [{_c('INFO', 'blue')}] {msg}")


# ---------- 各项检查 ----------

def check_platform() -> dict:
    print(_c("[1] 平台与 Python 位数", "bold"))
    plat = platform.system()
    py_bits = 64 if sys.maxsize > 2**32 else 32
    info(f"platform={plat}  python={platform.python_version()}  bits={py_bits}")
    if plat != "Windows":
        fail("非 Windows 平台，win32com 不可用；COM 更新域会被跳过")
        return {"ok": False, "platform": plat, "py_bits": py_bits}
    ok(f"Windows 平台，Python {py_bits} 位")
    return {"ok": True, "platform": plat, "py_bits": py_bits}


def check_pywin32() -> dict:
    print(_c("[2] pywin32 / pythoncom", "bold"))
    try:
        import win32com  # noqa: F401
        import pythoncom  # noqa: F401
        import pywintypes  # noqa: F401
    except ImportError as e:
        fail(f"pywin32 未安装: {e}")
        warn("修复: pip install pywin32  或  pip install pywin32 --upgrade")
        return {"ok": False}
    try:
        import win32api
        ver = ".".join(map(str, win32api.GetFileVersionInfo(win32api.__file__, "\\")["FileVersionLS"].to_bytes(4, "big")))  # type: ignore[attr-defined]
    except Exception:
        ver = "unknown"
    ok(f"pywin32 已安装（文件版本: {ver}）")
    return {"ok": True, "version": ver}


def _reg_query(progid: str) -> Optional[str]:
    """用 reg query 查 HKCR\\<progid>\\CLSID，返回 CLSID 或 None。"""
    try:
        out = subprocess.run(
            ["reg", "query", f"HKCR\\{progid}\\CLSID"],
            capture_output=True, text=True, timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    for line in out.stdout.splitlines():
        line = line.strip()
        if line.startswith("(default)"):
            # reg query 输出形如: "    (Default)    REG_SZ    {000209FF-0000-...}"
            parts = line.split("REG_SZ", 1)
            if len(parts) == 2:
                return parts[1].strip().strip("{}")
        if line.startswith("{") and line.endswith("}"):
            return line.strip("{}")
    # 兜底：扫到任何 CLSID 形态的 token
    for line in out.stdout.splitlines():
        line = line.strip()
        if "REG_SZ" in line and "{" in line:
            tail = line.split("REG_SZ", 1)[1].strip()
            return tail.strip("{}")
    return None


def check_progid() -> dict:
    print(_c("[3] ProgID 注册表查询", "bold"))
    results = {}
    for progid in ("Word.Application", "Kwps.Application", "wps.Application",
                   "Word.Application.16", "Word.Application.15",
                   "Word.Application.14", "Kwps.Application.1"):
        clsid = _reg_query(progid)
        if clsid:
            ok(f"{progid} -> CLSID={clsid}")
        else:
            warn(f"{progid} 未在 HKCR 注册")
        results[progid] = clsid
    has_word = any(results[k] for k in results if k.startswith("Word.Application"))
    has_wps = any(results[k] for k in results if k.startswith("Kwps.Application") or k == "wps.Application")
    return {"ok": has_word or has_wps, "has_word": has_word,
            "has_wps": has_wps, "details": results}


def _try_dispatch(progid: str, timeout_sec: float = 8.0) -> tuple[bool, str]:
    """实际 DispatchEx 试探，Visible=False，立即 Quit。返回 (是否成功, 说明)。"""
    try:
        import win32com.client as _w32c
        import pythoncom
    except ImportError as e:
        return False, f"pywin32 未安装: {e}"
    word = None
    try:
        pythoncom.CoInitialize()
        word = _w32c.DispatchEx(progid)
        try:
            word.Visible = False
        except Exception:
            pass
        try:
            word.DisplayAlerts = 0
        except Exception:
            pass
        # 触发一次轻量调用，确认对象真的活
        _ = word.Version
        return True, f"DispatchEx 成功，Version={_}"
    except Exception as e:
        hresult = None
        try:
            import pywintypes
            if isinstance(e, pywintypes.com_error):
                hresult = e.hresult  # type: ignore[attr-defined]
        except Exception:
            pass
        msg = f"DispatchEx 失败: {e}"
        if hresult is not None:
            msg += f"  hresult={hresult:#x}"
        return False, msg
    finally:
        if word is not None:
            try:
                word.Quit()
            except Exception:
                pass
        try:
            import pythoncom
            pythoncom.CoUninitialize()
        except Exception:
            pass


def check_dispatch() -> dict:
    print(_c("[4] DispatchEx 实际试探", "bold"))
    results = {}
    for progid in ("Word.Application", "Kwps.Application"):
        success, detail = _try_dispatch(progid)
        if success:
            ok(f"{progid}: {detail}")
        else:
            warn(f"{progid}: {detail}")
        results[progid] = {"ok": success, "detail": detail}
    return {"ok": any(r["ok"] for r in results.values()), "details": results}


def _find_exe_via_reg(progid: str) -> Optional[str]:
    """从 HKCR\\<progid>\\CLSID\\LocalServer32 取可执行路径。"""
    clsid = _reg_query(progid)
    if not clsid:
        return None
    try:
        out = subprocess.run(
            ["reg", "query", f"HKCR\\CLSID\\{{{clsid}}}\\LocalServer32"],
            capture_output=True, text=True, timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    for line in out.stdout.splitlines():
        line = line.strip()
        if "REG_SZ" in line:
            return line.split("REG_SZ", 1)[1].strip()
    return None


def check_install_path() -> dict:
    print(_c("[5] 已安装 Word / WPS 可执行路径", "bold"))
    found = {}
    for progid in ("Word.Application", "Kwps.Application"):
        path = _find_exe_via_reg(progid)
        if path:
            ok(f"{progid} -> {path}")
            if os.path.exists(path.split(" /", 1)[0].strip('"')):
                info("文件存在")
            else:
                warn("注册表指向的路径不存在，可能为残留注册")
            found[progid] = path
        else:
            warn(f"未找到 {progid} 的 LocalServer32 路径")
    # 兜底：常见安装目录
    candidates = [
        r"C:\Program Files\Microsoft Office",
        r"C:\Program Files (x86)\Microsoft Office",
        r"C:\Program Files\WPS Office",
        r"C:\Program Files (x86)\WPS Office",
        os.path.expandvars(r"%LOCALAPPDATA%\Kingsoft\WPS Office"),
        os.path.expandvars(r"%APPDATA%\kingsoft\wps"),
    ]
    print(_c("    扫描常见安装目录:", "gray"))
    for c in candidates:
        if os.path.isdir(c):
            info(f"存在: {c}")
        else:
            print(_c(f"    跳过: {c}", "gray"))
    return {"ok": bool(found), "found": found}


def check_config(config_path: str) -> dict:
    print(_c(f"[6] 配置 backend 建议（来自 {config_path}）", "bold"))
    backend = None
    enabled = None
    try:
        # 不引入 PyYAML 也能容忍：用最小解析
        with open(config_path, "r", encoding="utf-8") as f:
            in_section = False
            for line in f:
                stripped = line.rstrip()
                if stripped.startswith("update_fields_after_save:"):
                    in_section = True
                    continue
                if in_section:
                    if stripped and not stripped.startswith(" ") and not stripped.startswith("#"):
                        # 退出 update_fields_after_save 节
                        break
                    if "backend:" in stripped:
                        backend = stripped.split("backend:", 1)[1].strip().split("#")[0].strip()
                    if "enabled:" in stripped:
                        enabled = stripped.split("enabled:", 1)[1].strip().split("#")[0].strip()
    except FileNotFoundError:
        warn(f"配置文件未找到: {config_path}")
    info(f"配置当前: enabled={enabled}  backend={backend}")
    return {"backend": backend, "enabled": enabled}


def _recommend(cfg: dict, progid_ok: dict, dispatch_ok: dict) -> str:
    has_word = progid_ok.get("has_word") or dispatch_ok["details"].get("Word.Application", {}).get("ok")
    has_wps = progid_ok.get("has_wps") or dispatch_ok["details"].get("Kwps.Application", {}).get("ok")
    cur = (cfg.get("backend") or "").lower()
    if has_word and has_wps:
        return f"win32com 与 wps 均可用；当前 backend={cur}，可保持，或优先 win32com（功能更全）"
    if has_word:
        return "win32com（Word.Application 可用）"
    if has_wps:
        return "wps（Kwps.Application 可用）—— 当前 backend=win32com 会触发 CO_E_CLASSSTRING，建议改 backend: wps"
    return "none（未发现 Word/WPS COM）；将回退到 settings.xml <w:updateFields> 开关"


# ---------- 主入口 ----------

def main() -> int:
    parser = argparse.ArgumentParser(description="html_to_word 环境诊断")
    here = os.path.dirname(os.path.abspath(__file__))
    default_cfg = os.path.normpath(os.path.join(here, "..", "html_to_word_config.yaml"))
    parser.add_argument("--config", default=default_cfg,
                        help=f"配置文件路径（默认: {default_cfg}）")
    args = parser.parse_args()

    print(_c("=" * 64, "gray"))
    print(_c("html_to_word 环境诊断", "bold"))
    print(_c("=" * 64, "gray"))

    p = check_platform()
    pyw = check_pywin32()
    progid_ok = check_progid()
    dispatch_ok = check_dispatch() if pyw["ok"] else {"ok": False, "details": {}}
    _ = check_install_path()
    cfg = check_config(args.config)

    print(_c("=" * 64, "gray"))
    print(_c("[结论]", "bold"))
    recommended = _recommend(cfg, progid_ok, dispatch_ok)
    info(f"推荐 backend: {recommended}")

    critical_fail = (not p["ok"]) or (not pyw["ok"]) or (not (progid_ok["ok"] or dispatch_ok["ok"]))
    if critical_fail:
        fail("环境不满足 COM 更新域要求；运行 html_to_word 时会 WARNING 并回退")
        print(_c("修复建议:", "bold"))
        if not p["ok"]:
            print("  - 非 Windows 平台：无法使用 win32com，请设 backend: none")
        if not pyw["ok"]:
            print("  - 安装 pywin32: pip install pywin32")
        if not progid_ok["ok"] and not dispatch_ok["ok"]:
            print("  - 安装 Microsoft Word，或安装 WPS Office 并将 backend 改为 wps")
            print("  - 若已安装仍查不到 ProgID：")
            print("      * 确认 Office 位数与 Python 位数一致（都 64 或都 32）")
            print("      * 修复安装 Office（控制面板 → Office → 修改 → 联机修复）")
            print("      * 以管理员身份运行一次 'win32com\\client\\makepy.py -i Word.Application'")
        return 1
    ok("环境就绪")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(2)
    except Exception as e:
        fail(f"脚本异常: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(2)
