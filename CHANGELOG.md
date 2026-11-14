# 更新日志

版本号跟着 npm 包走，`0.x` 期间小版本之间可能有行为变化，破坏性改动会写在这里。

## 0.8.0

### 新增

- `put` / `get` 支持目录：递归遍历，逐个文件传，一个文件失败不影响其他；报告里有完成数、总字节数、失败清单（最多列 20 条）和跳过的符号链接。目录不存在会逐级建。
- `put` / `get` 新增 `timeoutMs`（默认 45000，最多 50000），整个递归共用一份预算；时间用完就停，已经传完的留着，报告里写明是超时。
- 递归时逐个路径检查受保护目录：`~/.ssh` 和 magpie 配置目录里的文件既不会被 `put` 带走，也不会被 `get` 写进去——即使传的是它们的上层目录。

### 其他

- 递归传输不保留权限、属主、mtime，不续传；符号链接、管道、设备文件跳过并计入报告。
- `walkLocalTree` / `collectRemoteTree` / `insideGuardDirs` 补了纯逻辑测试。

## 0.7.0

### 新增

- 读 `~/.ssh/config`：主机记录里只填一个 `Host` 别名，`HostName`、`User`、`Port`、`IdentityFile`、`ProxyJump`、`StrictHostKeyChecking` 会自动补上。记录里自己填了的字段永远优先；端口只在留空或还是默认的 22 时才让 config 的 `Port` 生效。
- 跳板机：页面加了「跳板机」一栏，也可以直接写 `~/.ssh/config` 的 `ProxyJump`。经 ssh2 的 `forwardOut` 从跳板开一条通道，目标机的连接复用键里包含跳板链。只支持一跳，多跳压平成一跳。
- keyboard-interactive 登录：只给 PAM / 键盘交互、不给 `password` 认证的服务器，现在会用密码回答提示。验证码类提示仍然过不去（要人看手机）。

### 修复

- 主机没填「用户」时按本机登录名登录，不再报 `Invalid username`（ssh2 不接受空用户名）。
- 跳板机的凭据优先取页面里同名或同主机的那条记录，取不到才退到 `~/.ssh/config` 的 `IdentityFile` 和 ssh-agent；连不上跳板时错误里写明是跳板机，不再只丢一个 `ECONNREFUSED`。

### 其他

- 连接池的键用补好缺省值之后的身份：别名和它的真名、config 给的端口，会复用同一条连接。

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
