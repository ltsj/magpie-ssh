# 更新日志

版本号跟着 npm 包走，`0.x` 期间小版本之间可能有行为变化，破坏性改动会写在这里。

## 0.6.0

### 新增

- 主机可以填「私钥口令」：带口令的私钥现在能连了（以前只会报 `Encrypted private OpenSSH key detected, but no passphrase given`）。口令和密码一样是明文存在 plugins.json 里的。
- 页面加「导入 / 导出」：把主机表导出成 JSON，或粘回一段 JSON 按名称合并（同名覆盖、其余追加）。`magpie plugin rm` 会连设置一起删，删之前先导一份。
- 审计日志到 2 MB 就转成 `audit.log.1` 再写，只留一代，常驻的 agent 不会把盘写满。

### 修复

- 一个调用超时或被取消，不再把同主机其他并发调用一起断掉：只关自己那条 channel / SFTP 子系统，连接留给别人；整条连接真的坏了才关。
- `put` 不再允许从 `~/.ssh` 取文件（`get` 早就挡了）。否则被内容注入的 agent 可以把私钥、`plugins.json` 一起传走。
- `plugins.json` 解析失败时直接报错，不再悄悄当成「还没有配置 SSH 主机」——那样用户会以为主机丢了，跑去重配一遍。

### 其他

- `.gitattributes` 固定 `* text=auto eol=lf`，检出时不再把仓库里的 LF 换成 CRLF。
- CI 从「ubuntu + Node 22」扩成 ubuntu/windows × Node 18/20/22：`engines` 说 >= 18，代码里也有 Windows 专属分支（ssh-agent 的命名管道、路径大小写折叠）。
- `pnpm-workspace.yaml` 里显式禁用 `cpu-features`、`ssh2` 的构建脚本（两个都不需要：ssh2 有纯 JS 回退），pnpm 12 不会再报 `ERR_PNPM_IGNORED_BUILDS`，pnpm 10 也不会再提示 `approve-builds`。

## 0.5.0

- 登录过的连接留 60 秒复用，省掉每次调用的握手；`connectionReuse: false` 可以关掉。

## 0.4.1

- `known_hosts` 支持哈希行、`@revoked`、非 22 端口的 `[host]:port` 身份；远端路径支持 `~`。

## 0.4.0

- `host` 支持多选（逗号分隔或 `*`）、批量执行共享时间预算、末尾汇总。
- `check` 报告服务器指纹；审计日志可选（`auditLog: true`）。
- 输出截断不再切出半个代理对。
