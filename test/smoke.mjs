// 只测纯逻辑：读 plugins.json、连接配置、known_hosts 指纹判断、工具在坏参数下回文本而不抛。
// 真连接不在这里测（要真主机和凭据）。
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
	audit,
	batchBudget,
	clampChars,
	closeAllConnections,
	auditFile,
	AUDIT_FILE_MAX_BYTES,
	collectRemoteTree,
	connectConfig,
	configDir,
	fingerprint,
	guardLocal,
	insideGuardDirs,
	hostIds,
	keyType,
	makeSink,
	parseProxyJump,
	parseSshConfig,
	pickHost,
	pickHosts,
	readHosts,
	readHostsState,
	registerHostKey,
	resolveSshHost,
	releaseConnection,
	treeReport,
	poolKey,
	poolStats,
	remotePath,
	render,
	walkLocalTree,
	sshConfigOptions,
	verifyHostKey,
} from "../lib.mjs";
import * as entry from "../index.mjs";

// 入口模块只许导出插件工厂：magpie 把导出的每个函数都当工厂调一次，多一个就整个插件失败
const MagpieSsh = entry.MagpieSsh;
assert.deepEqual(
	Object.entries(entry)
		.filter(([, value]) => typeof value === "function")
		.map(([name]) => name),
	["MagpieSsh"],
);

const home = mkdtempSync(join(tmpdir(), "magpie-ssh-"));
process.env.XDG_CONFIG_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, "magpie"), { recursive: true });
const writePlugins = (plugins) => {
	writeFileSync(
		join(home, "magpie", "plugins.json"),
		JSON.stringify({ plugins }),
	);
};
// plugins.json 的目录要先存在
writePlugins([]);

const host = {
	id: "a1",
	name: "prod",
	host: "10.0.0.5",
	port: 2222,
	user: "root",
	password: "s3cret",
	note: "线上",
};

// 没有配置文件时是空表
assert.deepEqual(readHosts(null), []);
// 复用的键跟着认证方式走：换密码、换端口、换用户都是另一条连接
assert.notEqual(poolKey(host), poolKey({ ...host, password: "other" }));
assert.notEqual(poolKey(host), poolKey({ ...host, port: 22 }));
assert.notEqual(poolKey(host), poolKey({ ...host, user: "pi" }));
assert.equal(poolKey(host), poolKey({ ...host, name: "改个名字" }));
// 没连过就是空池，全关一遍也不炸
assert.deepEqual(poolStats(), []);
closeAllConnections();

// 自己的条目没存主机时，也不能去捡别的插件的 hosts（那是别人的凭据）
writePlugins([
	{ spec: "magpie-ssh", options: {} },
	{ spec: "C:\\some\\other\\place", options: { hosts: [host] } },
]);
assert.deepEqual(readHosts(null), []);

// spec 里没有 magpie-ssh 的插件不碰：别的插件也可能有 hosts 字段
writePlugins([{ spec: "some-fork", options: { hosts: [host] } }]);
assert.equal(readHosts(null).length, 0);
// 同一个插件被装了两次、其中一条是空的残留时，认真有主机的那条
writePlugins([
	{ spec: "github:ltsj/magpie-ssh", options: { hosts: [] } },
	{ spec: "magpie-ssh@0.4.2", options: { hosts: [host] } },
]);
assert.equal(readHosts(null)[0].name, "prod");

// 文件里没有时用宿主给的 options 快照
assert.equal(readHosts({ hosts: [host] }).length, 1);

// 端口写法：22 用主机名，其他端口用 [host]:port
assert.deepEqual(hostIds({ host: "h" }), ["h"]);
assert.deepEqual(hostIds({ host: "h", port: 22 }), ["h"]);
assert.deepEqual(hostIds({ host: "h", port: 2222 }), ["h", "[h]:2222"]);

