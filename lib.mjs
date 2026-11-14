// 辅助函数放在这里，不放进 index.mjs：magpie 会把入口模块导出的每个函数都当插件工厂调用一次。
import { createHash, createHmac } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
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
// 只能当兜底。读坏了要报出来：悄悄当空的话，用户会以为主机没了而去重配一遍。
export function readHostsState(fallback) {
	let raw = null;
	try {
		raw = readFileSync(pluginsJson(), "utf8");
	} catch (error) {
		// 文件不存在 = 还没配过；别的读错误（权限、IO）要让人看见
		if (error?.code !== "ENOENT")
			return { hosts: [], error: `读不到 ${pluginsJson()}：${error.message}` };
	}
	let db = null;
	if (raw !== null) {
		try {
			db = JSON.parse(raw);
		} catch (error) {
			return {
				hosts: [],
				error: `${pluginsJson()} 不是合法 JSON（${error.message}），主机列表没读出来；文件里记的主机多半还在，改好这一行再试。`,
			};
		}
		if (!db || typeof db !== "object" || Array.isArray(db))
			return {
				hosts: [],
				error: `${pluginsJson()} 不是 magpie 的插件表（顶层应是 {"plugins":[…]}），主机列表没读出来。`,
			};
		if (db.plugins !== undefined && !Array.isArray(db.plugins))
			return {
				hosts: [],
				error: `${pluginsJson()} 里的 plugins 不是数组，主机列表没读出来。`,
			};
	}
	const plugins = db?.plugins ?? [];
	// 同名插件可能以不同 spec 出现（另一个版本、git 写法），只认真的存了主机的那个。
	const bySpec = plugins.filter((item) => normalize(item.spec).includes(SPEC));
	// 只认 spec 里带 magpie-ssh 的条目（别的插件也可能有 hosts 字段）；
	// 同一个插件被装了两次时优先真有主机的那条，免得被空的残留条目遮住
	const holders = bySpec.filter((item) => isHostsHolder(item.options));
	const entry =
		holders.find((item) => item.options.hosts.length) ??
		holders[0] ??
		bySpec[0];
	const hosts = entry?.options?.hosts;
	if (Array.isArray(hosts)) return { hosts };
	if (isHostsHolder(fallback)) return { hosts: fallback.hosts };
	return { hosts: [] };
}

export function readHosts(fallback) {
	return readHostsState(fallback).hosts;
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

// 一条已知主机条目：hosts 可能是明文、逗号分隔的多个，也可能是 |1|salt|hash 形式的哈希。
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
		const fields = trimmed.split(/\s+/);
		// @cert-authority 需要验证证书链，这里做不到，跳过；@revoked 要当拒绝处理
		let marker = null;
		if (fields[0]?.startsWith("@")) marker = fields.shift();
		const [hosts, , blob] = fields;
		if (!hosts || !blob) continue;
		entries.push({ marker, hosts: hosts.split(","), blob });
	}
	return entries;
}

// 条目是否覆盖这个身份：明文直接比，哈希形式按 |1|salt|hmac 复算。
const coversHost = (entry, id) =>
	entry.hosts.some((pattern) => {
		if (!pattern.startsWith("|1|"))
			return pattern.toLowerCase() === id.toLowerCase();
		const [, , salt, hash] = pattern.split("|");
		if (!salt || !hash) return false;
		const mac = createHmac("sha1", Buffer.from(salt, "base64"))
			.update(id.toLowerCase())
			.digest("base64");
		return mac === hash;
	});

