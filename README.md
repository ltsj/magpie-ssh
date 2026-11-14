# magpie-ssh

在 magpie 侧边栏里管理 SSH 主机，并把这些主机交给所有 agent 用：插件注册 `run`、`put`、`get`、`hosts` 四个工具，magpie 汇成自己的 MCP 服务器 `/mcp/magpie/tools`。

连的是 `ssh2`（纯 JS，不依赖系统 ssh），支持三种认证：密码、私钥、ssh agent。主机和凭据只存一份，在 magpie 的 `plugins.json` 里这个插件的 `options.hosts` 上；工具每次调用重新读一遍，页面里改了立刻生效。

## 装

```bash
magpie plugin add C:/Users/Colorful/Projects/magpie-ssh   # 文件夹装法：先在该目录 pnpm install
magpie plugin add magpie-ssh                              # 从 npm 装会自动装依赖
```

装完重启一次 magpie 应用，工具才会出现在 `/mcp/magpie/tools`：工具表在启动时构建。

## 页面

侧边栏「插件」分组里的 **SSH 主机**：名称、主机、端口、用户、密码（或私钥路径）、主机指纹校验、备注，点添加。行内可编辑、可删除（删除要点两次）。

页面在沙箱里跑（`connect-src 'none'`），没有网络也不能连插件宿主，所以**不能自己测连接**，只负责写设置。要验证一台主机，让 agent 调一次 `magpie-ssh_run`。同理，页面不能生成密钥，也不读 `~/.ssh`。

## 工具

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `magpie-ssh_hosts` | 无 | 列出主机（名称、地址、认证方式，不含凭据） |
| `magpie-ssh_run` | `host`, `command`, `timeoutMs?`, `maxChars?` | 执行一条命令，回退出码和输出；`host` 传 `*` 打全部主机 |
| `magpie-ssh_put` | `host`, `local`, `remote` | SFTP 上传 |
| `magpie-ssh_get` | `host`, `remote`, `local` | SFTP 下载 |

单次调用有**一份**时间预算：连接花掉的时间从执行时间里扣。`run` 默认 45 秒、最多 50 秒（magpie 每个工具给 55 秒），`put`/`get` 固定 45 秒。

`host` 填名称或地址都行，`*`（或 `all`）表示全部主机并发执行，结果按 `== 名称 (user@host:port) ==` 分段，整体共享一份时间预算。

工具一律用文本报错，不抛异常——magpie 加载插件时会拿空参数探一次每个工具，抛异常会把整个插件标成失败。

输出先攒到 4MB，超出只丢内容、不掐连接（命令照常跑完，开头会标注「已丢弃后续内容」）；回给 agent 的文本再按 `maxChars`（默认 16000）截断。

`strictHostKeyChecking`：

| 值 | 行为 |
| --- | --- |
| `accept-new`（页面默认） | 第一次见就写进 `~/.ssh/known_hosts`；写过之后再变就拒绝 |
| `yes` | 必须在 `known_hosts` 里且一致，否则拒绝并说明 |
| 空 | 放行，不落盘、不校验 |

指纹比的是公钥本身，不是 `known_hosts` 的哈希行——被 `ssh-keygen -H` 哈希过的条目会被当成「没有记录」。指纹变了的时候，确认机器没换过再删掉 `known_hosts` 里那一行。

## 安全边界

- 密码是以**明文**存在 `~/.config/magpie/plugins.json` 里的（magpie 的 `plugin-auth.json` 也这样）。不想明文就改用私钥或 agent，把密码字段留空。
- agent 一旦能用这些主机，就能以你的身份在那些机器上执行任意命令。别把 root 主机随手加进来。
- 工具以你的权限运行，结果只回给调用它的那个 agent。

## 测试

```bash
node test/smoke.mjs
```

只测纯逻辑：读 `plugins.json`、连接配置、`known_hosts` 指纹判断、工具在坏参数下回文本而不抛。真连接不在里面测（要真主机和凭据）。

## 许可

MIT

## 开发注意

- 入口文件只导出插件工厂。`index.mjs` 导出的**每个**函数都会被 magpie 当插件工厂调用一次，辅助函数放 `lib.mjs`，否则整个插件标成 failed。
- 工具的 `execute` 不许抛异常：坏参数一律回文本。magpie 加载时会拿空参数探一次每个工具。
- 工具名 `<插件短名>_<工具名>`，文件夹装的插件用文件夹名当短名。
- 文件夹装的插件不在 magpie 的 `plugins/` 项目里，`ssh2` 这类依赖必须装在插件自己的 `node_modules`（`pnpm install`），宿主才解析得到。
