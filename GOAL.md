# 目标

magpie-ssh 成为「装一次就够用」的 SSH 能力插件：agent 通过 magpie 的 MCP 端点即可操作已配置的主机，人和 agent 都不必再碰系统 ssh、密码或密钥路径。

## 验收标准

每条都要能被一条命令或一次工具调用验证。

| # | 标准 | 验证方式 |
| --- | --- | --- |
| 1 | 一条命令装上 | `magpie plugin add "github:ltsj/magpie-ssh"` |
| 2 | 改完能在线更新 | `magpie plugin update magpie-ssh` |
| 3 | 工具面完整：`hosts` / `check` / `run` / `put` / `get` | `magpie plugin list` 打出这五个工具名 |
| 4 | 单台与批量都能跑 | `run {host:"*", command:"uname -sr"}` 五台分段返回 |
| 5 | 单次调用不超 magpie 的 55 秒上限 | `run` 默认 45s、上限 50s；`check` 默认 8s |
| 6 | 失败回文本，不弄挂插件宿主 | 坏参数、空配置、连不上、认证被拒都返回 `exit -1` + 原因 |
| 7 | 主机指纹不许静默接受 | `accept-new` 落盘、指纹变更拒绝、`yes` 必须已存在 |
| 8 | 输出超限不掐断命令 | 5MB 输出 → `exit 0` + 「已丢弃后续内容」提示 |
| 9 | 页面能增删改查，密码回填 | 浏览器里表单提交、编辑、两步删除 |
| 10 | 冒烟测试全绿 | `node test/smoke.mjs` |

## 现状

| 项 | 状态 |
| --- | --- |
| 1 安装 | 已达成（0.2.0 从 GitHub 装，5 台主机可用） |
| 2 更新 | 已达成（`update` 拉到 0.2.0） |
| 3 工具面 | 已达成（`check` 于 0.3.0 加入） |
| 4 批量 | 已达成 |
| 5 时间预算 | 已达成 |
| 6 文本失败 | 已达成 |
| 7 指纹 | 已达成 |
| 8 输出超限 | 已达成 |
| 9 页面 | 已达成 |
| 10 冒烟 | 已达成，但 CI 跑不起来（见阻塞） |

## 阻塞项

- CI：GitHub Actions 因账号计费问题拒绝启动 job（`The job was not started because recent account payments have failed`）。工作流本身已写好，计费恢复即生效。
- npm 发布：`npm whoami` 报未登录，`magpie-ssh` 名字在 npm 上仍空闲。

## 非目标

明确不做，避免下次又讨论一遍：

- 连接复用池：省 0.3–1 秒，换来半开连接判定、重试、宿主重启清理，收益不抵风险。
- `proxyJump` 跳板机：现有主机都不需要，要加时 ssh2 得自己开 forward 通道。
- 密钥生成、读取 `~/.ssh`、页面内测连接：页面跑在 `connect-src 'none'` 的沙箱里。
- 目录递归传输：SFTP 的 `fastPut`/`fastGet` 只处理单个文件。
- 凭据加密：magpie 自己的 `plugin-auth.json` 也是明文，插件不单独造一套。