// yes：必须在 known_hosts 里且一致。no/空：不校验也不登记。其余（含 accept-new）：
// 没记录就等握手通过后登记一行，见 registerHostKey；记录在但指纹不一样就拒绝。
// 只认规范身份：22 端口用主机名，其他端口用 [host]:port——否则同主机别的端口会被误判成指纹变了。
export function verifyHostKey(host, blob, mode, file = knownHostsFile()) {
	const base64 = blob.toString("base64");
	// known_hosts 里的主机名一律小写比（OpenSSH 也是先转小写再算哈希）
	const id = String(hostIds(host).at(-1)).toLowerCase();
	// 只有 yes / no 是明确指令，其余（没填、""、拼错的）都按 accept-new
	const check = mode === "yes" || mode === "no" ? mode : "accept-new";
	const all = readKnownHosts(file);
	// @revoked 是全局的：不看主机字段，这把钥匙被吊销就是吊销
	if (all.some((entry) => entry.marker === "@revoked" && entry.blob === base64))
		return {
			ok: false,
			error: `known_hosts 把这把主机钥匙标成了吊销（@revoked），拒绝连接 ${id}。`,
		};
	// 吊销比「不校验」优先：这把钥匙明确不认了，连「不校验」的主机也拒
	if (check === "no") return { ok: true };
	const entries = all.filter((entry) => !entry.marker && coversHost(entry, id));
	if (entries.some((entry) => entry.blob === base64)) return { ok: true };
	if (entries.length) {
		return {
			ok: false,
			error: `主机 ${host.host} 的指纹和 known_hosts 里的不一样，可能是换了机器或中间人。确认无误后删掉 known_hosts 里对应那一行再说。`,
		};
	}
	if (check === "yes") {
		return {
			ok: false,
			error: `known_hosts 里没有 ${id}，而指纹校验设成了 yes。先用 ssh 连一次，或在页面里把校验改成 accept-new。`,
		};
	}
	try {
		return { ok: true, register: `${id} ${keyType(blob)} ${base64}` };
	} catch {
		return { ok: true };
	}
}

// 登记要等握手签名校验通过之后再写：在 hostVerifier 里写，路上的攻击者塞一把垃圾钥匙
// 就能把首见主机钉死，之后连真机全变「指纹不一样」。
export function registerHostKey(line, file = knownHostsFile()) {
	if (!/^[A-Za-z0-9._:[\]-]+ ssh-[a-z0-9-]+ [A-Za-z0-9+/=]+$/.test(line))
		return;
	try {
		mkdirSync(dirname(file), { recursive: true });
		let lead = "";
		try {
			const text = readFileSync(file, "utf8");
			if (text.length && !text.endsWith("\n")) lead = "\n";
		} catch {
			// 文件还不存在
		}
		appendFileSync(file, `${lead}${line}\n`);
	} catch {
		// 写不进去不影响本次连接
	}
}

// 用户没填时按本机的登录名走（和 OpenSSH 一样）；ssh2 不接受空用户名，
// 以前这里会直接报 "Invalid username"。
const localUser = () => {
	try {
		return userInfo().username;
	} catch {
		return process.env.USER || process.env.USERNAME || "";
	}
};

// ---- ~/.ssh/config ----
export const sshConfigFile = () => join(homedir(), ".ssh", "config");

const unquote = (value) =>
	String(value ?? "")
		.trim()
		.replace(/^"(.*)"$/, "$1")
		.replace(/^'(.*)'$/, "$1");

