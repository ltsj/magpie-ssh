// magpie-ssh — SSH 主机存在插件自己的 options 里（页面用 magpie.options.set 写），
// 工具每次调用都重新读 plugins.json，所以页面里改了立刻生效，不用重启宿主。
// 这个文件只导出插件工厂：入口模块导出的每个函数都会被 magpie 当插件调用一次，辅助函数放 lib.mjs。
import {
	clampChars,
	DEFAULT_MAX_CHARS,
	execBatch,
	execRemote,
	expandHome,
	pickHost,
	readHosts,
	reach,
	transferRemote,
	TOOL_BUDGET_MS,
} from "./lib.mjs";

export const MagpieSsh = async (_input, options) => {
	const hosts = () => readHosts(options);

	return {
		tool: {
			hosts: {
				description:
					"列出 magpie 里配置的 SSH 主机（名称、地址、认证方式，不含任何凭据）。",
				args: { type: "object", properties: {} },
				async execute() {
					const list = hosts();
					if (!list.length)
						return "还没有配置 SSH 主机：打开 magpie 侧边栏的「SSH 主机」页添加一台。";
					return list
						.map((host) => {
							const target = `${host.user ? `${host.user}@` : ""}${host.host}:${host.port || 22}`;
							const auth = host.password
								? "密码"
								: host.identityFile
									? `私钥 ${host.identityFile}`
									: "ssh agent";
							return `- ${host.name}  ${target}  ${auth}${host.note ? `  ${host.note}` : ""}`;
						})
						.join("\n");
				},
			},
			check: {
				description:
					"只握手不发命令，报告每台主机能不能连、耗时多少；用来分清「网络不通」「认证被拒」「主机指纹对不上」。host 传 * 表示所有主机。",
				args: {
					type: "object",
					properties: {
						host: {
							type: "string",
							description: "主机名（页面里填的名称），或 * 表示所有主机",
						},
						timeoutMs: {
							type: "number",
							description: "握手超时毫秒，默认 8000",
						},
					},
					required: ["host"],
				},
				async execute(args = {}, ctx) {
					try {
						const list = hosts();
						if (!list.length) return "还没有配置任何主机。";
						const timeoutMs = Number(args.timeoutMs) || 8000;
						if (args.host === "*" || args.host === "all")
							return (
								await Promise.all(
									list.map((host) =>
										reach(host, { timeoutMs, signal: ctx?.abort }),
									),
								)
							).join("\n");
						const picked = pickHost(list, args.host);
						if (picked.error) return picked.error;
						return await reach(picked.host, { timeoutMs, signal: ctx?.abort });
					} catch (error) {
						return `exit -1\n[stderr]\n${error.message}`;
					}
				},
			},

			run: {
				description:
					"在已配置的 SSH 主机上执行一条命令，返回退出码与输出。命令由远端 shell 解释。host 传 * 表示所有主机并发执行（共享同一份时间预算）。",
				args: {
					type: "object",
					properties: {
						host: {
							type: "string",
							description: "主机名（页面里填的名称），或 * 表示所有主机",
						},
						command: { type: "string", description: "要执行的命令" },
						timeoutMs: {
							type: "number",
							description: `超时毫秒，默认 ${TOOL_BUDGET_MS}，最大 50000`,
						},
						maxChars: {
							type: "number",
							description: `返回文本上限，默认 ${DEFAULT_MAX_CHARS}`,
						},
					},
					required: ["host", "command"],
				},
				async execute(args = {}, ctx) {
					if (!args.command) return "需要用 command 给出要执行的命令。";
					const timeoutMs = Math.min(
						Number(args.timeoutMs) || TOOL_BUDGET_MS,
						50000,
					);
					const maxChars = clampChars(args.maxChars);
					try {
						if (args.host === "*" || args.host === "all") {
							const all = hosts();
							if (!all.length) return "还没有配置任何主机。";
							return await execBatch(all, args.command, {
								timeoutMs,
								maxChars,
								signal: ctx?.abort,
							});
						}
						const picked = pickHost(hosts(), args.host);
						if (picked.error) return picked.error;
						return await execRemote(picked.host, args.command, {
							timeoutMs,
							maxChars,
							signal: ctx?.abort,
						});
					} catch (error) {
						return `exit -1\n[stderr]\n${error.message}`;
					}
				},
			},

			put: {
				description: "把本机文件传到已配置的主机上（SFTP）。",
				args: {
					type: "object",
					properties: {
						host: { type: "string" },
						local: { type: "string", description: "本机路径" },
						remote: { type: "string", description: "主机上的目标路径" },
					},
					required: ["host", "local", "remote"],
				},
				async execute(args = {}, ctx) {
					const picked = pickHost(hosts(), args.host);
					if (picked.error) return picked.error;
					if (!args.local || !args.remote)
						return "需要 local、remote 两个路径。";
					try {
						return await transferRemote(
							picked.host,
							expandHome(args.local),
							String(args.remote),
							"put",
							{ signal: ctx?.abort },
						);
					} catch (error) {
						return `exit -1\n[stderr]\n${error.message}`;
					}
				},
			},

			get: {
				description: "把已配置主机上的文件取回本机（SFTP）。",
				args: {
					type: "object",
					properties: {
						host: { type: "string" },
						remote: { type: "string", description: "主机上的文件路径" },
						local: { type: "string", description: "本机目标路径" },
					},
					required: ["host", "remote", "local"],
				},
				async execute(args = {}, ctx) {
					const picked = pickHost(hosts(), args.host);
					if (picked.error) return picked.error;
					if (!args.local || !args.remote)
						return "需要 remote、local 两个路径。";
					try {
						return await transferRemote(
							picked.host,
							expandHome(args.local),
							String(args.remote),
							"get",
							{ signal: ctx?.abort },
						);
					} catch (error) {
						return `exit -1\n[stderr]\n${error.message}`;
					}
				},
			},
		},
	};
};
