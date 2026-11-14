// magpie-ssh — SSH 主机存在插件自己的 options 里（页面用 magpie.options.set 写），
// 工具每次调用都重新读 plugins.json，所以页面里改了立刻生效，不用重启宿主。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SPEC = "magpie-ssh";
// magpie 给每个工具 55 秒，留出余量
const TOOL_BUDGET_MS = 45000;
const MAX_COLLECT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 16000;

const pluginsJson = () =>
	join(
		process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
		"magpie",
		"plugins.json",
	);

const normalize = (value) =>
	String(value ?? "")
		.replace(/\\/g, "/")
		.toLowerCase();
const isHostsHolder = (options) => Array.isArray(options?.hosts);

// 页面把主机写在 plugins.json 里这个插件的 options 上；options 参数是宿主启动时的快照，
// 只能当兜底。
export function readHosts(fallback) {
	let db;
	try {
		db = JSON.parse(readFileSync(pluginsJson(), "utf8"));
	} catch {
		db = null;
	}
	const plugins = db?.plugins ?? [];
	// 同名插件可能以不同 spec 出现（另一个版本、git 写法），只认真的存了主机的那个。
	const bySpec = plugins.filter((item) => normalize(item.spec).includes(SPEC));
	const entry =
		bySpec.find((item) => isHostsHolder(item.options)) ??
		plugins.find((item) => isHostsHolder(item.options)) ??
		bySpec[0];
	const hosts = entry?.options?.hosts;
	if (Array.isArray(hosts)) return hosts;
	if (isHostsHolder(fallback)) return fallback.hosts;
	return [];
}

// 工具一律用文本报错：magpie 加载插件时会拿空参数探一次每个工具，抛异常会把整个插件标成失败。
export function pickHost(hosts, key) {
	if (!hosts.length) {
		return {
			error:
				"还没有配置 SSH 主机：打开 magpie 侧边栏的「SSH 主机」页添加一台。",
		};
	}
	const host = hosts.find(
		(item) => item.name === key || item.host === key || item.id === key,
	);
	if (!host) {
		return {
			error: `没有叫 ${key} 的主机。已配置：${hosts.map((item) => item.name).join("、")}`,
		};
	}
	return { host };
}

function expandHome(value) {
	const text = String(value);
	if (!/^~(?=$|[\\/])/.test(text)) return text;
	const rest = text.slice(1).replace(/^[\\/]+/, "");
	return rest ? join(homedir(), ...rest.split(/[\\/]+/)) : homedir();
}

export function sshArgs(host, extra = []) {
	const args = [
		"-T",
		"-o",
		"BatchMode=yes",
		"-o",
		`ConnectTimeout=${host.connectTimeoutSec || 10}`,
	];
	if (host.port && Number(host.port) !== 22) args.push("-p", String(host.port));
	if (host.identityFile) args.push("-i", expandHome(host.identityFile));
	if (host.strictHostKeyChecking)
		args.push("-o", `StrictHostKeyChecking=${host.strictHostKeyChecking}`);
	if (host.extraArgs)
		args.push(...String(host.extraArgs).split(/\s+/).filter(Boolean));
	// ssh 的写法是 [选项] 目标 [命令]，目标必须在命令前面。
	args.push(host.user ? `${host.user}@${host.host}` : host.host, ...extra);
	return args;
}

export function scpArgs(host, local, remote, direction) {
	const args = [
		"-o",
		"BatchMode=yes",
		"-o",
		`ConnectTimeout=${host.connectTimeoutSec || 10}`,
	];
	if (host.port && Number(host.port) !== 22) args.push("-P", String(host.port));
	if (host.identityFile) args.push("-i", expandHome(host.identityFile));
	if (host.strictHostKeyChecking)
		args.push("-o", `StrictHostKeyChecking=${host.strictHostKeyChecking}`);
	if (host.extraArgs)
		args.push(...String(host.extraArgs).split(/\s+/).filter(Boolean));
	const dest = host.user
		? `${host.user}@${host.host}:${remote}`
		: `${host.host}:${remote}`;
	args.push(...(direction === "put" ? [local, dest] : [dest, local]));
	return args;
}

function run(command, args, { timeoutMs, signal } = {}) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(command, args, {
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
				signal,
			});
		} catch (error) {
			resolve({
				code: -1,
				stdout: "",
				stderr: String(error.message),
				aborted: false,
			});
			return;
		}
		const stdout = [];
		const stderr = [];
		let collected = 0;
		let aborted = false;
		const timer = setTimeout(() => {
			aborted = true;
			child.kill();
		}, timeoutMs);
		const collect = (sink) => (chunk) => {
			collected += chunk.length;
			if (collected > MAX_COLLECT_BYTES) {
				aborted = true;
				child.kill();
				return;
			}
			sink.push(chunk);
		};
		child.stdout.on("data", collect(stdout));
		child.stderr.on("data", collect(stderr));
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: -1, stdout: "", stderr: String(error.message), aborted });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				code,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				aborted,
			});
		});
	});
}

function render(result, maxChars) {
	const parts = [`exit ${result.code}`];
	if (result.aborted) parts[0] += "（已超时或输出过大，进程被终止）";
	if (result.stdout) parts.push(result.stdout);
	if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
	const text = parts.join("\n").trimEnd();
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n…（已截断，全文 ${text.length} 字符）`;
}

const clampChars = (value) =>
	Math.min(Number(value) || DEFAULT_MAX_CHARS, 200000);

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
					const result = await run("scp", {
						timeoutMs: TOOL_BUDGET_MS,
						signal: ctx?.abort ? ctx.abort : undefined,
					});
					return render(result, DEFAULT_MAX_CHARS);
				},
			},
		},
	};
};