// 只解析本插件用得上的那一层：Host 块、键值、注释，Match 块整块跳过。
// 每个块里同一个键保留第一次出现的值（OpenSSH 也是先到先得）。
export function parseSshConfig(text) {
	const blocks = [];
	let current = null;
	let skipping = false;
	for (const raw of String(text ?? "").split(/\r?\n/)) {
		const line = raw.replace(/(^|\s)#.*$/, "").trim();
		if (!line) continue;
		const space = line.search(/\s/);
		const key = (space < 0 ? line : line.slice(0, space)).toLowerCase();
		const rest = space < 0 ? "" : line.slice(space + 1).trim();
		if (key === "host") {
			skipping = false;
			current = { patterns: rest.split(/\s+/).filter(Boolean), options: {} };
			blocks.push(current);
			continue;
		}
		if (key === "match") {
			// Match 的条件（exec、canonical 等）算不过来，跳过整块，免得把里面的值当成默认
			skipping = true;
			current = null;
			continue;
		}
		if (skipping) continue;
		if (!current) {
			// 文件开头没有 Host 的选项是全局默认
			current = { patterns: ["*"], options: {} };
			blocks.push(current);
		}
		if (!(key in current.options)) current.options[key] = rest;
	}
	return blocks;
}

// Host 模式支持 * 和 ?，前面加 ! 是排除；主机名不分大小写。
const hostMatcher = (pattern) => {
	const body = unquote(pattern);
	const negate = body.startsWith("!");
	const glob = negate ? body.slice(1) : body;
	const source = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	const re = new RegExp(`^${source}$`, "i");
	return { negate, test: (name) => re.test(name) };
};

// 按 OpenSSH 的规则挑出这台主机能用到的选项：一个块里只要有一个正向模式命中、
// 且没有被 ! 模式排除，整块就生效；同一个键以最先出现的值为准。
export function sshConfigOptions(name, file = sshConfigFile()) {
	const text = String(name ?? "").trim();
	if (!text) return {};
	let content;
	try {
		content = readFileSync(file, "utf8");
	} catch {
		return {};
	}
	const options = {};
	for (const block of parseSshConfig(content)) {
		let hit = false;
		let blocked = false;
		for (const pattern of block.patterns) {
			const matcher = hostMatcher(pattern);
			if (!matcher.test(text)) continue;
			if (matcher.negate) {
				blocked = true;
				break;
			}
			hit = true;
		}
		if (blocked || !hit) continue;
		for (const [key, value] of Object.entries(block.options))
			if (!(key in options)) options[key] = unquote(value);
	}
	return options;
}

// 跳板机写法：user@host:port、host、[::1]:22；none 表示不用跳板。
export function parseProxyJump(value) {
	const text = String(value ?? "").trim();
	if (!text || text.toLowerCase() === "none") return null;
	const at = text.lastIndexOf("@");
	const user = at >= 0 ? unquote(text.slice(0, at)) : "";
	let rest = at >= 0 ? text.slice(at + 1) : text;
	let port = 0;
	const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
	if (bracketed) {
		rest = bracketed[1];
		port = Number(bracketed[2]) || 0;
	} else {
		const colon = /^([^:]+):(\d+)$/.exec(rest);
		if (colon) {
			rest = colon[1];
			port = Number(colon[2]) || 0;
		}
	}
	return rest ? { user, host: rest, port } : null;
}

// 主机记录叠上 ~/.ssh/config 的缺省值：记录里填了的以记录为准。
// 端口例外：页面总会写个 22，只有端口留空或还是 22 时才让 config 的 Port 生效。
export function resolveSshHost(host, file = sshConfigFile()) {
	const alias = String(host?.host ?? "").trim();
	const options = sshConfigOptions(alias, file);
	const resolved = { ...host, __sshResolved: true };
	if (options.hostname) resolved.host = unquote(options.hostname);
	if (!resolved.user && options.user) resolved.user = unquote(options.user);
	const declaredPort = Number(host?.port) || 0;
	const configPort = Number(options.port) || 0;
	resolved.port =
		declaredPort && declaredPort !== 22
			? declaredPort
			: configPort || declaredPort || 22;
	if (!resolved.identityFile && options.identityfile) {
		// IdentityFile 可以写很多行，取第一把；%d 这类 token 不展开
		resolved.identityFile = unquote(options.identityfile).split(/\s+/)[0];
	}
	if (!resolved.proxyJump) resolved.proxyJump = unquote(options.proxyjump ?? "");
	// 页面默认值 accept-new 表示「没特意选」：config 里明确写了 yes / no 才盖过去
	const mode = String(options.stricthostkeychecking ?? "").toLowerCase();
	if (!host?.strictHostKeyChecking || host.strictHostKeyChecking === "accept-new") {
		if (mode === "yes" || mode === "no") resolved.strictHostKeyChecking = mode;
	}
	return resolved;
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
			if (check.register && handshake) handshake.register = check.register;
			return check.ok;
		},
	};
	config.username = String(host.user || localUser());
	if (host.password) {
		config.password = String(host.password);
		// 有些服务器（多半是 PAM）只给 keyboard-interactive 不给 password：
		// 允许把同一个密码当成交互式提示的回答再试一次。
		config.tryKeyboard = true;
	} else if (host.identityFile) {
		config.privateKey = readPrivateKey(host.identityFile);
		// 带口令的私钥：ssh2 解析时要用 passphrase 解密，没有它会报 "Encrypted private
		// OpenSSH key detected, but no passphrase given" —— 口令当密码用不管事，两种认证走两条路
		if (host.passphrase) config.passphrase = String(host.passphrase);
	} else if (agentPath()) config.agent = agentPath();
	return config;
}