// 认证方式：密码 > 私钥 > agent
assert.equal(connectConfig(host).password, "s3cret");
assert.equal(connectConfig(host).port, 2222);
assert.equal(connectConfig(host).username, "root");
assert.equal(connectConfig(host).readyTimeout, 10000);
const keyFile = join(home, "id_test");
writeFileSync(keyFile, "-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n");
const keyed = connectConfig({ name: "k", host: "h", identityFile: keyFile });
assert.ok(Buffer.isBuffer(keyed.privateKey));
// 私钥路径不是普通文件、或者大到能把宿主卡死，直接拒
assert.throws(
	() => connectConfig({ name: "k", host: "h", identityFile: home }),
	/私钥文件不可用/,
);
assert.equal(keyed.password, undefined);
assert.equal(keyed.passphrase, undefined);
// 带口令的私钥：passphrase 原样交给 ssh2 去解，没它就解不开这把钥匙
const lockedKey = connectConfig({
	name: "k",
	host: "h",
	identityFile: keyFile,
	passphrase: "secret",
});
assert.equal(lockedKey.passphrase, "secret");
// 密码认证时口令不该混进来：两条认证路只走一条
assert.equal(
	connectConfig({ ...host, identityFile: keyFile, passphrase: "secret" })
		.passphrase,
	undefined,
);
process.env.SSH_AUTH_SOCK = "\\\\pipe\\test-agent";
const agented = connectConfig({ name: "a", host: "h" });
assert.equal(agented.agent, "\\\\pipe\\test-agent");
assert.equal(agented.password, undefined);
// 只给 password 认证的服务器不吃 password、只给 keyboard-interactive：
// 密码认证时开 tryKeyboard，把同一个密码当提示的回答；私钥/agent 不开
assert.equal(connectConfig(host).tryKeyboard, true);
assert.equal(keyed.tryKeyboard, undefined);
assert.equal(agented.tryKeyboard, undefined);
// 用户没填时按本机登录名走：ssh2 不接受空用户名，以前会直接报 Invalid username
assert.equal(
	connectConfig({ name: "u", host: "h" }).username,
	userInfo().username,
);

// known_hosts：登记要等握手通过（不在指纹校验里写）、yes 拒未知、指纹变了拒
const known = join(home, "known_hosts");
const blob = Buffer.concat([
	(() => {
		const size = Buffer.alloc(4);
		size.writeUInt32BE(11);
		return size;
	})(),
	Buffer.from("ssh-ed25519"),
	Buffer.from([1, 2, 3]),
]);
assert.equal(keyType(blob), "ssh-ed25519");

const unknown = { host: "10.0.0.5", port: 2222 };
assert.equal(verifyHostKey(unknown, blob, "yes", known).ok, false);
const first = verifyHostKey(unknown, blob, "accept-new", known);
assert.equal(first.ok, true);
assert.equal(
	first.register,
	`[10.0.0.5]:2222 ssh-ed25519 ${blob.toString("base64")}`,
);
assert.equal(existsSync(known), false, "指纹校验里不许写 known_hosts");
registerHostKey(first.register, known);
registerHostKey("随便一行不是 known_hosts 格式", known);
assert.equal(readFileSync(known, "utf8").trim().split("\n").length, 1);
assert.equal(verifyHostKey(unknown, blob, "accept-new", known).ok, true);
assert.equal(verifyHostKey(unknown, blob, "yes", known).ok, true);
// 没填 / 空的 strictHostKeyChecking 都按 accept-new：首次就登记
const skipped = verifyHostKey(unknown, blob, "", join(home, "known_skip"));
assert.equal(skipped.ok, true);
assert.match(skipped.register, /^\[10\.0\.0\.5\]:2222 ssh-ed25519 /);
assert.equal(
	verifyHostKey(unknown, blob, undefined, join(home, "known_skip")).register,
	skipped.register,
);
// 只有明确的 no 才是不校验也不登记
const off = verifyHostKey(unknown, blob, "no", join(home, "known_off"));
assert.equal(off.ok, true);
assert.equal(off.register, undefined);

const other = Buffer.concat([blob, Buffer.from([9])]);
const mismatch = verifyHostKey(unknown, other, "accept-new", known);
assert.equal(mismatch.ok, false);
assert.match(mismatch.error, /指纹和 known_hosts 里的不一样/);

// 同主机 22 端口的条目不能拿来判 2222 端口「指纹变了」：那是没记录过，不是变了
const portFile = join(home, "known_ports");
writeFileSync(portFile, `10.0.0.5 ssh-ed25519 ${blob.toString("base64")}\n`);
const otherPort = verifyHostKey(
	{ host: "10.0.0.5", port: 2222 },
	Buffer.concat([blob, Buffer.from([7])]),
	"yes",
	portFile,
);
assert.match(otherPort.error, /known_hosts 里没有 \[10\.0\.0\.5\]:2222/);
assert.doesNotMatch(otherPort.error, /指纹和 known_hosts 里的不一样/);

