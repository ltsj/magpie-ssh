// 辅助函数放在这里，不放进 index.mjs：magpie 会把入口模块导出的每个函数都当插件工厂调用一次。
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Client } from "ssh2";

const SPEC = "magpie-ssh";
// magpie 给每个工具 55 秒，留出余量
export const TOOL_BUDGET_MS = 45000;
const MAX_COLLECT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_CHARS = 16000;
const NO_HOSTS =
	"还没有配置 SSH 主机：打开 magpie 侧边栏的「SSH 主机」页添加一台。";

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
	if (!hosts.length) return { error: NO_HOSTS };
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

// 逗号分隔可一次选多台；* 或 all 是全选。重复的在去重后只跑一次。
export function pickHosts(hosts, key) {
	const text = String(key ?? "").trim();
	if (text === "*" || text.toLowerCase() === "all") {
		return hosts.length ? { list: hosts } : { error: NO_HOSTS };
	}
	const names = text
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	if (names.length <= 1) {
		const one = pickHost(hosts, names[0] ?? text);
		return one.error ? one : { list: [one.host] };
	}
	const picked = [];
	const missing = [];
	for (const name of names) {
		const one = pickHost(hosts, name);
		if (one.error) missing.push(name);
		else if (!picked.includes(one.host)) picked.push(one.host);
	}
	if (!picked.length) return { error: pickHost(hosts, names[0]).error };
	if (missing.length)
		return {
			error: `没有叫 ${missing.join("、")} 的主机。已配置：${hosts.map((item) => item.name).join("、")}`,
		};
	return { list: picked };
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

// 和 ssh-keygen -lf 一致：SHA256 的 base64，去掉末尾的 =。
export const fingerprint = (blob) =>
	`SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;

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
			if (handshake) handshake.key = blob;
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
			// 指纹留给调用方展示：加新主机时先看它、再决定信任
			if (handshake.key) client.hostKey = handshake.key;
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
export async function execOnce(
	host,
	command,
	{ timeoutMs = TOOL_BUDGET_MS, signal } = {},
) {
	const started = Date.now();
	const deadline = started + timeoutMs;
	const left = () => Math.max(deadline - Date.now(), 1000);
	const client = await connect(host, { timeoutMs: left(), signal });
	try {
		const sink = makeSink(MAX_COLLECT_BYTES);
		// 两个流各自解码、按到达顺序拼接：交错输出保持原样，切在多字节中间也不会坏字
		const decoders = {
			out: new StringDecoder("utf8"),
			err: new StringDecoder("utf8"),
		};
		const segments = [];
		const push = (kind, text) => {
			if (!text) return;
			const last = segments[segments.length - 1];
			if (last?.kind === kind) last.text += text;
			else segments.push({ kind, text });
		};
		const result = await new Promise((resolve) => {
			let aborted = false;
			const finish = (code) => {
				push("out", decoders.out.end());
				push("err", decoders.err.end());
				resolve({ code, aborted, segments });
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
						aborted,
						segments: [{ kind: "err", text: String(err.message) }],
					});
					return;
				}
				const collect = (kind, decoder) => (chunk) => {
					if (sink.push(chunk)) push(kind, decoder.write(chunk));
				};
				stream.on("data", collect("out", decoders.out));
				stream.stderr.on("data", collect("err", decoders.err));
				stream.on("close", (code) => {
					clearTimeout(timer);
					finish(aborted ? -1 : (code ?? 0));
				});
			});
		});
		if (sink.truncated)
			result.note = "[输出超过 4MB，已丢弃后续内容，命令继续执行]";
		result.ms = Date.now() - started;
		result.host = host;
		return result;
	} finally {
		client.end();
	}
}

export async function execRemote(host, command, options = {}) {
	return render(
		await execOnce(host, command, options),
		clampChars(options.maxChars),
	);
}

// 一次命令打多台主机：并发跑，共享同一份时间预算，结果按主机分段，末尾给成功/失败汇总。
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
			try {
				out[index] = await execOnce(hosts[index], command, {
					timeoutMs: left(),
					signal,
				});
			} catch (error) {
				out[index] = {
					code: -1,
					segments: [{ kind: "err", text: String(error.message ?? error) }],
				};
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(concurrency, hosts.length) }, worker),
	);
	const body = hosts
		.map(
			(host, index) =>
				`== ${host.name || host.host} (${host.user || "root"}@${host.host}:${host.port || 22}) ==\n${render(out[index], clampChars(maxChars))}`,
		)
		.join("\n\n");
	const ok = out.filter((item) => item.code === 0).length;
	const failed = hosts
		.map((host, index) => [host, out[index]])
		.filter(([, item]) => item.code !== 0)
		.map(([host, item]) => `${host.name || host.host}(exit ${item.code})`);
	const summary = failed.length
		? `总计 ${ok}/${hosts.length} 成功，失败：${failed.join("、")}`
		: `总计 ${ok}/${hosts.length} 成功`;
	return `${body}\n\n${summary}`;
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

// 只握手不执行命令：用来分辨「连不上」「认证被拒」「指纹对不上」，并给出握手耗时和服务器指纹。
export async function reach(host, { timeoutMs = 8000, signal } = {}) {
	const started = Date.now();
	try {
		const client = await connect(host, { timeoutMs, signal });
		const key = client.hostKey
			? `  ${keyType(client.hostKey)} ${fingerprint(client.hostKey)}`
			: "";
		client.end();
		return `exit 0\n${host.name || host.host}  ${Date.now() - started} 毫秒${key}`;
	} catch (error) {
		return `exit -1\n[stderr]\n${String(error.message ?? error)}`;
	}
}

// stderr 在它出现的位置用 [stderr] 标一行，stdout 与 stderr 的先后顺序不被改变。
const bodyOf = (result) => {
	if (!result.segments) {
		const parts = [];
		if (result.stdout) parts.push(result.stdout.trimEnd());
		if (result.stderr) parts.push(`[stderr] ${result.stderr.trimEnd()}`);
		return parts.join("\n");
	}
	let text = "";
	for (const segment of result.segments) {
		if (segment.kind !== "err") {
			text += segment.text;
			continue;
		}
		const body = segment.text.trimEnd();
		if (body) text += `[stderr] ${body}\n`;
	}
	return text.trimEnd();
};

export function render(result, maxChars) {
	const head = [`exit ${result.code}`];
	if (result.aborted) head[0] += "（已超时，连接被断开）";
	if (result.note) head.push(result.note);
	const body = bodyOf(result);
	const text = body ? `${head.join("\n")}\n${body}` : head.join("\n");
	if (text.length <= maxChars) return text;
	// 别切在代理对中间：切出来的半个字符在 JSON 里会变成替换符
	let cut = maxChars;
	const code = text.charCodeAt(cut - 1);
	if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
	return `${text.slice(0, cut)}\n…（已截断，全文 ${text.length} 字符）`;
}

export const clampChars = (value) =>
	Math.min(Number(value) || DEFAULT_MAX_CHARS, 200000);

// 审计日志默认关：多 agent 共用一台 root 主机时，把谁在什么时候跑了什么记成一行 JSON。
const configDir = () =>
	process.env.XDG_CONFIG_HOME || join(homedir(), ".config", "magpie");
export const auditFile = () => join(configDir(), "magpie-ssh-audit.log");

export function audit(options, record) {
	if (!options?.auditLog) return;
	try {
		mkdirSync(dirname(auditFile()), { recursive: true });
		appendFileSync(
			auditFile(),
			`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`,
		);
	} catch {
		// 记日志失败不能影响调用本身
	}
}
