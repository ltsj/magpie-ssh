// 辅助函数放在这里，不放进 index.mjs：magpie 会把入口模块导出的每个函数都当插件工厂调用一次。
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "ssh2";

const SPEC = "magpie-ssh";
// magpie 给每个工具 55 秒，留出余量
export const TOOL_BUDGET_MS = 45000;
const MAX_COLLECT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_CHARS = 16000;

// 输出上限只丢内容、不断连接：命令照常跑完，调用方拿到截断标记。
export const makeSink = (cap = MAX_COLLECT_BYTES) => {
	let total = 0;
	let truncated = false;
	return {
		push(chunk) {
			if (truncated) return false;
			if (total + chunk.length > cap) {
				truncated = true;
				return false;
			}
			total += chunk.length;
			return true;
		},
		get truncated() {
			return truncated;
		},
	};
};

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

export const knownHostsFile = () => join(homedir(), ".ssh", "known_hosts");

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
	const wanted = String(key ?? "").toLowerCase();
	const host = hosts.find((item) =>
		[item.name, item.host, item.id].some(
			(value) => String(value ?? "").toLowerCase() === wanted,
		),
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

const agentPath = () =>
	process.env.SSH_AUTH_SOCK ||
	(process.platform === "win32" ? "\\\\.\\pipe\\openssh-ssh-agent" : "");

// known_hosts 里的写法：22 端口用主机名，其他端口用 [host]:port。
export const hostIds = (host) => {
	const port = Number(host.port) || 22;
	return port === 22 ? [host.host] : [host.host, `[${host.host}]:${port}`];
};

// ssh2 的 hostVerifier 只给公钥 blob，key 类型在 blob 前 4 字节（长度）+ 类型字符串。
export function keyType(blob) {
	const length = blob.readUInt32BE(0);
	return blob.subarray(4, 4 + length).toString("ascii");
}

export function readKnownHosts(file = knownHostsFile()) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const entries = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const [hosts, , blob] = trimmed.split(/\s+/);
		if (!hosts || !blob) continue;
		entries.push({ hosts: hosts.split(","), blob });
	}
	return entries;
}

// accept-new：没记录就写进 known_hosts；记录在但指纹不一样就拒绝。
// yes：必须在 known_hosts 里且一致。不写：直接放行，不落盘。
export function verifyHostKey(host, blob, mode, file = knownHostsFile()) {
	const base64 = blob.toString("base64");
	const ids = hostIds(host);
	const entries = readKnownHosts(file);
	const hit = entries.find(
		(entry) =>
			entry.blob === base64 && ids.some((id) => entry.hosts.includes(id)),
	);
	if (hit) return { ok: true };
	const seen = entries.some((entry) =>
		ids.some((id) => entry.hosts.includes(id)),
	);
	if (seen) {
		return {
			ok: false,
			error: `主机 ${host.host} 的指纹和 known_hosts 里的不一样，可能是换了机器或中间人。确认无误后删掉 known_hosts 里对应那一行再说。`,
		};
	}
	if (mode === "yes") {
		return {
			ok: false,
			error: `known_hosts 里没有 ${host.host}，而指纹校验设成了 yes。先用 ssh 连一次，或在页面里把校验改成 accept-new。`,
		};
	}
	if (mode === "accept-new") {
		try {
			mkdirSync(dirname(file), { recursive: true });
			appendFileSync(
				file,
				`${hostIds(host).at(-1)} ${keyType(blob)} ${base64}\n`,
			);
		} catch {
			// 写不进去不影响本次连接
		}
	}
	return { ok: true };
}

export function connectConfig(host, { handshake } = {}) {
	const port = Number(host.port) || 22;
	const config = {
		host: host.host,
		port,
		readyTimeout: Math.min(Number(host.connectTimeoutSec) || 10, 60) * 1000,
		hostVerifier: (blob) => {
			const check = verifyHostKey(host, blob, host.strictHostKeyChecking);
			if (!check.ok && handshake) handshake.error = check.error;
			return check.ok;
		},
	};
	if (host.user) config.username = String(host.user);
	if (host.password) config.password = String(host.password);
	else if (host.identityFile)
		config.privateKey = readFileSync(expandHome(host.identityFile));
	else if (agentPath()) config.agent = agentPath();
	return config;
}

// 连上就交出去，调用方负责 client.end()。密码、私钥、agent 三种认证在 connectConfig 里选。
export function connect(host, { timeoutMs = TOOL_BUDGET_MS, signal } = {}) {
	return new Promise((resolve, reject) => {
		const client = new Client();
		const handshake = { error: null };
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			client.end();
			reject(new Error(`连接 ${host.host} 超时（${timeoutMs} 毫秒）`));
		}, timeoutMs);
		const fail = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			client.end();
			reject(new Error(handshake.error || String(error.message ?? error)));
		};
		client.once("ready", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal)
				signal.addEventListener("abort", () => client.end(), { once: true });
			resolve(client);
		});
		client.once("error", fail);
		try {
			client.connect(connectConfig(host, { handshake }));
		} catch (error) {
			fail(error);
		}
	});
}