// 哈希形式的条目（|1|salt|hmac，Linux 上 HashKnownHosts 默认会写这种）
const hashFile = join(home, "known_hashed");
const salt = Buffer.from("0123456789abcdef");
const mac = createHmac("sha1", salt).update("10.0.0.5").digest("base64");
writeFileSync(
	hashFile,
	`|1|${salt.toString("base64")}|${mac} ssh-ed25519 ${blob.toString("base64")}\n`,
);
assert.equal(
	verifyHostKey({ host: "10.0.0.5" }, blob, "yes", hashFile).ok,
	true,
);

// @revoked 只看钥匙、不看主机字段（OpenSSH 的吊销是全局的）；@cert-authority 做不到，跳过
const markerFile = join(home, "known_markers");
writeFileSync(
	markerFile,
	`@revoked * ssh-ed25519 ${blob.toString("base64")}\n@cert-authority *.lan ssh-ed25519 AAAA\n`,
);
for (const mode of ["accept-new", "yes", "no"]) {
	const revoked = verifyHostKey({ host: "10.0.0.5" }, blob, mode, markerFile);
	assert.equal(revoked.ok, false);
	assert.match(revoked.error, /@revoked/);
}
// 别的主机用同一把被吊销的钥匙也不行
assert.equal(
	verifyHostKey({ host: "other.example" }, blob, "accept-new", markerFile).ok,
	false,
);
// 不同钥匙不受影响
assert.equal(
	verifyHostKey({ host: "other.example" }, other, "accept-new", markerFile).ok,
	true,
);

// SFTP 不认 ~：客户端要自己按远端 home 展开，run 里的 ~ 由远端 shell 展开
assert.equal(remotePath("~/a/b", "/home/pi"), "/home/pi/a/b");
assert.equal(remotePath("~/a", "/home/pi/"), "/home/pi/a");
assert.equal(remotePath("/etc/passwd", "/home/pi"), "/etc/passwd");
assert.equal(remotePath("rel.txt", "/home/pi"), "rel.txt");
assert.equal(remotePath("~/a", null), "~/a");
assert.equal(remotePath("~", "/home/pi"), "/home/pi");

// 找主机：按名称、按主机名；找不到时给出原因
assert.equal(pickHost([host], "prod").host.id, "a1");
assert.equal(pickHost([host], "10.0.0.5").host.id, "a1");
assert.match(
	pickHost([host], "nope").error,
	/没有叫 nope 的主机。已配置：prod/,
);
assert.match(pickHost([], "nope").error, /还没有配置 SSH 主机/);

// 工具装载：四个工具都在，坏参数回文本（magpie 加载时就这么探一次，抛异常会整个插件失败）
writePlugins([{ spec: "magpie-ssh", options: { hosts: [host] } }]);
const plugin = await MagpieSsh({}, { hosts: [host] });
assert.deepEqual(Object.keys(plugin.tool).sort(), [
	"check",
	"get",
	"hosts",
	"put",
	"run",
]);
assert.match(
	await plugin.tool.hosts.execute(),
	/- prod {2}root@10\.0\.0\.5:2222 {2}密码/,
);
assert.match(
	await plugin.tool.run.execute({}),
	/需要用 command 给出要执行的命令/,
);
assert.match(
	await plugin.tool.run.execute({ host: "nope", command: "ls" }),
	/没有叫 nope 的主机/,
);
assert.match(
	await plugin.tool.run.execute({ host: "prod" }),
	/需要用 command 给出要执行的命令/,
);

writePlugins([]);
const bare = await MagpieSsh({}, null);
assert.match(
	await bare.tool.run.execute({ host: "prod", command: "ls" }),
	/还没有配置 SSH 主机/,
);
assert.match(await bare.tool.put.execute({}), /还没有配置 SSH 主机/);
assert.match(await bare.tool.get.execute({}), /还没有配置 SSH 主机/);
assert.match(
	await bare.tool.get.execute({ host: "prod", remote: "/a", local: "/b" }),
	/还没有配置 SSH 主机/,
);
assert.match(
	await bare.tool.check.execute({ host: "*" }),
	/还没有配置 SSH 主机/,
);
const sink = makeSink(10);
assert.equal(sink.push(Buffer.from("1234")), true);
assert.equal(sink.push(Buffer.from("1234")), true);
assert.equal(sink.push(Buffer.from("1234")), false);
assert.equal(sink.truncated, true);
assert.equal(sink.push(Buffer.from("1")), false);