// 私钥必须是个正常大小的小文件：指向 /dev/zero 或几 GB 的文件会在宿主事件循环上同步阻塞。
function readPrivateKey(file) {
	const path = expandHome(file);
	const stat = statSync(path);
	if (!stat.isFile() || stat.size > 1024 * 1024)
		throw new Error(`私钥文件不可用：${path}（要是个小于 1 MB 的普通文件）`);
	return readFileSync(path);
}

// 跳板机：只支持一跳。跳板自己的别名、用户、端口、私钥照样按 ~/.ssh/config 解析。
const openJumpChannel = (client, toHost, toPort, timeoutMs) =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(
			() =>
				reject(
					new Error(
						`跳板机没在 ${timeoutMs} 毫秒内打开通往 ${toHost}:${toPort} 的通道`,
					),
				),
			timeoutMs,
		);
		client.forwardOut("127.0.0.1", 0, toHost, toPort, (error, stream) => {
			clearTimeout(timer);
			if (error)
				reject(
					new Error(
						`跳板机打不开通往 ${toHost}:${toPort} 的通道：${error.message ?? error}`,
					),
				);
			else resolve(stream);
		});
	});

// 跳板机自己的凭据从哪来：页面里同名（或同主机）的那条记录优先，
// 记录里没写的再让 ~/.ssh/config 和 agent 补。
const findSavedJumpHost = (jump) => {
	const { hosts } = readHostsState();
	const wanted = String(jump.host).toLowerCase();
	const byName = hosts.find(
		(item) => String(item.name ?? "").toLowerCase() === wanted,
	);
	if (byName) return byName;
	return hosts.find((item) => String(item.host ?? "").toLowerCase() === wanted);
};

const connectViaJump = async (target, jump, { timeoutMs, signal }) => {
	const deadline = Date.now() + timeoutMs;
	const left = () => Math.max(deadline - Date.now(), 1000);
	const saved = findSavedJumpHost(jump);
	const jumpHost = resolveSshHost({
		name: saved?.name || `${target.name || target.host} 的跳板`,
		host: jump.host,
		user: jump.user || saved?.user,
		port: jump.port || saved?.port || 22,
		password: saved?.password,
		identityFile: saved?.identityFile,
		passphrase: saved?.passphrase,
	});
	// 别名在 config 里没写 HostName 时，用页面记录里填的真地址
	if (saved?.host && jumpHost.host === jump.host) jumpHost.host = saved.host;
	// 跳板的 config 里再写 ProxyJump 也不往下套：多跳压平成一跳
	jumpHost.proxyJump = "";
	let jumpClient;
	try {
		jumpClient = await connectDirect(jumpHost, {
			timeoutMs: left(),
			signal,
		});
	} catch (error) {
		throw new Error(
			`连不上跳板机 ${jumpHost.user ? `${jumpHost.user}@` : ""}${jumpHost.host}:${jumpHost.port}：${error.message ?? error}`,
		);
	}
	let stream;
	try {
		stream = await openJumpChannel(jumpClient, target.host, target.port, left());
	} catch (error) {
		jumpClient.end();
		throw error;
	}
	try {
		const client = await connectDirect(target, {
			timeoutMs: left(),
			signal,
			sock: stream,
		});
		// 目标连接关了就把跳板连接也关掉，否则那条 TCP 会一直挂着
		client.once("close", () => jumpClient.end());
		return client;
	} catch (error) {
		try {
			stream.destroy();
		} catch {
			// 通道已经没了
		}
		jumpClient.end();
		throw error;
	}
};

