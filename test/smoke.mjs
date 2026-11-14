// 只测纯逻辑：读 plugins.json、连接配置、known_hosts 指纹判断、工具在坏参数下回文本而不抛。
// 真连接不在这里测（要真主机和凭据）。
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	audit,
	auditFile,
	connectConfig,
	fingerprint,
	hostIds,
	keyType,
	makeSink,
	pickHost,
	pickHosts,
	readHosts,
	remotePath,
	render,
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

// 按 spec 匹配，同一个插件出现两次时只认存了主机的那个
writePlugins([
	{ spec: "magpie-ssh", options: {} },
	{ spec: "C:\\some\\other\\place", options: { hosts: [host] } },
]);
assert.equal(readHosts(null)[0].name, "prod");

// spec 认不出时按 options 形状兜底（git、文件夹路径的写法）
writePlugins([{ spec: "some-fork", options: { hosts: [host] } }]);
assert.equal(readHosts(null).length, 1);

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
assert.equal(keyed.password, undefined);
process.env.SSH_AUTH_SOCK = "\\\\pipe\\test-agent";
const agented = connectConfig({ name: "a", host: "h" });
assert.equal(agented.agent, "\\\\pipe\\test-agent");
assert.equal(agented.password, undefined);

// known_hosts：accept-new 落盘、yes 拒未知、指纹变了拒
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
assert.equal(verifyHostKey(unknown, blob, "accept-new", known).ok, true);
assert.equal(verifyHostKey(unknown, blob, "accept-new", known).ok, true);
assert.equal(
	verifyHostKey(unknown, blob, "accept-new", known).ok,
	true,
	"第二次应该命中 known_hosts",
);

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

// @revoked 必须拒绝；@cert-authority 认识不了，跳过而不是当噪音命中
const markerFile = join(home, "known_markers");
writeFileSync(
	markerFile,
	`@revoked 10.0.0.5 ssh-ed25519 ${blob.toString("base64")}\n@cert-authority *.lan ssh-ed25519 AAAA\n`,
);
const revoked = verifyHostKey(
	{ host: "10.0.0.5" },
	blob,
	"accept-new",
	markerFile,
);
assert.equal(revoked.ok, false);
assert.match(revoked.error, /@revoked/);
assert.equal(
	verifyHostKey({ host: "10.0.0.5" }, blob, "yes", markerFile).ok,
	false,
);

// SFTP 不认 ~：客户端要自己按远端 home 展开，run 里的 ~ 由远端 shell 展开
assert.equal(remotePath("~/a/b", "/home/pi"), "/home/pi/a/b");
assert.equal(remotePath("~/a", "/home/pi/"), "/home/pi/a");
assert.equal(remotePath("/etc/passwd", "/home/pi"), "/etc/passwd");
assert.equal(remotePath("rel.txt", "/home/pi"), "rel.txt");
assert.equal(remotePath("~/a", null), "~/a");

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
console.log("smoke ok");