assert.match(
	await bare.tool.run.execute({ host: "*", command: "uname -a" }),
	/还没有配置 SSH 主机/,
);

// 超时只报断连；输出超限只丢内容并注记，两者不能互相假扮
assert.match(
	render({ code: -1, aborted: true, stdout: "", stderr: "" }, 100),
	/^exit -1（已超时，连接被断开）$/,
);
// 取消不能说成超时，更不能说成成功
assert.equal(
	render({ code: -1, aborted: true, reason: "cancel", segments: [] }, 100),
	"exit -1（调用被取消，连接已断开）",
);
assert.match(
	render(
		{ code: 0, aborted: false, note: "[note]", stdout: "x", stderr: "" },
		100,
	),
	/^exit 0\n\[note\]\nx$/,
);
assert.match(render({ code: 0, stdout: "abcdef", stderr: "e" }, 3), /截断/);
// "exit 0\na" 共 8 字符，第 9 个正好是 emoji 的高位代理：不能切出半个字符
const split = render({ code: 0, stdout: "a\u{1F600}b", stderr: "" }, 9);
assert.ok(
	!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(split),
	"lone surrogate in output",
);

// 逗号多选、* 全选、去重、未知名字要点名
const three = [
	{ name: "a", host: "1.1.1.1" },
	{ name: "b", host: "2.2.2.2" },
	{ name: "c", host: "3.3.3.3" },
];
assert.equal(pickHosts(three, "a,b").list.length, 2);
assert.equal(pickHosts(three, "a,a").list.length, 1);
assert.equal(pickHosts(three, "A").list[0].name, "a");
assert.equal(pickHosts(three, "*").list.length, 3);
assert.equal(pickHosts(three, "all").list.length, 3);
assert.match(pickHosts(three, "a,zz").error, /没有叫 zz 的主机/);
assert.match(pickHosts([], "*").error, /还没有配置 SSH 主机/);

// 指纹格式和 ssh-keygen -lf 一样：SHA256: 加 base64、不带尾部 =
const keyBlob = Buffer.concat([
	Buffer.from([0, 0, 0, 7]),
	Buffer.from("ssh-rsa"),
	Buffer.from("payload"),
]);
assert.equal(keyType(keyBlob), "ssh-rsa");
assert.match(fingerprint(keyBlob), /^SHA256:[A-Za-z0-9+/]+$/);
assert.equal(fingerprint(keyBlob).length, 7 + 43);

// stdout/stderr 交错时保持先后顺序，stderr 就地标一行
const mixed = render(
	{
		code: 1,
		aborted: false,
		segments: [
			{ kind: "out", text: "line1\n" },
			{ kind: "err", text: "boom\n" },
			{ kind: "out", text: "line2\n" },
		],
	},
	1000,
);
assert.equal(mixed, "exit 1\nline1\n[stderr] boom\nline2");

