# -*- coding: utf-8 -*-
import sys, json
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"C:\Users\User\.openclaw\workspace\skills\incident-reply\scripts\sangfor_ti_cloud_search")
import cloud_query_ioc as c

print("模块加载 OK")
print("\n########## ip_v2(['97.107.132.190'], direction=2) ##########")
try:
    resp = c.ip_v2(["97.107.132.190"], 2)
    print(json.dumps(resp.json(), ensure_ascii=False, indent=2))
except Exception as e:
    import traceback; traceback.print_exc()
print("\n=== 测试结束 ===")
