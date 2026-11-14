// 只测纯逻辑：读 plugins.json、拼命令行、工具在坏参数下回文本而不抛。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MagpieSsh, pickHost, readHosts, scpArgs, sshArgs } from "../index.mjs";

const home = mkdtempSync(join(tmpdir(), "magpie-ssh-"));
process.env.XDG_CONFIG_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;

const writePlugins = (plugins) => {
	const dir = join(home, "magpie");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "plugins.json"), JSON.stringify({ plugins }));
};

const host = {
	id: "a1",
	name: "prod",
	host: "10.0.0.5",
	port: 2222,
	user: "root",
	identityFile: "~/.ssh/id_ed25519",
	strictHostKeyChecking: "accept-new",
};

// 没有 plugins.json
assert.deepEqual(readHosts(null), []);

// 按 spec 匹配，同一个插件出现两次时只认存了主机的那个
writePlugins([
	{ spec: "magpie-ssh" },
	{ spec: "magpie-ssh@0.1.0", options: { hosts: [host] } },
]);
assert.equal(readHosts(null)[0].name, "prod");

// spec 认不出时按 options 形状兜底（git、文件夹路径的写法）
writePlugins([
	{ spec: "github:someone/ssh-thing", options: { hosts: [host] } },
]);
assert.equal(readHosts(null).length, 1);

// 文件里没有时用宿主给的 options 快照
assert.equal(readHosts({ hosts: [host] }).length, 1);

// 命令行：目标在命令前面，端口不是 22 才带 -p，私钥展开 ~
assert.deepEqual(sshArgs(host, ["uname -a"]), [
	"-T",
	"-o",
	"BatchMode=yes",
	"-o",
	"ConnectTimeout=10",
	"-p",
	"2222",
	"-i",
	join(home, ".ssh/id_ed25519"),
	"-o",
	"StrictHostKeyChecking=accept-new",
	"root@10.0.0.5",
	"uname -a",
]);
assert.deepEqual(sshArgs({ name: "x", host: "h" }, ["ls"]), [
	"-T",
	"-o",
	"BatchMode=yes",
	"-o",
	"ConnectTimeout=10",
	"h",
	"ls",
]);

// scp：上传在前、下载在后，端口用 -P
const put = scpArgs(host, "/tmp/a", "/srv/a", "put");
assert.deepEqual(put.slice(-2), ["/tmp/a", "root@10.0.0.5:/srv/a"]);
assert.ok(put.includes("-P"));
assert.deepEqual(scpArgs(host, "/tmp/b", "/srv/b", "get").slice(-2), [
	"root@10.0.0.5:/srv/b",
	"/tmp/b",
]);

// 找主机：按名称、按主机名；找不到时给出原因
assert.equal(pickHost([host], "prod").host.id, "a1");
assert.equal(pickHost([host], "10.0.0.5").host.id, "a1");
assert.match(
	pickHost([host], "nope").error,
	/没有叫 nope 的主机。已配置：prod/,
);
assert.match(pickHost([], "nope").error, /还没有配置 SSH 主机/);

// 工具装载：四个工具都在，坏参数回文本（magpie 加载时就这么探一次，抛异常会整个插件失败）
const plugin = await MagpieSsh({}, { hosts: [host] });
assert.deepEqual(Object.keys(plugin.tool).sort(), [
	"get",
	"hosts",
	"put",
	"run",
]);
assert.match(
	await plugin.tool.hosts.execute(),
	/- prod {2}root@10\.0\.0\.5:2222/,
);
assert.match(await plugin.tool.run.execute({}), /没有叫 undefined 的主机/);

writePlugins([]);
const bare = await MagpieSsh({}, null);
assert.match(
	await bare.tool.run.execute({ host: "prod", command: "ls" }),
	/还没有配置 SSH 主机/,
);
assert.match(await bare.tool.put.execute({}), /还没有配置 SSH 主机/);
assert.match(await bare.tool.get.execute({}), /还没有配置 SSH 主机/);

console.log("smoke ok");