// 审计默认关：没开就不许落文件
audit({}, { tool: "run", command: "ls" });
audit({ auditLog: false }, { tool: "run", command: "ls" });
assert.equal(existsSync(auditFile()), false);
audit({ auditLog: true }, { tool: "run", hosts: ["a"], command: "ls" });
const logged = readFileSync(auditFile(), "utf8").trim().split("\n");
assert.equal(logged.length, 1);
assert.equal(JSON.parse(logged[0]).command, "ls");
// 批量输出是「一次调用」的预算，不能 8 台各给满额
assert.equal(batchBudget(16000, 5), 3200);
assert.equal(batchBudget(16000, 1), 16000);
assert.equal(batchBudget(200000, 8), 25000);
assert.equal(batchBudget(undefined, 3), 5333);
// 台数多到每台不足 200 时不再往下摊，否则报错信息会被切没
assert.equal(batchBudget(1000, 5), 200);
// 负数、NaN 都走默认，不会切出 "" 或奇怪的下标
assert.equal(clampChars(-5), 16000);
assert.equal(clampChars(Number.NaN), 16000);
assert.equal(clampChars(1), 200);
// 本机路径护栏：两个方向都护住凭据目录
// get 不许往里写（能把 known_hosts 或 authorized_keys 换成攻击者的），
// put 不许往外取（被内容注入的 agent 能把私钥、plugins.json 一起传走）
// Windows / macOS 上大小写不敏感：.SSH 照样能碰到真目录
if (process.platform !== "linux") {
	assert.match(guardLocal(join(home, ".SSH", "id_ed25519"), "get"), /不动/);
	assert.match(guardLocal(join(home, ".SSH", "id_ed25519"), "put"), /不动/);
	// 配置目录本身也在 home 下，大小写变体同样要拦住
	assert.match(guardLocal(join(home, "MAGPIE", "plugins.json"), "put"), /不动/);
}
// 护栏只盖住 magpie 自己的目录，不能把整个 ~/.config 都算进去：
// Linux 上 XDG_CONFIG_HOME 往往就设成 ~/.config，那样别的应用的文件也会被一起拦掉
assert.equal(guardLocal(join(home, "other-app", "settings.json"), "put"), null);
assert.equal(guardLocal(join(home, "other-app", "settings.json"), "get"), null);
assert.match(guardLocal(join(configDir(), "plugins.json"), "get"), /不动/);
assert.match(guardLocal(join(home, ".ssh", "authorized_keys"), "get"), /不动/);
assert.match(guardLocal(join(home, ".ssh", "id_ed25519"), "put"), /不动/);
assert.match(guardLocal(join(configDir(), "plugins.json"), "put"), /不动/);
assert.equal(
	guardLocal(join(tmpdir(), "elsewhere", "id_ed25519"), "put"),
	null,
);
assert.equal(guardLocal(join(tmpdir(), "elsewhere", "a.txt"), "get"), null);

// 配置目录固定是 $XDG_CONFIG_HOME/magpie：少拼一层会把整个 ~/.config 当成凭据目录
assert.equal(configDir(), join(home, "magpie"));

// 目录传输的报告：只有「一个不落」才是 exit 0；超时和失败都得是 exit -1，
// 否则调用方会把「传了 3 个、还剩 30 个」当成全量成功
assert.match(treeReport("上传", 3, 300, 3, [], 0, [], "/srv", false), /^exit 0/);
assert.match(treeReport("上传", 1, 100, 30, [], 0, [], "/srv", true), /^exit -1/);
assert.match(
	treeReport("上传", 1, 100, 30, [], 0, [], "/srv", true),
	/时间预算用完/,
);
assert.match(
	treeReport("下载", 1, 100, 2, [], 0, ["b.css: 拒绝"], "/tmp/x", false),
	/^exit -1\n\[stderr\]\nb\.css: 拒绝/,
);

// 递归传目录时逐个路径再查一遍：上层目录合法也不能把 ~/.ssh 带出去
// 大小写折叠只在 macOS / Windows 上做：Linux 上 .SSH 是另一个目录，不该被拦
assert.equal(
	insideGuardDirs(join(home, ".SSH", "id_ed25519")),
	process.platform !== "linux",
);
assert.equal(insideGuardDirs(join(home, ".ssh", "nested", "x")), true);
assert.equal(insideGuardDirs(join(configDir(), "plugins.json")), true);
assert.equal(insideGuardDirs(join(tmpdir(), "elsewhere", "a.txt")), false);
// plugins.json 读坏了要报出来，不能悄悄当空表：用户会以为主机没了，跑去重配一遍
const pluginsJson = join(home, "magpie", "plugins.json");
writeFileSync(pluginsJson, '{ "plugins": [ 少个括号 ');
const broken = readHostsState(null);
assert.deepEqual(broken.hosts, []);
assert.match(broken.error, /不是合法 JSON/);
// 顶层不是插件表也算坏：数组、字符串都不认
writeFileSync(pluginsJson, JSON.stringify([host]));
assert.match(readHostsState(null).error, /不是 magpie 的插件表/);
// plugins 字段得是数组
writeFileSync(pluginsJson, JSON.stringify({ plugins: {} }));
assert.match(readHostsState(null).error, /plugins/);
// 读得动的时候没有 error，旧接口 readHosts 照旧只给数组
writePlugins([{ spec: "magpie-ssh", options: { hosts: [host] } }]);
const good = readHostsState(null);
assert.equal(good.error, undefined);
assert.equal(good.hosts[0].name, "prod");
assert.equal(readHosts(null)[0].name, "prod");

