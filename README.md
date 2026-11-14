# magpie-ssh

在 magpie 侧边栏里管理 SSH 主机，并把这些主机交给所有 agent 用：插件注册 `hosts`、`check`、`run`、`put`、`get` 五个工具，magpie 汇成自己的 MCP 服务器。

连的是 `ssh2`（纯 JS，不依赖系统 ssh），支持三种认证：密码、私钥、ssh agent。主机和凭据只存一份，在这个插件的 `options.hosts` 上（`~/.config/magpie/plugins.json`）；工具每次调用重新读，页面里改了立刻生效。

## 装

```bash
magpie plugin add "github:ltsj/magpie-ssh"   # 从仓库装，自动装依赖
magpie plugin update magpie-ssh             # 以后升级
```

文件夹装法（改代码时用）：`magpie plugin add C:/path/to/magpie-ssh`，先在该目录 `pnpm install`——文件夹插件不在 magpie 的 `plugins/` 项目里，`ssh2` 得装在插件自己的 `node_modules`。还没发到 npm。

## agent 里用

magpie 会把每个插件的工具作为独立 MCP 服务器写进各 agent 的配置：

```
http://127.0.0.1:3425/mcp/magpie/tools/magpie-ssh
```

omp / codex / pi / dsh / workbuddy 装好即写入，**重启 agent** 后就能调用。这个地址下的工具名是插件自己的 `hosts`、`check`、`run`、`put`、`get`；magpie 的汇总地址 `/mcp/magpie/tools` 才带 `magpie-ssh_` 前缀。别的 MCP 客户端：

```bash
claude mcp add --transport http magpie-ssh http://127.0.0.1:3425/mcp/magpie/tools/magpie-ssh
```

## 页面

侧边栏「插件」分组里的 **SSH 主机**：名称、主机、端口、用户、密码（或私钥路径）、主机指纹校验、备注，点添加。行内可编辑、可删除（删除要点两次）。

页面在沙箱里跑（`connect-src 'none'`），没有网络也不能连插件宿主，所以**不能自己测连接**，只负责写设置。要验证一台主机，让 agent 调 `check`。同理，页面不能生成密钥，也不读 `~/.ssh`。

## 工具

下表用的是 magpie 汇总地址里的名字；agent 自己的服务器里去掉 `magpie-ssh_` 前缀（`check`、`run` 等）。

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `magpie-ssh_hosts` | 无 | 列出主机（名称、地址、认证方式，不含凭据） |
| `magpie-ssh_check` | `host` | 只握手，回报是否连得上、耗时、服务器指纹（`ssh-ed25519 SHA256:…`） |
| `magpie-ssh_run` | `host`, `command`, `timeoutMs?`, `maxChars?` | 执行一条命令，回退出码和输出 |
| `magpie-ssh_put` | `host`, `local`, `remote` | SFTP 上传 |
| `magpie-ssh_get` | `host`, `remote`, `local` | SFTP 下载 |

`host` 填名称、地址或记录 id 都行，不分大小写；`*` 或 `all` 表示全部主机，也可以逗号分隔多台（`"OpenWrt,Debian"`），`run` 和 `check` 都支持。批量时每台机器一段，按 `== 名称 (user@host:port) ==` 分开，八台一组并发，`run` 末尾再加一行汇总（`总计 4/5 成功，失败：Debian(exit -1)`）。

时间预算（magpie 每个工具最多 55 秒）：

| 工具 | 默认 | 上限 |
| --- | --- | --- |
| `run` | 45 秒 | 50 秒（`timeoutMs`） |
| `run` / `check` 批量 | 45 秒 | 50 秒，**所有主机共享一份** |
| `check` | 8 秒 | — |
| `put` / `get` | 45 秒 | — |

连接和握手花掉的时间从同一份预算里扣，所以一次调用不会越过 magpie 的 55 秒被强行掐断。输出超过 4MB 只丢弃后续内容并在首行注明，**命令继续跑**，不会被杀；文本默认再截到 16000 字符（`maxChars`，上限 200000），截断不会切出半个 emoji。stdout 和 stderr 按到达顺序拼在一起，stderr 在它出现的位置标 `[stderr]`——同一瞬间写出的两路可能被远端合并成一段，隔开写的就分得清。
调用被取消（宿主掐断）时回 `exit -1（调用被取消，连接已断开）`，和超时、成功三者互不冒充。

