// magpie-ssh — SSH 主机存在插件自己的 options 里（页面用 magpie.options.set 写），
// 工具每次调用都重新读 plugins.json，所以页面里改了立刻生效，不用重启宿主。
// 这个文件只导出插件工厂：入口模块导出的每个函数都会被 magpie 当插件调用一次，辅助函数放 lib.mjs。
import {
	clampChars,
	DEFAULT_MAX_CHARS,
	expandHome,
	pickHost,
	readHosts,
	render,
	run,
	scpArgs,
	sshArgs,
	TOOL_BUDGET_MS,
} from "./lib.mjs";

export const MagpieSsh = async (_input, options) => {
	const hosts = () => readHosts(options);

	return {
		tool: {
			hosts: {
				description: "列出 magpie 里配置的 SSH 主机（不含任何凭据）。",
				args: { type: "object", properties: {} },
				async execute() {
					const list = hosts();
					if (!list.length)
						return "还没有配置 SSH 主机：打开 magpie 侧边栏的「SSH 主机」页添加一台。";
					return list
						.map((host) => {
							const target = `${host.user ? `${host.user}@` : ""}${host.host}:${host.port || 22}`;
							return `- ${host.name}  ${target}${host.note ? `  ${host.note}` : ""}`;
						})
						.join("\n");
				},
			},

			run: {
				description:
					"在已配置的 SSH 主机上通过系统 ssh 执行一条命令，返回退出码与输出。命令由远端 shell 解释。",
				args: {
					type: "object",
					properties: {
						host: { type: "string", description: "主机名（页面里填的名称）" },
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
					const picked = pickHost(hosts(), args.host);
					if (picked.error) return picked.error;
					if (!args.command) return "需要用 command 给出要执行的命令。";
					const timeoutMs = Math.min(
						Number(args.timeoutMs) || TOOL_BUDGET_MS,
						50000,
					);
					const result = await run(
						"ssh",
						sshArgs(picked.host, [String(args.command)]),
						{
							timeoutMs,
							signal: ctx?.abort ? ctx.abort : undefined,
						},
					);
					return render(result, clampChars(args.maxChars));
				},
			},

			put: {
				description: "把本机文件传到已配置的主机上（scp）。",
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
					const result = await run(
						"scp",
						scpArgs(picked.host, expandHome(args.local), args.remote, "put"),
						{
							timeoutMs: TOOL_BUDGET_MS,
							signal: ctx?.abort ? ctx.abort : undefined,
						},
					);
					return render(result, DEFAULT_MAX_CHARS);
				},
			},

			get: {
				description: "把已配置主机上的文件取回本机（scp）。",
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
					const result = await run(
						"scp",
						scpArgs(picked.host, expandHome(args.local), args.remote, "get"),
						{
							timeoutMs: TOOL_BUDGET_MS,
							signal: ctx?.abort ? ctx.abort : undefined,
						},
					);
					return render(result, DEFAULT_MAX_CHARS);
				},
			},
		},
	};
};