// 连上就交出去，调用方负责 client.end()。主机记录先叠上 ~/.ssh/config 的缺省值；
// 配了 ProxyJump（页面上的「跳板机」或 config 里的）就先连跳板，再从跳板开一条通道。
export function connect(host, { timeoutMs = TOOL_BUDGET_MS, signal } = {}) {
	const target = host?.__sshResolved ? host : resolveSshHost(host);
	const jump = parseProxyJump(target.proxyJump);
	if (!jump) return connectDirect(target, { timeoutMs, signal });
	return connectViaJump(target, jump, { timeoutMs, signal });
}

// 直连：密码、私钥、agent 三种认证在 connectConfig 里选。
function connectDirect(
	host,
	{ timeoutMs = TOOL_BUDGET_MS, signal, sock } = {},
) {
	return new Promise((resolve, reject) => {
		const client = new Client();
		// ssh2 的连接在握手之后还可能有 error（对端重启、网络断），没人听会直接把宿主炸掉
		client.on("error", () => {});
		// 服务器只给 keyboard-interactive 时，把密码当每个提示的回答。
		// 验证码/二次确认的提示也会拿到这个密码，连不上是正常的，但不比直接拒绝更差。
		if (host.password) {
			client.on(
				"keyboard-interactive",
				(_name, _instructions, _lang, prompts, finish) => {
					finish(prompts.map(() => String(host.password)));
				},
			);
		}
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
			// 握手过了才登记：此时主机密钥签名已经校验过
			if (handshake.register) registerHostKey(handshake.register);
			if (signal)
				signal.addEventListener("abort", () => client.end(), { once: true });
			resolve(client);
		});
		client.once("error", fail);
		try {
			const config = connectConfig(host, { handshake });
			// 跳板机转发出来的通道直接当底层 socket 用
			if (sock) config.sock = sock;
			client.connect(config);
		} catch (error) {
			fail(error);
		}
	});
}

// 同一个 agent 往往连着敲好几条命令：登录过的主机留一条连接复用，省掉每次 0.3~1 秒的握手。
// 空闲 60 秒断开；命令超时/取消时整条连接作废（远端那条命令还在跑，不能留着同一个会话）。
const IDLE_MS = 60000;
const pool = new Map();

// 认证凭据变了就是另一条连接：换了密码或私钥，不能拿旧会话继续用。
// 跳板链也算进去：同一台目标机经不同跳板过去，远端看到的是不同来源。
export const poolKey = (host) => {
	const auth = host.password
		? `password:${host.password}`
		: host.identityFile
			? `key:${expandHome(host.identityFile)}`
			: "agent";
	const jump = parseProxyJump(host.proxyJump);
	const via = jump
		? `|via:${jump.user ? `${jump.user}@` : ""}${jump.host}:${jump.port || 22}`
		: "";
	return `${host.user || localUser() || "root"}@${host.host}:${Number(host.port) || 22}|${auth}${via}`;
};

export const poolStats = () =>
	[...pool.values()].map((entry) => ({ key: entry.key, busy: entry.busy }));

