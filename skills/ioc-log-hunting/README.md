# 目录说明

全网日志恶意内容摸排 Skill 设计草稿（阶段性存档 2026-09-03，进度：DNS 已锁定）

```
docs/
  探明结论-总览.md        业务目标/输入输出/强约束/平台登录态
  接口与请求体归档.md     4个URL + 样例请求体 + tableId + 检索语法
  DNS表探明.md            DNS字段、恶意类型映射、skill逻辑定稿
  dns_tableFields.json    DNS表85字段字典备份
  dns_detail_sample.json  一条DNS明细样例(83字段全值)
scripts/
  dns_hunt.py             DNS检索可运行脚本(草稿, 参数 --company-id --url)
```

## 使用
DNS 检索脚本（muad 环境，登录态自动注入）：
```
python3 scripts/dns_hunt.py --company-id 97988530 --url "<恶意URL>"
```
脚本依赖共享库 shared.py（取 cookie / build_headers / http_json），需连同
monitor-mssp-events/scripts/shared.py 及 config/api_config.json 的 mssp(origin/endpoints)
一起复制/内置。dns_hunt.py 内已按 config endpoints key 取名(ck_count / ck_query_list)，
最终 skill 落地时统一补一份完整 shared + api_config。

## 待办
- TCP(100) 表字段与检索验证（恶意 IP 反查）
- 遥测(28) / 终端(26) hash 泛化
- 统一 skill 目录(skill-staging/ioc-log-hunting)与执行契约后上传
