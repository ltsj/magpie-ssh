// 辅助函数放在这里，不放进 index.mjs：magpie 会把入口模块导出的每个函数都当插件工厂调用一次。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SPEC = "magpie-ssh";
// magpie 给每个工具 55 秒，留出余量
export const TOOL_BUDGET_MS = 45000;
const MAX_COLLECT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_CHARS = 16000;

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

export function expandHome(value) {
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

export function run(command, args, { timeoutMs, signal } = {}) {
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

export function render(result, maxChars) {
	const parts = [`exit ${result.code}`];
	if (result.aborted) parts[0] += "（已超时或输出过大，进程被终止）";
	if (result.stdout) parts.push(result.stdout);
	if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
	const text = parts.join("\n").trimEnd();
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n…（已截断，全文 ${text.length} 字符）`;
}

export const clampChars = (value) =>
	Math.min(Number(value) || DEFAULT_MAX_CHARS, 200000);
