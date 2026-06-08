# Python Flask Demo

## 示例代码

见 [examples/flask/app.py](../examples/flask/app.py)。

问题现象：订单折扣字段从请求 JSON 进入时可能是字符串，导致金额计算出现类型错误或错误结果。

## 启动 debugpy

```bash
python -m debugpy --listen 127.0.0.1:5678 --wait-for-client examples/flask/app.py
```

## 启动 BreakPilot daemon

```bash
breakpilot serve --http-port 27890 --ide-bridge-port 27891
```

## 调试顺序

```bash
breakpilot attach --lang python --host 127.0.0.1 --port 5678 --pretty
breakpilot bp set --session sess_001 --file examples/flask/app.py --line 12 --pretty
breakpilot wait --session sess_001 --timeout 30000 --pretty
breakpilot snapshot --session sess_001 --profile focused --max-items 10 --pretty
breakpilot inspect-variable --session sess_001 --ref 7 --depth 1 --max-items 20 --pretty
breakpilot eval --session sess_001 --mode readonly order["discount"] --pretty
breakpilot continue --session sess_001 --pretty
breakpilot disconnect --session sess_001 --pretty
```

触发请求：

```bash
curl -X POST http://127.0.0.1:5000/order \
  -H 'content-type: application/json' \
  -d '{"amount": 100, "discount": "10"}'
```

Agent 应该先从 focused snapshot 的当前帧关键变量里看到 `discount` 是字符串。如果某个对象只显示 preview，就用 `inspect-variable` 按 `variablesReference` 定向展开，而不是直接请求 full snapshot。确认问题后修复为显式数值转换，然后重新 curl 或 pytest 验证。

## IDE 协同消息流

```text
MCP -> IDE: agent_set_breakpoint
Runtime -> Adapter -> MCP: stopped event
MCP -> IDE: ide_breakpoint_hit / agent_request_confirmation
IDE -> MCP: user_confirm_continue
MCP -> Adapter: continue
```

## Node/TypeScript 概要

- 用 `node --inspect-brk dist/server.js` 或 js-debug launch。
- 在 `.ts` 文件设置断点需要 `sourceMap: true`。
- source map 找不到时返回 `SOURCE_MAP_NOT_FOUND` 或 unverified breakpoint。
- 常见问题：request body 字段类型错误、async stack 不完整。

## Java/Spring Boot + MyBatis 概要

启动参数：

```bash
java -agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:5005 -jar app.jar
```

建议断点：

- Controller 入参；
- Service 业务计算；
- Mapper 调用前后；
- resultMap 映射对象构造处。

关注变量：

- 方法参数；
- `this`；
- SQL 参数；
- 查询结果字段；
- resultMap、alias、驼峰映射配置。

第一版不做 Java 热更新，修复后建议重启或依赖 IDE/框架热部署能力。
