<div align="center">

# 🪶 magpie-ssh

**在 magpie 侧边栏里维护 SSH 主机表，把这张表交给每个 agent 用**

密码 / 私钥（口令也行）/ ssh agent · keyboard-interactive · 跳板机 · 连接复用 · 批量执行 · known_hosts 指纹校验 · 可选审计日志

[![CI](https://github.com/ltsj/magpie-ssh/actions/workflows/ci.yml/badge.svg)](https://github.com/ltsj/magpie-ssh/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](package.json)

[✨ 特性](#-特性) · [📦 安装](#-安装) · [🤖 在 agent 里用](#-在-agent-里用) · [🖥️ 页面](#-页面) · [🛠️ 工具](#-工具) · [🔐 认证与指纹](#-认证与主机指纹) · [🛡️ 安全边界](#-安全边界) · [🧑‍💻 开发](#-开发)

</div>

---

## ✨ 特性

- **一份主机表，所有 agent 共用** — 插件注册 `hosts`、`check`、`run`、`put`、`get` 五个工具，magpie 把它们汇成自己的 MCP 服务器，omp / codex / pi / dsh / workbuddy 装好即用。
- **纯 JS 的 SSH** — 只依赖 `ssh2`，不调用系统 ssh，没有原生构建，Node ≥18 或 magpie 自带的 Bun 都能跑。
- **三种认证** — 密码、私钥（带口令的也行）、ssh agent，按这个顺序取第一个配了的；只给 keyboard-interactive 的服务器也能用密码登录。
- **读 `~/.ssh/config`** — 主机只填别名，`HostName`、`User`、`Port`、`IdentityFile`、`ProxyJump`、`StrictHostKeyChecking` 自动补上；记录里自己填了的字段永远优先。
- **跳板机** — 页面上填 `user@host:port`，或者直接用 `~/.ssh/config` 里的 `ProxyJump`，经跳板开一条通道连目标机。
- **传文件也传目录** — `put` / `get` 遇到目录就递归，逐文件传，单个失败不影响其他；符号链接和特殊文件跳过，时间用完给部分结果。
- **连接复用** — 同一台主机第一次握手 0.3~1 秒，之后约 0.1 秒；空闲 60 秒自动断开。
- **真校验主机指纹** — 按 `known_hosts` 的规范身份比对，认哈希行和 `@revoked`；首次信任写在握手签名校验通过之后。
- **批量执行** — `host` 传 `*` 或逗号分隔多台，八台并发、共享一份时间预算，末尾给成功/失败汇总。
- **出错不抛异常** — 坏参数、连不上、认证失败、指纹对不上，一律回 `exit -1` 加一句原因。
- **可选审计日志** — 开着时每次调用记一行 JSON，权限 0600，长到 2 MB 自动轮转。
- **主机表能带着走** — 页面里可以导出成 JSON，也能把一段 JSON 按名称合并回来（同名覆盖、其余追加）。

---

## 📦 安装

```bash
magpie plugin add "github:ltsj/magpie-ssh"   # 从仓库装，自动装依赖
magpie plugin update magpie-ssh             # 以后升级
```

| 装法 | 命令 | 什么时候用 |
| --- | --- | --- |
| 仓库 | `magpie plugin add "github:ltsj/magpie-ssh"` | 日常 |
| 本地文件夹 | 先在该目录 `pnpm install`，再 `magpie plugin add C:/path/to/magpie-ssh` | 改代码 |

文件夹装的插件不在 magpie 的 `plugins/` 项目里，`ssh2` 得装在插件自己的 `node_modules`。

目前还没发到 npm。维护者要发的话（本机 `npm whoami` 会报 `ENEEDAUTH`，先登录）：

```bash
npm login
npm publish
```

发完把上面的安装命令换成 `magpie plugin add magpie-ssh`。

## 🤖 在 agent 里用

magpie 会把每个插件的工具作为独立 MCP 服务器写进各 agent 的配置：

```
http://127.0.0.1:3425/mcp/magpie/tools/magpie-ssh
```

装好即写入，**重启 agent** 后生效。这个地址下的工具名是插件自己的 `hosts`、`check`、`run`、`put`、`get`；magpie 的汇总地址 `/mcp/magpie/tools` 才带 `magpie-ssh_` 前缀。别的 MCP 客户端：

```bash
claude mcp add --transport http magpie-ssh http://127.0.0.1:3425/mcp/magpie/tools/magpie-ssh
```

## 🖥️ 页面

侧边栏「插件」分组里的 **SSH 主机**：名称、主机、端口、用户、跳板机、密码、私钥路径与口令、主机指纹校验、备注；行内可编辑，删除要点两次。主机可以只填 `~/.ssh/config` 里的别名，其余交给 config。

页面在沙箱里跑（`connect-src 'none'`），没有网络、连不到插件宿主，所以它**只负责写设置**：不能自己测连接，不能生成密钥，也不读 `~/.ssh`。要验证一台主机连不连得上，让 agent 调 `check`。

主机表存在插件设置里，`magpie plugin rm` 会连它一起删掉。页面底部「导入 / 导出」可以把整张表导出成 JSON（含明文密码和口令），或把一段 JSON 粘回去按名称合并：同名的覆盖、其余的追加。

---

## 🛠️ 工具

下表用的是 magpie 汇总地址里的名字；agent 自己的服务器里去掉 `magpie-ssh_` 前缀。

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `magpie-ssh_hosts` | 无 | 列出主机（名称、地址、认证方式，不含凭据） |
| `magpie-ssh_check` | `host`, `timeoutMs?` | 只握手不发命令，回报能否连上、耗时、服务器指纹（`ssh-ed25519 SHA256:…`） |
| `magpie-ssh_run` | `host`, `command`, `timeoutMs?`, `maxChars?` | 执行一条命令，回退出码和输出 |
| `magpie-ssh_put` | `host`, `local`, `remote`, `timeoutMs?` | SFTP 上传文件或目录 |
| `magpie-ssh_get` | `host`, `remote`, `local`, `timeoutMs?` | SFTP 下载文件或目录 |

### 传文件与目录

`local` / `remote` 是文件就直接传，是目录就递归，一个文件一条 SFTP 传输：

- 单个文件失败不影响其他；末尾一行 `上传 12/14 个文件（3.4 MB）→ /srv/app`，有失败时回 `exit -1`，`[stderr]` 里列前 20 条。
- 符号链接、管道、设备文件跳过，报告里给个数；不跟进去，也不复制链接本身。
- 目录里的内容放进目标目录本身，不额外套一层目录名（`put ~/app /srv/app` 得到 `/srv/app/main.js`）。远端目录逐级建；本机目录也会建。空目录不建（没有文件可传）。
- 只传内容：**不保留权限、属主、mtime**，也不做校验和。
- 没有续传和进度条。时间预算用完就停，传完的留着，报告里写明超时，**退出码是 `exit -1`**——没传完就不算成功；加大 `timeoutMs` 再跑一次会重传已经传过的文件。
- 受保护目录（`~/.ssh`、magpie 配置目录）里的文件按路径逐个跳过，即使传的是它们的上层目录。

### host 怎么写

填名称、地址或记录 id 都行，不分大小写。填的地址也可以是 `~/.ssh/config` 里的 `Host` 别名：`HostName`、`User`、`Port`、`IdentityFile`、`ProxyJump` 会作为缺省值补进来（记录里填了的优先，端口只在留空或还是 22 时才用 config 的）。`*` 或 `all` 表示全部主机，也可以用逗号分隔多台（`"OpenWrt,Debian"`），`run` 和 `check` 都支持。批量时每台机器一段，按 `== 名称 (user@host:port) ==` 分开，八台一组并发，`run` 末尾再加一行汇总（`总计 4/5 成功，失败：Debian(exit -1)`）。

### 时间预算

magpie 给每个工具 55 秒，插件自己留出余量：

| 调用 | 默认 | 上限 |
| --- | --- | --- |
| `run` 单台 | 45 秒 | 50 秒（`timeoutMs`） |
| `run` 批量 | 45 秒 | 50 秒，**所有主机共享一份** |
| `check` | 8 秒 | 50 秒（`timeoutMs`），批量时共享 |
| `put` / `get` | 45 秒 | 50 秒（`timeoutMs`），整个递归共用 |

连接和握手花掉的时间从同一份预算里扣，所以一次调用不会越过 magpie 的 55 秒被强行掐断。

### 输出、退出码与报错

- 输出超过 4MB 只丢弃后续内容并在退出码那行下面注明，**命令继续跑**，不会被杀。
- 文本默认再截到 16000 字符（`maxChars`，上限 200000），截断不会切出半个 emoji。
- `stdout` 和 `stderr` 各自保序，两路之间按到达顺序拼；`stderr` 在它到达的位置标 `[stderr]`。两路在同一瞬间写的内容到达顺序不保证（SSH 把它们放在两个流里），隔开写的就分得清。
- 调用被取消（宿主掐断）回 `exit -1（调用被取消，连接已断开）`，和超时、成功三者互不冒充。
- 命令被信号杀死（`kill`、OOM）或连接在拿到退出码之前断了，也是 `exit -1`，并在 `[stderr]` 里写明原因——不会冒充 `exit 0`。
- 没有这台主机、缺参数、连不上、认证失败、指纹对不上，全部变成 `exit -1` 加一句原因，不抛异常（magpie 加载插件时会拿空参数探一次每个工具，抛异常会把整个插件标成失败）。

### 连接复用

同一台主机的连接在调用之间留着，远端看到的是同一个客户端端口。认证信息变了（换密码、换私钥、换用户、换端口）就是另一条连接。多个 agent 同时用时在同一条连接上开多个会话，各自有自己的通道。

命令超时或被取消时只作废**自己那条会话**：远端那条命令还在跑，把它留给下一条命令不合适，但同主机其他并发调用不受影响。如果整条连接已经坏了（socket 断了），等最后一个使用者放手才真的关掉——不会出现一个调用超时把别人的调用一起掐断的情况。

想每次都用新连接：`magpie plugin options magpie-ssh '{"hosts":[…],"connectionReuse":false}'`（插件宿主在选项变更后重启，重启后生效）。

---

## 🔐 认证与主机指纹

### 三种认证

主机记录里没填 `user` 时按本机登录名登录（和 OpenSSH 一样）。`password`、`identityFile` 按顺序取第一个配了的，都没有就用 ssh agent（`SSH_AUTH_SOCK`，Windows 上默认管道 `\\\\.\\pipe\\openssh-ssh-agent`）。

`identityFile` 和 `put`/`get` 的 `local` 里 `~` 会展开；`put`/`get` 的远端路径写 `~` 或 `~/x` 会按远端 home 展开（SFTP 自己不做这件事），和 `run` 里 `~` 由远端 shell 展开的效果一致。私钥必须是个小于 1 MB 的普通文件——指向 `/dev/zero` 之类会在宿主事件循环上同步卡死，所以直接拒。

私钥带口令时把 `passphrase` 一起填上（页面上是「私钥口令」那一栏）。它只交给 ssh2 解私钥，不会当密码去登录；口令和密码一样明文存在 `plugins.json` 里。

### keyboard-interactive

有些服务器（多半是 PAM）不给 `password` 认证，只给 keyboard-interactive。配了密码时会开 `tryKeyboard`，把同一个密码当每个提示的回答；私钥和 agent 认证不开这个。验证码、二次确认这类提示过不去——那要人看手机，agent 代替不了。

### 从 `~/.ssh/config` 补缺省值

只读 `Host` 块和 `Host` 之外的全局默认；`Match` 块整块跳过，`%d`、`%h` 这类 token 不展开。一个块里只要有一个正向模式命中、且没被 `!` 模式排除就生效，同一个键以最先出现的值为准（和 OpenSSH 一样）。

| 记录里的字段 | config 里的键 | 谁优先 |
| --- | --- | --- |
| `host` | `HostName` | 别名先按 config 换成本名；记录里直接写 IP/域名就不查 config |
| `user` | `User` | 记录填了用记录 |
| `port` | `Port` | 记录填了且不是 22 用记录；留空或 22 时用 config |
| `identityFile` | `IdentityFile` | 记录填了用记录；config 写了多行取第一把 |
| `proxyJump` | `ProxyJump` | 记录填了用记录 |
| `strictHostKeyChecking` | `StrictHostKeyChecking` | 记录不是默认的 `accept-new` 时用记录 |

跳板机只支持一跳：`ProxyJump a,b` 这种链只用第一跳。跳板自己的别名、用户、端口、私钥照样按 config 解析，但它不再往下套跳板。

跳板机的登录凭据优先取页面里同名（或同主机）的那条主机记录——把跳板也当普通主机存一条，密码 / 私钥 / 口令就能直接用。记录里没有的字段再让 `~/.ssh/config` 和 ssh-agent 补；`user@host:port` 里写了用户就用写的那个。

### 指纹策略

| `strictHostKeyChecking` | 行为 |
| --- | --- |
| `accept-new`（页面默认，没填也是它） | 第一次见就等握手签名校验通过后写进 `~/.ssh/known_hosts`；写过之后再变就拒绝 |
| `yes` | 必须在 `known_hosts` 里且一致，否则拒绝并说明 |
| `no`（「不校验」） | 完全不管 `known_hosts`：不比对、也不登记。只有 `@revoked` 仍然生效 |

指纹按「规范身份」比：22 端口就是主机名，其他端口是 `[host]:port`——所以同一台机器的 22 端口有记录，不会让你连 2222 端口时被误报成「指纹变了」。`known_hosts` 的哈希行（`|1|salt|hmac`，Linux 上 `HashKnownHosts` 默认会写）能正确复算匹配。`@revoked` 是全局的：只比钥匙、不看主机字段，命中就拒，连「不校验」的主机也拒。登记发生在握手签名校验之后，路上塞一把假钥匙不会被钉进 `known_hosts`。

不支持的：`*.example.com` 这类通配条目、证书主机（`@cert-authority`）——遇到这类行按「没有记录」处理。指纹真变了的时候，确认机器没换过再删掉 `known_hosts` 里那一行。

---

## ⚠️ 已知限制

- **跳板机只支持一跳** — `ProxyJump a,b` 这样的多跳链只用第一跳；`LocalForward`、config 里的 `Match` 块、`%d`/`%h` 这类 token 都不支持。
- **验证码过不去** — keyboard-interactive 只用密码回答，OTP / 二次确认的服务器连不上。
- **`put` / `get` 不续传、不保属性** — 断在中途只能整段重来（已传完的文件会再传一遍），权限、属主、mtime 不保留；符号链接和特殊文件只跳过不复制。
- **页面不能测连接、不能生成密钥** — 沙箱里没有网络，也不读 `~/.ssh`。
- **e2e 的 shell 是回放的** — 进程内 exec 服务端按命令名给固定输出，测的是客户端这条链路，不是真 shell 的怪异行为（信号、编码、超长行）。真机上的 `run` 仍建议先用 `check` 确认连通性。

---

## 🛡️ 安全边界

- 密码、私钥口令都是以**明文**存在 `~/.config/magpie/plugins.json` 里的（magpie 的 `plugin-auth.json` 也这样）。不想明文就改用 agent，把密码和口令字段留空；导出主机表得到的 JSON 里同样是明文。
- agent 一旦能用这些主机，就能以你的身份在那些机器上执行任意命令。别把 root 主机随手加进来。
- `put`/`get` 的本机路径是**真**的本机路径，没有沙箱：`get` 能覆盖本机任何文件，`put` 能把本机任何文件传出去。唯一的护栏是：`get` 不许往 `~/.ssh` 和 magpie 配置目录（`plugins.json` 就在里面）写，`put` 不许从这两个目录取文件；递归时逐个文件查这条规则，但传一个上层目录仍会把里面其他文件一起带走（受保护目录除外）。被内容注入的 agent 仍可能把别的文件传出去，传文件前自己看清楚参数。
- `magpie plugin rm` 会把插件设置一起删掉，删之前先备份 `hosts`。
- 工具以你的权限运行，结果只回给调用它的那个 agent。
- 插件选项里 `auditLog: true` 时，每次 `run`/`check`/`put`/`get` 往 `~/.config/magpie/magpie-ssh-audit.log` 追加一行 JSON（时间、工具、主机、命令、结果首行），多 agent 共用一台 root 机器时能查谁跑了什么。默认关闭；文件是 `0600`、目录 `0700`，写到 2 MB 就转成 `magpie-ssh-audit.log.1` 再写（只留一代）。**命令原文会原样记下来**（`mysql -p…`、`curl -H "Authorization: …"` 都会落盘），要带凭据的命令就别开日志。

---

## 📁 目录结构

```text
.
├── index.mjs                     # 插件工厂：五个工具的定义、参数与回文本的兜底
├── lib.mjs                       # 纯逻辑：主机表、known_hosts、连接池、SFTP、审计
├── page/                         # 侧边栏页面（沙箱里跑，只能改 options）
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── icon.svg
├── test/
│   ├── smoke.mjs                 # 纯逻辑测试
│   ├── e2e.mjs                   # 真连接：进程内 SFTP 服务端 + put/get 全流程
│   └── e2e-run.mjs               # 真连接：进程内 exec 服务端 + run/批量/超时/复用
├── .github/workflows/ci.yml      # CI：ubuntu/windows × node 18/20/22，跑三套测试 + npm pack --dry-run
├── .gitattributes                # 统一 LF：检出时不换成 CRLF
├── package.json                  # 插件清单 + magpie.page 元数据
├── pnpm-workspace.yaml           # 禁用 ssh2 / cpu-features 的构建脚本（有纯 JS 回退）
├── CHANGELOG.md
└── README.md
```

---

## 🧑‍💻 开发

```bash
pnpm install
node test/smoke.mjs        # 纯逻辑，或者 pnpm test
node test/e2e.mjs          # 真连接：put/get，或者 pnpm run test:e2e
node test/e2e-run.mjs      # 真连接：run，或者 pnpm run test:e2e-run
pnpm run test:all          # 三套一起
```

`test/smoke.mjs` 只测纯逻辑：读 `plugins.json` 的各种兜底与坏文件报错、连接配置与认证优先级（含私钥口令、keyboard-interactive）、`~/.ssh/config` 的别名/通配/排除与跳板机写法、`known_hosts` 指纹判断、`host` 多选解析、输出截断与 stdout/stderr 顺序、审计开关与轮转、连接放回与「不连坐」、本机路径护栏（含递归时的逐文件检查）、本机/远端目录遍历（符号链接与特殊文件跳过）、工具在坏参数和空配置下回文本而不抛。

`test/e2e.mjs` 起一个**进程内**的 ssh2 SFTP 服务端（映射到临时目录），用真的 SSH 连接把 `put` / `get` 跑一遍：单文件往返、嵌套目录与空目录、符号链接跳过、传上层目录时私钥不被带走、时间预算用尽时给部分结果且回 `exit -1`、本机/远端路径不存在时是文本报错。

`test/e2e-run.mjs` 起一个**进程内**的 exec 服务端（命令按名字回放，不是真 shell），把 `run` 那条路跑一遍：退出码透出、stdout/stderr 各自保序且 stderr 就地标记、超过 4MB 只丢内容、`maxChars` 截断、超时、取消、被信号杀死、没拿到退出码就断线、两台主机的批量汇总、`reach` 的指纹、连接复用与超时后作废，以及走 `index.mjs` 工具层的一次 `run` 和审计落盘。

两个 e2e 都不需要真主机、不需要凭据，60 秒看门狗兜底，CI 里跑得动；它们都把 `HOME`、`USERPROFILE`、`XDG_CONFIG_HOME` 全指到临时目录，`known_hosts`、`plugins.json`、审计日志都是假的。

改代码时注意三条硬约束：

- 入口文件只导出工厂。`index.mjs` 导出的**每个**函数都会被 magpie 当插件工厂调用一次，辅助函数放 `lib.mjs`，否则整个插件标成 failed。
- 工具的 `execute` 不许抛异常：坏参数一律回文本。
- 工具名是 `<插件短名>_<工具名>`，文件夹装的插件用文件夹名当短名。

CI 在 push 到 `master` 和 PR 时跑：`pnpm install --frozen-lockfile`、`node test/smoke.mjs`、`node test/e2e.mjs`、`node test/e2e-run.mjs`（各 3 分钟超时）、`npm pack --dry-run`，平台是 ubuntu 和 windows、Node 18/20/22 六个组合——`engines` 说 >= 18，代码里也有 Windows 专属分支（ssh-agent 的命名管道、路径大小写折叠），只跑一个组合等于没测。改完 `magpie plugin update magpie-ssh`（Git 装法）才会生效到正在跑的 magpie。

## 📄 许可

MIT
