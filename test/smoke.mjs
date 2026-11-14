// 只测纯逻辑：读 plugins.json、连接配置、known_hosts 指纹判断、工具在坏参数下回文本而不抛。
// 真连接不在这里测（要真主机和凭据）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connectConfig,
	hostIds,
	keyType,
	pickHost,
	readHosts,
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
	"get",
	"hosts",
	"put",
	"run",
]);
assert.match(
	await plugin.tool.hosts.execute(),
	/- prod {2}root@10\.0\.0\.5:2222 {2}密码/,
);
assert.match(await plugin.tool.run.execute({}), /没有叫 undefined 的主机/);
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

console.log("smoke ok");