// 一个工具调用只有一份时间预算：连接花掉的时间从执行时间里扣，别让两者相加超过 magpie 的 55 秒。
export async function execRemote(
	host,
	command,
	{ timeoutMs = TOOL_BUDGET_MS, maxChars, signal } = {},
) {
	const deadline = Date.now() + timeoutMs;
	const left = () => Math.max(deadline - Date.now(), 1000);
	const client = await connect(host, { timeoutMs: left(), signal });
	try {
		const sink = makeSink(MAX_COLLECT_BYTES);
		const result = await new Promise((resolve) => {
			const output = [];
			const error = [];

			let aborted = false;
			const finish = (code) => {
				resolve({
					code,
					stdout: Buffer.concat(output).toString("utf8"),
					stderr: Buffer.concat(error).toString("utf8"),
					aborted,
				});
			};
			const timer = setTimeout(() => {
				aborted = true;
				client.end();
				finish(-1);
			}, left());
			client.exec(String(command), (err, stream) => {
				if (err) {
					clearTimeout(timer);
					resolve({
						code: -1,
						stdout: "",
						stderr: String(err.message),
						aborted,
					});
					return;
				}
				const collect = (target) => (chunk) => {
					if (sink.push(chunk)) target.push(chunk);
				};
				stream.on("data", collect(output));
				stream.stderr.on("data", collect(error));
				stream.on("close", (code) => {
					clearTimeout(timer);
					finish(aborted ? -1 : (code ?? 0));
				});
			});
		});
		if (sink.truncated)
			result.note = "[输出超过 4MB，已丢弃后续内容，命令继续执行]";
		return render(result, clampChars(maxChars));
	} finally {
		client.end();
	}
}

// 一次命令打多台主机：并发跑，共享同一份时间预算，结果按主机分段。
export async function execBatch(
	hosts,
	command,
	{ timeoutMs = TOOL_BUDGET_MS, maxChars, signal, concurrency = 8 } = {},
) {
	const deadline = Date.now() + timeoutMs;
	const left = () => Math.max(deadline - Date.now(), 1000);
	const out = new Array(hosts.length);
	let next = 0;
	const worker = async () => {
		while (next < hosts.length) {
			const index = next++;
			out[index] = await execRemote(hosts[index], command, {
				timeoutMs: left(),
				maxChars,
				signal,
			});
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(concurrency, hosts.length) }, worker),
	);
	return hosts
		.map(
			(host, index) =>
				`== ${host.name || host.host} (${host.user || "root"}@${host.host}:${host.port || 22}) ==\n${out[index]}`,
		)
		.join("\n\n");
}

export async function transferRemote(
	host,
	local,
	remote,
	direction,
	{ timeoutMs = TOOL_BUDGET_MS, signal } = {},
) {
	const deadline = Date.now() + timeoutMs;
	const left = () => Math.max(deadline - Date.now(), 1000);
	const client = await connect(host, { timeoutMs: left(), signal });
	try {
		const sftp = await new Promise((resolve, reject) => {
			client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
		});
		return await new Promise((resolve) => {
			const timer = setTimeout(() => {
				client.end();
				resolve(`exit -1（传输超时，${timeoutMs} 毫秒）`);
			}, left());
			const done = (err) => {
				clearTimeout(timer);
				resolve(
					err
						? `exit -1\n[stderr]\n${err.message}`
						: `exit 0\n${direction === "put" ? `${local} → ${remote}` : `${remote} → ${local}`}`,
				);
			};
			if (direction === "put") sftp.fastPut(local, remote, done);
			else sftp.fastGet(remote, local, done);
		});
	} finally {
		client.end();
	}
}

// 只握手不执行命令：用来分辨「连不上」「认证被拒」「指纹对不上」，并给出握手耗时。
export async function reach(host, { timeoutMs = 8000, signal } = {}) {
	const started = Date.now();
	try {
		const client = await connect(host, { timeoutMs, signal });
		client.end();
		return `exit 0\n${host.name || host.host}  ${Date.now() - started} 毫秒`;
	} catch (error) {
		return `exit -1\n[stderr]\n${String(error.message ?? error)}`;
	}
}

export function render(result, maxChars) {
	const parts = [`exit ${result.code}`];
	if (result.aborted) parts[0] += "（已超时，连接被断开）";
	if (result.note) parts.splice(1, 0, result.note);
	if (result.stdout) parts.push(result.stdout);
	if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
	const text = parts.join("\n").trimEnd();
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n…（已截断，全文 ${text.length} 字符）`;
}

export const clampChars = (value) =>
	Math.min(Number(value) || DEFAULT_MAX_CHARS, 200000);
