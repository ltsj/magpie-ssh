<div align="center">

# magpie-ssh

**在 magpie 侧边栏里维护 SSH 主机表，把这张表交给每个 agent 用**

密码 / 私钥（口令也行）/ ssh agent · 连接复用 · 批量执行 · known_hosts 指纹校验 · 可选审计日志

[![CI](https://github.com/ltsj/magpie-ssh/actions/workflows/ci.yml/badge.svg)](https://github.com/ltsj/magpie-ssh/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](package.json)

[安装](#安装) · [在-agent-里用](#在-agent-里用) · [工具](#工具) · [认证与指纹](#认证与主机指纹) · [安全边界](#安全边界) · [开发](#开发)

</div>

---

## 特性

- **一份主机表，所有 agent 共用** — 插件注册 `hosts`、`check`、`run`、`put`、`get` 五个工具，magpie 把它们汇成自己的 MCP 服务器，omp / codex / pi / dsh / workbuddy 装好即用。
- **纯 JS 的 SSH** — 只依赖 `ssh2`，不调用系统 ssh，没有原生构建，Node ≥18 或 magpie 自带的 Bun 都能跑。
- **三种认证** — 密码、私钥（带口令的也行）、ssh agent，按这个顺序取第一个配了的。
- **连接复用** — 同一台主机第一次握手 0.3~1 秒，之后约 0.1 秒；空闲 60 秒自动断开。
- **真校验主机指纹** — 按 `known_hosts` 的规范身份比对，认哈希行和 `@revoked`；首次信任写在握手签名校验通过之后。
- **批量执行** — `host` 传 `*` 或逗号分隔多台，八台并发、共享一份时间预算，末尾给成功/失败汇总。
- **出错不抛异常** — 坏参数、连不上、认证失败、指纹对不上，一律回 `exit -1` 加一句原因。
- **可选审计日志** — 开着时每次调用记一行 JSON，权限 0600，长到 2 MB 自动轮转。
- **主机表能带着走** — 页面里可以导出成 JSON，也能把一段 JSON 按名称合并回来（同名覆盖、其余追加）。

---

## 安装

```bash
magpie plugin add "github:ltsj/magpie-ssh"   # 从仓库装，自动装依赖
magpie plugin update magpie-ssh             # 以后升级
```

| 装法 | 命令 | 什么时候用 |
| --- | --- | --- |
| 仓库 | `magpie plugin add "github:ltsj/magpie-ssh"` | 日常 |
| 本地文件夹 | 先在该目录 `pnpm install`，再 `magpie plugin add C:/path/to/magpie-ssh` | 改代码 |

文件夹装的插件不在 magpie 的 `plugins/` 项目里，`ssh2` 得装在插件自己的 `node_modules`。目前还没发到 npm。

## 在 agent 里用

magpie 会把每个插件的工具作为独立 MCP 服务器写进各 agent 的配置：

```
http://127.0.0.1:3425/mcp/magpie/tools/magpie-ssh
```

装好即写入，**重启 agent** 后生效。这个地址下的工具名是插件自己的 `hosts`、`check`、`run`、`put`、`get`；magpie 的汇总地址 `/mcp/magpie/tools` 才带 `magpie-ssh_` 前缀。别的 MCP 客户端：

```bash
claude mcp add --transport http magpie-ssh http://127.0.0.1:3425/mcp/magpie/tools/magpie-ssh
```

## 页面

侧边栏「插件」分组里的 **SSH 主机**：名称、主机、端口、用户、密码、私钥路径与口令、主机指纹校验、备注；行内可编辑，删除要点两次。

页面在沙箱里跑（`connect-src 'none'`），没有网络、连不到插件宿主，所以它**只负责写设置**：不能自己测连接，不能生成密钥，也不读 `~/.ssh`。要验证一台主机连不连得上，让 agent 调 `check`。

主机表存在插件设置里，`magpie plugin rm` 会连它一起删掉。页面底部「导入 / 导出」可以把整张表导出成 JSON（含明文密码和口令），或把一段 JSON 粘回去按名称合并：同名的覆盖、其余的追加。

---

## 工具

下表用的是 magpie 汇总地址里的名字；agent 自己的服务器里去掉 `magpie-ssh_` 前缀。

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `magpie-ssh_hosts` | 无 | 列出主机（名称、地址、认证方式，不含凭据） |
| `magpie-ssh_check` | `host`, `timeoutMs?` | 只握手不发命令，回报能否连上、耗时、服务器指纹（`ssh-ed25519 SHA256:…`） |
| `magpie-ssh_run` | `host`, `command`, `timeoutMs?`, `maxChars?` | 执行一条命令，回退出码和输出 |
| `magpie-ssh_put` | `host`, `local`, `remote` | SFTP 上传 |
| `magpie-ssh_get` | `host`, `remote`, `local` | SFTP 下载 |

### host 怎么写

填名称、地址或记录 id 都行，不分大小写。`*` 或 `all` 表示全部主机，也可以用逗号分隔多台（`"OpenWrt,Debian"`），`run` 和 `check` 都支持。批量时每台机器一段，按 `== 名称 (user@host:port) ==` 分开，八台一组并发，`run` 末尾再加一行汇总（`总计 4/5 成功，失败：Debian(exit -1)`）。

### 时间预算

magpie 给每个工具 55 秒，插件自己留出余量：

| 调用 | 默认 | 上限 |
| --- | --- | --- |
| `run` 单台 | 45 秒 | 50 秒（`timeoutMs`） |
| `run` 批量 | 45 秒 | 50 秒，**所有主机共享一份** |
| `check` | 8 秒 | 50 秒（`timeoutMs`），批量时共享 |
| `put` / `get` | 45 秒 | — |

连接和握手花掉的时间从同一份预算里扣，所以一次调用不会越过 magpie 的 55 秒被强行掐断。

### 输出、退出码与报错

- 输出超过 4MB 只丢弃后续内容并在退出码那行下面注明，**命令继续跑**，不会被杀。
- 文本默认再截到 16000 字符（`maxChars`，上限 200000），截断不会切出半个 emoji。
- `stdout` 和 `stderr` 按到达顺序拼在一起，`stderr` 在它出现的位置标 `[stderr]`。同一瞬间写出的两路可能被远端合并成一段，隔开写的就分得清。
- 调用被取消（宿主掐断）回 `exit -1（调用被取消，连接已断开）`，和超时、成功三者互不冒充。
- 命令被信号杀死（`kill`、OOM）或连接在拿到退出码之前断了，也是 `exit -1`，并在 `[stderr]` 里写明原因——不会冒充 `exit 0`。
- 没有这台主机、缺参数、连不上、认证失败、指纹对不上，全部变成 `exit -1` 加一句原因，不抛异常（magpie 加载插件时会拿空参数探一次每个工具，抛异常会把整个插件标成失败）。

### 连接复用

同一台主机的连接在调用之间留着，远端看到的是同一个客户端端口。认证信息变了（换密码、换私钥、换用户、换端口）就是另一条连接。多个 agent 同时用时在同一条连接上开多个会话，各自有自己的通道。

命令超时或被取消时只作废**自己那条会话**：远端那条命令还在跑，把它留给下一条命令不合适，但同主机其他并发调用不受影响。如果整条连接已经坏了（socket 断了），等最后一个使用者放手才真的关掉——不会出现一个调用超时把别人的调用一起掐断的情况。

想每次都用新连接：`magpie plugin options magpie-ssh '{"hosts":[…],"connectionReuse":false}'`（插件宿主在选项变更后重启，重启后生效）。

---

## 认证与主机指纹

### 三种认证

主机记录里 `password`、`identityFile` 按顺序取第一个配了的，都没有就用 ssh agent（`SSH_AUTH_SOCK`，Windows 上默认管道 `\\.\pipe\openssh-ssh-agent`）。

`identityFile` 和 `put`/`get` 的 `local` 里 `~` 会展开；`put`/`get` 的远端路径写 `~` 或 `~/x` 会按远端 home 展开（SFTP 自己不做这件事），和 `run` 里 `~` 由远端 shell 展开的效果一致。私钥必须是个小于 1 MB 的普通文件——指向 `/dev/zero` 之类会在宿主事件循环上同步卡死，所以直接拒。

私钥带口令时把 `passphrase` 一起填上（页面上是「私钥口令」那一栏）。它只交给 ssh2 解私钥，不会当密码去登录；口令和密码一样明文存在 `plugins.json` 里。

### 指纹策略

| `strictHostKeyChecking` | 行为 |
| --- | --- |
| `accept-new`（页面默认，没填也是它） | 第一次见就等握手签名校验通过后写进 `~/.ssh/known_hosts`；写过之后再变就拒绝 |
| `yes` | 必须在 `known_hosts` 里且一致，否则拒绝并说明 |
| `no`（「不校验」） | 完全不管 `known_hosts`：不比对、也不登记。只有 `@revoked` 仍然生效 |

指纹按「规范身份」比：22 端口就是主机名，其他端口是 `[host]:port`——所以同一台机器的 22 端口有记录，不会让你连 2222 端口时被误报成「指纹变了」。`known_hosts` 的哈希行（`|1|salt|hmac`，Linux 上 `HashKnownHosts` 默认会写）能正确复算匹配。`@revoked` 是全局的：只比钥匙、不看主机字段，命中就拒，连「不校验」的主机也拒。登记发生在握手签名校验之后，路上塞一把假钥匙不会被钉进 `known_hosts`。

不支持的：`*.example.com` 这类通配条目、证书主机（`@cert-authority`）——遇到这类行按「没有记录」处理。指纹真变了的时候，确认机器没换过再删掉 `known_hosts` 里那一行。

---

## 已知限制

- **不读 `~/.ssh/config`** — 别名、`ProxyJump` 跳板机、`LocalForward` 都不会生效，主机字段得自己填全。
- **不支持 keyboard-interactive** — 登录时还要再输一次验证码/密码的服务器连不上（`ssh2` 的 `tryKeyboard` 没开）。
- **`put` / `get` 只传单个文件** — 不递归目录、不续传、没有进度，大文件只靠 45 秒超时兜底。
- **页面不能测连接、不能生成密钥** — 沙箱里没有网络，也不读 `~/.ssh`。

---

## 安全边界

- 密码、私钥口令都是以**明文**存在 `~/.config/magpie/plugins.json` 里的（magpie 的 `plugin-auth.json` 也这样）。不想明文就改用 agent，把密码和口令字段留空；导出主机表得到的 JSON 里同样是明文。
- agent 一旦能用这些主机，就能以你的身份在那些机器上执行任意命令。别把 root 主机随手加进来。
- `put`/`get` 的本机路径是**真**的本机路径，没有沙箱：`get` 能覆盖本机任何文件，`put` 能把本机任何文件传出去。唯一的护栏是：`get` 不许往 `~/.ssh` 和 magpie 配置目录（`plugins.json` 就在里面）写，`put` 不许从这两个目录取文件。其余路径照旧——被内容注入的 agent 仍可能把别的文件带走，传文件前自己看清楚参数。
- `magpie plugin rm` 会把插件设置一起删掉，删之前先备份 `hosts`。
- 工具以你的权限运行，结果只回给调用它的那个 agent。
- 插件选项里 `auditLog: true` 时，每次 `run`/`check`/`put`/`get` 往 `~/.config/magpie/magpie-ssh-audit.log` 追加一行 JSON（时间、工具、主机、命令、结果首行），多 agent 共用一台 root 机器时能查谁跑了什么。默认关闭；文件是 `0600`、目录 `0700`，写到 2 MB 就转成 `magpie-ssh-audit.log.1` 再写（只留一代）。**命令原文会原样记下来**（`mysql -p…`、`curl -H "Authorization: …"` 都会落盘），要带凭据的命令就别开日志。

---

## 目录结构

```text
.
├── index.mjs                     # 插件工厂：五个工具的定义、参数与回文本的兜底
├── lib.mjs                       # 纯逻辑：主机表、known_hosts、连接池、SFTP、审计
├── page/                         # 侧边栏页面（沙箱里跑，只能改 options）
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── icon.svg
├── test/smoke.mjs                # 纯逻辑测试
├── .github/workflows/ci.yml      # CI：ubuntu/windows × node 18/20/22，跑测试 + npm pack --dry-run
├── .gitattributes                # 统一 LF：检出时不换成 CRLF
├── package.json                  # 插件清单 + magpie.page 元数据
├── pnpm-workspace.yaml           # 禁用 ssh2 / cpu-features 的构建脚本（有纯 JS 回退）
├── CHANGELOG.md
└── README.md
```

---

## 开发

```bash
pnpm install
node test/smoke.mjs        # 或者 pnpm test
```

只测纯逻辑：读 `plugins.json` 的各种兜底与坏文件报错、连接配置与认证优先级（含私钥口令）、`known_hosts` 指纹判断、`host` 多选解析、输出截断与 stdout/stderr 顺序、审计开关与轮转、连接放回与「不连坐」、本机路径护栏、工具在坏参数和空配置下回文本而不抛。真连接不测（要真主机和凭据）。

改代码时注意三条硬约束：

- 入口文件只导出工厂。`index.mjs` 导出的**每个**函数都会被 magpie 当插件工厂调用一次，辅助函数放 `lib.mjs`，否则整个插件标成 failed。
- 工具的 `execute` 不许抛异常：坏参数一律回文本。
- 工具名是 `<插件短名>_<工具名>`，文件夹装的插件用文件夹名当短名。

CI 在 push 到 `master` 和 PR 时跑：`pnpm install --frozen-lockfile`、`node test/smoke.mjs`、`npm pack --dry-run`，平台是 ubuntu 和 windows、Node 18/20/22 六个组合——`engines` 说 >= 18，代码里也有 Windows 专属分支（ssh-agent 的命名管道、路径大小写折叠），只跑一个组合等于没测。改完 `magpie plugin update magpie-ssh`（Git 装法）才会生效到正在跑的 magpie。

## 许可

MIT
