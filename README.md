# magpie-ssh

在 magpie 侧边栏里管理 SSH 主机，并把这些主机交给所有 agent 用：插件注册 `run`、`put`、`get`、`hosts` 四个工具，magpie 汇成自己的 MCP 服务器 `/mcp/magpie/tools`。

主机信息只存一份，在 magpie 的 `plugins.json` 里这个插件的 `options.hosts` 上。页面用 `magpie.options` 读写，工具每次调用重新读一遍，所以在页面里改了立刻生效。

## 装

```bash
magpie plugin add C:/Users/Colorful/Projects/magpie-ssh
# 或从 npm / git 装
magpie plugin add magpie-ssh
```

装完在 magpie 里重启一次应用，工具才会出现在 `/mcp/magpie/tools`：工具服务器在启动时读插件列表。

## 页面

侧边栏「插件」分组里的 **SSH 主机**：填名称、主机、端口、用户，可选私钥路径和主机指纹校验策略，点添加。编辑和删除都在同一行。

页面没有网络、也不能连插件宿主（沙箱 `connect-src 'none'`），所以它只负责写设置，不测连接。要验证一台主机，让 agent 调一次 `magpie-ssh_run` 就行。

## 工具

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `magpie-ssh_hosts` | 无 | 列出主机（不含凭据） |
| `magpie-ssh_run` | `host`, `command`, `timeoutMs?`, `maxChars?` | 在主机上跑一条命令，回退出码和输出 |
| `magpie-ssh_put` | `host`, `local`, `remote` | scp 上传 |
| `magpie-ssh_get` | `host`, `remote`, `local` | scp 下载 |

`host` 可以填名称，也可以填主机地址。工具一律用文本报错，不抛异常——magpie 加载插件时会拿空参数探一次每个工具，抛异常会把整个插件标成失败。

## 怎么连

调用系统 `ssh`/`scp`（Windows 上是 OpenSSH 客户端），不自己实现协议，所以 `~/.ssh/config`、ssh agent、`known_hosts` 都照常生效。参数里带 `-T`、`BatchMode=yes`、`ConnectTimeout`：

- `BatchMode=yes` 表示不会弹出密码提示；密码登录的机器用不了，请改用密钥或 agent。
- 单次调用默认 45 秒超时（magpie 给每个工具 55 秒），输出默认截断到 16000 字符。

主机字段：

| 字段 | 说明 |
| --- | --- |
| `name` | 名称，工具里用它指代主机 |
| `host` | 地址 |
| `port` | 默认 22 |
| `user` | 不填就用 ssh 自己的默认值 |
| `identityFile` | 私钥路径，`~` 会展开；不填用 agent / 默认身份 |
| `strictHostKeyChecking` | `accept-new`（页面默认）、`yes`，或不写交给 ssh |
| `note` | 备注，只给自己看 |
| `extraArgs` | 额外的 ssh 参数，按空格拆开 |
| `connectTimeoutSec` | 连接超时秒数，默认 10 |

## 安全边界

- 主机信息（含私钥**路径**，不含私钥本身）明文存在 `~/.config/magpie/plugins.json` 里，权限跟 magpie 的配置目录一致。magpie 的 `plugin-auth.json` 也是这么存的。
- agent 一旦能用这些主机，就能以你的身份在那些机器上执行任意命令。别把你不信的命令交给它，也别把 root 主机随手加进来。
- 工具以你的权限运行，结果只回给调用它的那个 agent。

## 测试

```bash
node test/smoke.mjs
```

只测纯逻辑：读 `plugins.json`、拼命令行、参数坏了回文本而不抛。真连接不在这里测。

## 许可

MIT

## 开发注意

- 入口文件只导出插件工厂。`index.mjs` 导出的**每个**函数都会被 magpie 当插件工厂调用一次，辅助函数放 `lib.mjs`，否则整个插件标成 failed。
- 工具的 `execute` 不许抛异常：坏参数一律回文本。magpie 加载时会拿空参数探一次每个工具。
- 工具名 `<插件短名>_<工具名>`，文件夹装的插件用文件夹名当短名。