const closeEntry = (entry) => {
	if (entry.closed) return;
	clearTimeout(entry.timer);
	entry.closed = true;
	// 只摘自己：不是复用池里的那条（reuse:false）时，池里同一台主机的条目不能被顺手删掉
	if (pool.get(entry.key) === entry) pool.delete(entry.key);
	const { client } = entry;
	client.end();
	// ssh2 的 end() 只发 DISCONNECT，半关的 socket 会一直占住事件循环（CLI 里表现成进程不退出）
	const force = setTimeout(() => client.destroy?.(), 200);
	force.unref?.();
};

// 放回一条连接。broken 表示这次调用不能再用它（超时、取消、传输失败）：
// 减掉自己的引用后，只有整条连接上再没别人时才真的关掉——否则同主机的其他调用会被连坐。
// 调用方负责先关掉自己那条 channel / SFTP 子系统。
export const releaseConnection = (entry, { broken = false } = {}) => {
	if (!entry.pooled) return closeEntry(entry);
	entry.busy = Math.max(entry.busy - 1, 0);
	if (broken) {
		if (entry.busy) return undefined;
		return closeEntry(entry);
	}
	if (entry.busy || entry.closed) return undefined;
	clearTimeout(entry.timer);
	entry.timer = setTimeout(() => closeEntry(entry), IDLE_MS);
	// 空闲计时不能拖住宿主退出
	entry.timer.unref?.();
	return undefined;
};

export const closeAllConnections = () => {
	for (const entry of [...pool.values()]) closeEntry(entry);
};

const openConnection = async (host, { timeoutMs, signal, reuse }) => {
	// 先按 ~/.ssh/config 补缺省值，再用补好的身份做连接池的键：
	// 别名和它的真名、config 里给的端口，才算同一条连接
	const target = host?.__sshResolved ? host : resolveSshHost(host);
	const key = poolKey(target);
	const cached = reuse === false ? undefined : pool.get(key);
	if (cached && !cached.closed) {
		cached.busy += 1;
		clearTimeout(cached.timer);
		return cached;
	}
	const client = await connect(target, { timeoutMs, signal });
	const entry = {
		key,
		client,
		busy: 1,
		closed: false,
		timer: null,
		pooled: reuse !== false,
	};
	client.on("close", () => {
		clearTimeout(entry.timer);
		entry.closed = true;
		if (pool.get(entry.key) === entry) pool.delete(entry.key);
	});
	if (entry.pooled) pool.set(key, entry);
	return entry;
};