// 复用连接不连坐：一次超时/取消只作废自己那条 channel，
// 同主机还有别人在用就留着连接；最后一个用坏的才关整条
const fakeClient = (entry) => ({
	end() {
		entry.ended = true;
	},
	destroy() {},
});
const shared = {
	key: "root@shared:22|agent",
	pooled: true,
	busy: 2,
	closed: false,
	client: {},
};
shared.client = fakeClient(shared);
releaseConnection(shared, { broken: true });
assert.equal(shared.busy, 1);
assert.equal(shared.ended, undefined, "还有别人在用，不许关连接");
releaseConnection(shared, { broken: true });
assert.equal(shared.ended, true, "最后一个用坏的才关整条");
assert.equal(shared.closed, true);

const idle = {
	key: "root@idle:22|agent",
	pooled: true,
	busy: 1,
	closed: false,
	client: {},
};
idle.client = fakeClient(idle);
releaseConnection(idle);
assert.equal(idle.busy, 0);
assert.equal(idle.ended, undefined, "正常放回不关连接，等空闲计时");
assert.ok(idle.timer, "放回后要起空闲计时");

// 不走复用池的连接（reuse:false）用完就关
const single = {
	key: "root@once:22|agent",
	pooled: false,
	busy: 1,
	closed: false,
	client: {},
};
single.client = fakeClient(single);
releaseConnection(single);
assert.equal(single.ended, true);

// 审计日志太大就转成 .1 再写，只留一代：不然常驻 agent 能把盘写满
writeFileSync(auditFile(), "x".repeat(AUDIT_FILE_MAX_BYTES));
audit({ auditLog: true }, { tool: "run", command: "after-rotate" });
assert.ok(existsSync(`${auditFile()}.1`), "超限的旧日志该转到 .1");
const rotated = readFileSync(auditFile(), "utf8").trim().split("\n");
assert.equal(rotated.length, 1);
assert.equal(JSON.parse(rotated[0]).command, "after-rotate");

// ---- ~/.ssh/config：别名、缺省值、跳板机 ----
// 只解析本插件用得上的那层：Host 块、键值；Match 整块跳过
const sshConfigPath = join(home, "sshconfig");
writeFileSync(
	sshConfigPath,
	[
		"# 全局默认",
		"ServerAliveInterval 30",
		"",
		"Host web",
		"  HostName 10.0.0.9",
		"  User deploy",
		"  Port 2222",
		"  IdentityFile ~/.ssh/id_web",
		"",
		"Host *.lab !db.lab",
		"  User labuser",
		"  ProxyJump ops@bastion:22022",
		"",
		"Host db.lab",
		"  User dbadmin",
		"",
		"Match host infinity",
		"  User never",
		"",
		"Host *",
		"  StrictHostKeyChecking no",
	].join("\n"),
);
const sshText = readFileSync(sshConfigPath, "utf8");
// 文件开头没有 Host 的选项是全局默认，也算一个块；Match 块整个跳过
assert.equal(parseSshConfig(sshText).length, 5);
assert.equal(sshConfigOptions("web", sshConfigPath).serveraliveinterval, "30");
assert.equal(sshConfigOptions("web", sshConfigPath).hostname, "10.0.0.9");
assert.equal(sshConfigOptions("web", sshConfigPath).user, "deploy");
assert.equal(sshConfigOptions("web", sshConfigPath).port, "2222");
assert.equal(sshConfigOptions("web", sshConfigPath).identityfile, "~/.ssh/id_web");
assert.equal(sshConfigOptions("web", sshConfigPath).stricthostkeychecking, "no");
// 通配和排除：*.lab 命中 a.lab，但 db.lab 被 !db.lab 排除，走自己的块
assert.equal(sshConfigOptions("a.lab", sshConfigPath).user, "labuser");
assert.equal(sshConfigOptions("a.lab", sshConfigPath).proxyjump, "ops@bastion:22022");
assert.equal(sshConfigOptions("db.lab", sshConfigPath).user, "dbadmin");
assert.equal(sshConfigOptions("db.lab", sshConfigPath).proxyjump, undefined);
// 读不到文件当成没有配置
assert.deepEqual(sshConfigOptions("web", join(home, "nope")), {});