出错一律回文本，不抛异常：没有这台主机、缺参数、连不上、认证失败、指纹对不上，都变成 `exit -1` 加一句原因——宿主不会被弄挂（magpie 加载插件时会拿空参数探一次每个工具，抛异常会把整个插件标成失败）。

插件选项里 `auditLog: true` 时，每次 `run`/`check`/`put`/`get` 往 `~/.config/magpie/magpie-ssh-audit.log` 追加一行 JSON（时间、工具、主机、命令、结果首行），多 agent 共用一台 root 机器时能查谁跑了什么。默认关闭；日志里不含密码。

## 认证与主机指纹

主机记录里 `password`、`identityFile` 二选一，都没有就用 ssh agent（`SSH_AUTH_SOCK`，Windows 上默认管道 `\\.\pipe\openssh-ssh-agent`）。`identityFile` 和 `put`/`get` 的 `local` 里 `~` 会展开；`put`/`get` 的远端路径写 `~/x` 会按远端 home 展开（SFTP 自己不做这件事），和 `run` 里 `~` 由远端 shell 展开的效果一致。

`strictHostKeyChecking`：

| 值 | 行为 |
| --- | --- |
| `accept-new`（页面默认） | 第一次见就写进 `~/.ssh/known_hosts`；写过之后再变就拒绝 |
| `yes` | 必须在 `known_hosts` 里且一致，否则拒绝并说明 |
| 空（「交给 ssh 默认」） | 放行，不落盘、不校验 |

指纹按「规范身份」比：22 端口就是主机名，其他端口是 `[host]:port`——所以同一台机器的 22 端口有记录，不会让你连 2222 端口时被误报成「指纹变了」。`known_hosts` 的哈希行（`|1|salt|hmac`，Linux 上 `HashKnownHosts` 默认会写）能正确复算匹配；`@revoked` 命中直接拒绝。不支持的：`*.example.com` 这类通配条目、证书主机（`@cert-authority`）——遇到这类行按「没有记录」处理，`accept-new` 会补一行明文记录，`yes` 会让先用密码/私钥连一次。指纹真变了的时候，确认机器没换过再删掉 `known_hosts` 里那一行。

## 安全边界

- 密码是以**明文**存在 `~/.config/magpie/plugins.json` 里的（magpie 的 `plugin-auth.json` 也这样）。不想明文就改用私钥或 agent，把密码字段留空。
- agent 一旦能用这些主机，就能以你的身份在那些机器上执行任意命令。别把 root 主机随手加进来。
- `magpie plugin rm` 会把插件设置一起删掉，删之前先备份 `hosts`。
- 工具以你的权限运行，结果只回给调用它的那个 agent。

## 测试

```bash
node test/smoke.mjs
```

只测纯逻辑：读 `plugins.json` 的三种兜底、连接配置与认证优先级、`known_hosts` 指纹判断、`host` 多选解析、输出截断与 stdout/stderr 顺序、审计开关、工具在坏参数和空配置下回文本而不抛。真连接不测（要真主机和凭据）。CI 在 `.github/workflows/ci.yml`（安装、跑上面的测试、`npm pack --dry-run`）。

要 Node ≥18（或 magpie 自带的 Bun）；唯一的依赖是 `ssh2`，没有原生构建。

## 许可

MIT

## 开发注意

- 入口文件只导出工厂。`index.mjs` 导出的**每个**函数都会被 magpie 当插件工厂调用一次，辅助函数放 `lib.mjs`，否则整个插件标成 failed。
- 工具的 `execute` 不许抛异常：坏参数一律回文本。
- 工具名 `<插件短名>_<工具名>`，文件夹装的插件用文件夹名当短名。
- 改完 `node test/smoke.mjs`，然后 `magpie plugin update magpie-ssh`（Git 装法）才会生效到正在跑的 magpie。