// 一个工具调用只有一份时间预算：连接花掉的时间从执行时间里扣，别让两者相加超过 magpie 的 55 秒。
export async function execOnce(
	host,
	command,
	{ timeoutMs = TOOL_BUDGET_MS, signal, reuse } = {},
) {
	const started = Date.now();
	const deadline = started + timeoutMs;
	const left = () => Math.max(deadline - Date.now(), 1000);
	const entry = await openConnection(host, {
		timeoutMs: left(),
		signal,
		reuse,
	});
	const client = entry.client;
	// 超时、取消、握手后出错都算这条连接不能再用了；只管放一次
	let released = false;
	const handOff = (broken) => {
		if (released) return;
		released = true;
		releaseConnection(entry, { broken });
	};
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
			let reason = null;
			let settled = false;
			// 自己这条 channel：超时/取消时只关它，连接留给同主机的其他调用
			let channel = null;
			const finish = (code) => {
				if (settled) return;
				settled = true;
				push("out", decoders.out.end());
				push("err", decoders.err.end());
				resolve({ code, aborted, reason, segments });
			};
			const stop = (why) => {
				aborted = true;
				reason ??= why;
				// 远端那条命令可能还在跑：关掉自己这条 channel 就够了，整条连接还能给
				// 同主机上并发的调用用；作废连接会把它们一起掐断
				try {
					channel?.destroy?.();
				} catch {
					// 通道已经没了，没什么可关的
				}
				handOff(true);
				finish(-1);
			};
			const timer = setTimeout(() => stop("timeout"), left());
			// 取消也是失败：否则关连接后拿到的 undefined 会被当成 exit 0
			signal?.addEventListener("abort", () => stop("cancel"), { once: true });
			// 取消可能发生在连接期间：那时监听器还没挂上，abort 事件不会再补发
			if (signal?.aborted) stop("cancel");
			if (settled) return;
			client.exec(String(command), (err, stream) => {
				if (err) {
					clearTimeout(timer);
					if (!aborted) push("err", String(err.message));
					finish(-1);
					return;
				}
				channel = stream;
				const collect = (kind, decoder) => (chunk) => {
					if (sink.push(chunk)) push(kind, decoder.write(chunk));
				};
				stream.on("data", collect("out", decoders.out));
				stream.stderr.on("data", collect("err", decoders.err));
				// exit-signal 时 ssh2 给 code=null，通道没等到 exit-status 就关也是 null：
				// 被信号杀死、半路掉线都不能报成功，agent 会当成命令跑完了
				stream.on("close", (code, signalText) => {
					clearTimeout(timer);
					if (aborted) return finish(-1);
					if (typeof code === "number") return finish(code);
					push(
						"err",
						signalText
							? `被信号中断（${signalText}），没有退出码。`
							: "连接在拿到退出码之前断开了。",
					);
					return finish(-1);
				});
			});
		});
		if (sink.truncated)
			result.note = "[输出超过 4MB，已丢弃后续内容，命令继续执行]";
		result.ms = Date.now() - started;
		result.host = host;
		return result;
	} finally {
		handOff(false);
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
	{ timeoutMs = TOOL_BUDGET_MS, maxChars, signal, concurrency = 8, reuse } = {},
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
					reuse,
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
	// 预算是「这次调用」的：8 台各给满额会把调用方的上下文撑爆，按台分摊。
	const perHost = batchBudget(maxChars, hosts.length);
	const body = hosts
		.map(
			(host, index) =>
				`== ${host.name || host.host} (${host.user || "root"}@${host.host}:${host.port || 22}) ==\n${render(out[index], perHost)}`,
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

// SFTP 不展开 ~（那是客户端的事），run 里的 ~ 由远端 shell 展开，两边行为要一致。
export const remotePath = (value, home) => {
	const text = String(value ?? "");
	if (!home) return text;
	if (text === "~") return home;
	if (!text.startsWith("~/")) return text;
	return `${String(home).replace(/\/+$/, "")}/${text.slice(2)}`;
};

export async function transferRemote(
	host,
	local,
	remote,
	direction,
	{ timeoutMs = TOOL_BUDGET_MS, signal, reuse } = {},
) {
	const deadline = Date.now() + timeoutMs;
	const left = () => Math.max(deadline - Date.now(), 1000);
	const entry = await openConnection(host, {
		timeoutMs: left(),
		signal,
		reuse,
	});
	const client = entry.client;
	let broken = false;
	try {
		const sftp = await new Promise((resolve, reject) => {
			// SFTP 子系统的启动也算在预算里，否则它卡住就没有任何兜底
			const timer = setTimeout(
				() => reject(new Error("打开 SFTP 超时")),
				left(),
			);
			client.sftp((err, handle) => {
				clearTimeout(timer);
				if (err) reject(err);
				else resolve(handle);
			});
		});
		// realpath 也要算进预算：它挂在同一条连接上，卡住照样要放手
		const home = await new Promise((resolve) => {
			if (!String(remote).startsWith("~")) return resolve(null);
			const timer = setTimeout(() => resolve(null), left());
			sftp.realpath(".", (err, dir) => {
				clearTimeout(timer);
				resolve(err ? null : dir);
			});
		});
		const path = remotePath(remote, home);
		return await new Promise((resolve) => {
			const timer = setTimeout(() => {
				broken = true;
				// 只关自己的 SFTP 子系统：连接上还有别的调用时留给它们，
				// 整条作废会把同主机上并发的 run 一起掐断
				try {
					sftp.end();
				} catch {
					// 已经关了
				}
				resolve(`exit -1（传输超时，${timeoutMs} 毫秒）`);
			}, left());
			const done = (err) => {
				clearTimeout(timer);
				resolve(
					err
						? `exit -1\n[stderr]\n${err.message}`
						: `exit 0\n${direction === "put" ? `${local} → ${path}` : `${path} → ${local}`}`,
				);
			};
			if (direction === "put") sftp.fastPut(local, path, done);
			else sftp.fastGet(path, local, done);
		});
	} finally {
		releaseConnection(entry, { broken });
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
	if (result.aborted)
		head[0] +=
			result.reason === "cancel"
				? "（调用被取消，连接已断开）"
				: "（已超时，连接被断开）";
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

export const clampChars = (value) => {
	// 负数、0、NaN 都走默认；下限 200 保证报错信息还能留在返回值里
	const wanted = Math.floor(Number(value));
	const size =
		Number.isFinite(wanted) && wanted > 0 ? wanted : DEFAULT_MAX_CHARS;
	return Math.min(Math.max(size, 200), 200000);
};

// 一次批量调用的输出上限按台分摊：整份结果不超出 maxChars，每台至少留 200 字符报错。
export const batchBudget = (maxChars, count) =>
	Math.max(200, Math.floor(clampChars(maxChars) / Math.max(count, 1)));

// 审计日志默认关：多 agent 共用一台 root 主机时，把谁在什么时候跑了什么记成一行 JSON。
export const configDir = () =>
	process.env.XDG_CONFIG_HOME || join(homedir(), ".config", "magpie");
export const auditFile = () => join(configDir(), "magpie-ssh-audit.log");
// 日志不能无限长：满了就换一份 .1，只留一代——查「谁跑了什么」看最近的够用
export const AUDIT_FILE_MAX_BYTES = 2 * 1024 * 1024;

const rotateAudit = (file) => {
	try {
		if (statSync(file).size < AUDIT_FILE_MAX_BYTES) return;
		rmSync(`${file}.1`, { force: true });
		renameSync(file, `${file}.1`);
	} catch {
		// 还没有文件、或者换不动：这次照旧往后追
	}
};

// 被内容注入的 agent 能拿 get 覆盖本机凭据、拿 put 把 plugins.json（明文密码）传出去：
// 只拦这两个目录，其余路径照旧——本地路径就是给人用的。
export function guardLocal(file, direction) {
	// Windows 和 macOS 的文件系统不区分大小写（~/.SSH/id_ed25519 照样能覆盖），比较前统一小写
	const fold = (value) =>
		process.platform === "linux" ? value : value.toLowerCase();
	const full = fold(resolve(expandHome(file)));
	// 两个方向都护住凭据目录：get 不许往里写（能把 known_hosts 换成攻击者的），
	// put 不许往外取（被内容注入的 agent 能把私钥、plugins.json 一起传走）
	const dirs = [configDir(), join(homedir(), ".ssh")];
	for (const dir of dirs) {
		const root = resolve(dir);
		if (full === fold(root) || full.startsWith(fold(`${root}${sep}`)))
			return `不动 ${root}：那是存凭据的地方，${direction === "get" ? "get 不对着它写" : "put 不从它取文件"}。要传就自己复制到别处再传。`;
	}
	return null;
}

export function audit(options, record) {
	if (!options?.auditLog) return;
	try {
		// 命令原文里可能带凭据：只有本人能读
		mkdirSync(dirname(auditFile()), { recursive: true, mode: 0o700 });
		rotateAudit(auditFile());
		appendFileSync(
			auditFile(),
			`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`,
			{ mode: 0o600 },
		);
	} catch {
		// 记日志失败不能影响调用本身
	}
}