assert.deepEqual(parseProxyJump("ops@bastion:22022"), {
	user: "ops",
	host: "bastion",
	port: 22022,
});
assert.deepEqual(parseProxyJump("bastion"), { user: "", host: "bastion", port: 0 });
assert.deepEqual(parseProxyJump("[::1]:2222"), { user: "", host: "::1", port: 2222 });
assert.equal(parseProxyJump("none"), null);
assert.equal(parseProxyJump(""), null);

// 记录叠 config：别名换成 HostName，用户/端口/私钥/跳板都补上
const webHost = resolveSshHost({ name: "web", host: "web", port: 22 }, sshConfigPath);
assert.equal(webHost.host, "10.0.0.9");
assert.equal(webHost.user, "deploy");
assert.equal(webHost.port, 2222);
assert.equal(webHost.identityFile, "~/.ssh/id_web");
assert.equal(webHost.strictHostKeyChecking, "no");
// 记录里自己填了的以记录为准，config 不能盖掉
const ownHost = resolveSshHost(
	{ name: "own", host: "web", port: 2201, user: "me", strictHostKeyChecking: "yes" },
	sshConfigPath,
);
assert.equal(ownHost.port, 2201);
assert.equal(ownHost.user, "me");
assert.equal(ownHost.strictHostKeyChecking, "yes");
// config 里的 ProxyJump 会进到记录里，页面上的跳板机优先
assert.equal(
	resolveSshHost({ name: "l", host: "a.lab" }, sshConfigPath).proxyJump,
	"ops@bastion:22022",
);
assert.equal(
	resolveSshHost({ name: "l", host: "a.lab", proxyJump: "mine" }, sshConfigPath)
		.proxyJump,
	"mine",
);
// 不认识的别名原样保留，只吃到 Host * 的默认
const plainHost = resolveSshHost({ name: "p", host: "1.2.3.4" }, sshConfigPath);
assert.equal(plainHost.host, "1.2.3.4");
assert.equal(plainHost.port, 22);
// 跳板链进连接池的键：经不同跳板过去算两条连接，none 和不填一样
assert.notEqual(poolKey({ ...host, proxyJump: "bastion" }), poolKey(host));
assert.equal(
	poolKey({ ...host, proxyJump: "none" }),
	poolKey({ ...host, proxyJump: "" }),
);

// 目录递归：只收普通文件，符号链接跳过，排序稳定
{
	const root = mkdtempSync(join(tmpdir(), "magpie-tree-"));
	mkdirSync(join(root, "sub", "deep"), { recursive: true });
	writeFileSync(join(root, "a.txt"), "aaa");
	writeFileSync(join(root, "sub", "b.bin"), Buffer.alloc(10));
	writeFileSync(join(root, "sub", "deep", "c.txt"), "c");
	let linkMade = false;
	try {
		symlinkSync(join(root, "a.txt"), join(root, "link.txt"));
		linkMade = true;
	} catch {
		// Windows 上没权限建符号链接：这条断言就不跑
	}
	const { files, links } = walkLocalTree(root);
	assert.deepEqual(
		files.map((file) => [file.rel, file.size]),
		[
			["a.txt", 3],
			["sub/b.bin", 10],
			["sub/deep/c.txt", 1],
		],
	);
	assert.deepEqual(links, linkMade ? ["link.txt"] : []);
	rmSync(root, { recursive: true, force: true });
}

// 远端目录收集：用假的 sftp 回目录列表，特殊文件跳过
{
	const attrs = (kind, size = 0) => ({
		size,
		isFile: () => kind === "file",
		isDirectory: () => kind === "dir",
		isSymbolicLink: () => kind === "link",
	});
	const listing = {
		"/root": [
			{ filename: ".", attrs: attrs("dir") },
			{ filename: "..", attrs: attrs("dir") },
			{ filename: "one.txt", attrs: attrs("file", 5) },
			{ filename: "sub", attrs: attrs("dir") },
			{ filename: "jump", attrs: attrs("link") },
			{ filename: "fifo", attrs: attrs("other") },
		],
		"/root/sub": [{ filename: "two.txt", attrs: attrs("file", 7) }],
	};
	const fakeSftp = {
		readdir(dir, cb) {
			cb(null, listing[dir] ?? []);
		},
	};
	const { files, links } = await collectRemoteTree(fakeSftp, "/root");
	assert.deepEqual(files, [
		{ rel: "one.txt", size: 5 },
		{ rel: "sub/two.txt", size: 7 },
	]);
	assert.deepEqual(links, ["jump"]);
}

console.log("smoke ok");
