// 端到端：进程内 ssh2 服务端提供 session/exec，用真的 SSH 连接跑 run。
// 服务端不是真 shell：按命令名回放固定行为，专门喂 execOnce / render / execBatch 的边界。
// 纯逻辑部分在 smoke.mjs，文件在 e2e.mjs；这个文件只管命令执行那条路。
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";
import {
	closeAllConnections,
	execBatch,
	execRemote,
	poolStats,
	reach,
} from "../lib.mjs";
import { MagpieSsh } from "../index.mjs";

const { Server } = ssh2;

const WATCHDOG_MS = 60_000;
const watchdog = setTimeout(() => {
	console.error(`e2e-run 超时：${WATCHDOG_MS} 毫秒内没跑完`);
	process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

// 测试自己的家目录：known_hosts、plugins.json、审计日志都落在临时目录里
const home = mkdtempSync(join(tmpdir(), "magpie-e2e-run-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = home;
mkdirSync(join(home, ".ssh"), { recursive: true });
mkdirSync(join(home, "magpie"), { recursive: true });
writeFileSync(
	join(home, "magpie", "plugins.json"),
	JSON.stringify({ plugins: [] }),
);

const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
	type: "pkcs1",
	format: "pem",
});

// 脚本化 shell：命令名决定行为，参数只给 echo 用
const handleCommand = (stream, raw, options = {}) => {
	const command = String(raw).trim();
	const failWith = (code) => {
		stream.exit(code);
		stream.end();
	};

	if (command.startsWith("echo ")) {
		stream.write(`${command.slice(5)}\n`);
		return failWith(0);
	}
	if (command === "false") return failWith(options.lenient ? 0 : 1);
	if (command.startsWith("exit ")) return failWith(Number(command.slice(5)) || 0);
	if (command === "emit") {
		// 隔开写：SSH 把 stdout / stderr 放在两个流里，各自的缓冲不保证同一瞬间的先后；
		// 隔开之后到达顺序就稳定，客户端拼出来的段序才能断言
		stream.write("out1\n");
		setTimeout(() => {
			stream.stderr.write("err1\n");
			setTimeout(() => {
				stream.write("out2\n");
				failWith(0);
			}, 20);
		}, 20);
		return;
	}
	if (command === "big") {
		// 超过 4MB 收集上限：客户端只丢内容，不掐命令
		const chunk = Buffer.alloc(64 * 1024, "x");
		let sent = 0;
		const pump = () => {
			while (sent < 4.5 * 1024 * 1024) {
				sent += chunk.length;
				if (!stream.write(chunk)) return stream.once("drain", pump);
			}
			failWith(0);
		};
		pump();
		return;
	}
	if (command.startsWith("sleep ")) {
		const ms = Number(command.slice(6)) || 0;
		const timer = setTimeout(() => failWith(0), ms);
		stream.on("close", () => clearTimeout(timer));
		return;
	}
	if (command === "hang") {
		// 什么都不发：留给客户端超时/取消
		return;
	}
	if (command === "killed") {
		// 被信号杀死：没有退出码，客户端不能当成 exit 0
		stream.exit("TERM", false, "Terminated");
		stream.end();
		return;
	}
	if (command === "dropped") {
		// 没给退出码就把通道关了：同样不能当成功
		stream.end();
		return;
	}
	stream.stderr.write(`unknown command: ${command}\n`);
	failWith(127);
};

const startServer = (options = {}) =>
	new Promise((resolve) => {
		const server = new Server({ hostKeys: [hostKey] }, (client) => {
			client.on("authentication", (ctx) => {
				if (ctx.method === "password" && ctx.password === "pw") ctx.accept();
				else ctx.reject(["password"]);
			});
			client.on("ready", () => {
				client.on("session", (accept) => {
					const session = accept();
					session.on("exec", (acceptExec, _rejectExec, info) => {
						const stream = acceptExec();
						handleCommand(stream, info.command, options);
					});
				});
			});
		});
		server.listen(0, "127.0.0.1", () =>
			resolve({ server, port: server.address().port }),
		);
	});

const { server, port } = await startServer();
// 第二台：`false` 也回 0，用来验证批量汇总里成功/失败是按主机分的
const { server: lenientServer, port: lenientPort } = await startServer({ lenient: true });

const makeHost = (name, port) => ({
	name,
	host: "127.0.0.1",
	port,
	user: "tester",
	password: "pw",
	strictHostKeyChecking: "no",
});

const host = makeHost("e2e-run", port);

const expectExit = (text, code) => {
	assert.match(text, new RegExp(`^exit ${code}(\\n|$)`), `退出码不符：${text}`);
	return text;
};

// 1. 普通命令：退出码 0，stdout 原样
{
	const text = expectExit(await execRemote(host, "echo hello"), 0);
	assert.equal(text, "exit 0\nhello");
}

// 2. 非 0 退出码要原样透出
assert.equal(expectExit(await execRemote(host, "false"), 1), "exit 1");
assert.equal(expectExit(await execRemote(host, "exit 42"), 42), "exit 42");

// 3. stdout / stderr 交错：隔开写的两路按到达顺序拼，stderr 就地标记
{
	const text = expectExit(await execRemote(host, "emit"), 0);
	assert.equal(text, "exit 0\nout1\n[stderr] err1\nout2");
}

// 4. 输出超过 4MB：只丢内容、不掐命令，并在退出码下面注明
{
	const text = expectExit(await execRemote(host, "big"), 0);
	assert.match(text, /\[输出超过 4MB，已丢弃后续内容，命令继续执行\]/);
}

// 5. maxChars 截断：留得住第一行，末尾有截断说明
// clampChars 的下限是 200，所以用 300 个字符去撞它
{
	const text = expectExit(
		await execRemote(host, `echo ${"a".repeat(300)}`, { maxChars: 200 }),
		0,
	);
	assert.match(text, /…（已截断，全文 \d+ 字符）/);
	assert.ok(text.length < 260, `截断后仍然太长：${text.length}`);
}

// 6. 超时：回 exit -1 并写明是超时，不能冒充成功
{
	const started = Date.now();
	const text = await execRemote(host, "hang", { timeoutMs: 300 });
	assert.match(text, /^exit -1/);
	assert.match(text, /已超时/);
	assert.ok(Date.now() - started < 5000, "超时后还卡着");
}

// 7. 取消：和超时、成功三者分开报
{
	const controller = new AbortController();
	const pending = execRemote(host, "hang", { signal: controller.signal });
	setTimeout(() => controller.abort(), 100);
	const text = await pending;
	assert.match(text, /^exit -1/);
	assert.match(text, /调用被取消/);
}

// 8. 被信号杀死 / 没拿到退出码就断线：都不能冒充成功
{
	const killed = await execRemote(host, "killed");
	assert.match(killed, /^exit -1/);
	assert.match(killed, /被信号中断（SIGTERM）/);

	const dropped = await execRemote(host, "dropped");
	assert.match(dropped, /^exit -1/);
	assert.match(dropped, /连接在拿到退出码之前断开了/);
}

// 9. 批量：两台主机，一台成功一台失败，末尾按主机汇总
{
	const lenient = makeHost("e2e-lenient", lenientPort);
	const text = await execBatch([host, lenient], "false", { timeoutMs: 8000 });
	assert.match(text, /^== e2e-run \(tester@127\.0\.0\.1:\d+\) ==\nexit 1/);
	assert.match(text, /^== e2e-lenient \(tester@127\.0\.0\.1:\d+\) ==\nexit 0/m);
	assert.match(text, /总计 1\/2 成功，失败：e2e-run\(exit 1\)$/m);
}

// 10. reach：只握手，带上服务器指纹和耗时
{
	const text = expectExit(await reach(host), 0);
	assert.match(text, /e2e-run\s+\d+ 毫秒\s+ssh-rsa SHA256:[A-Za-z0-9+/]+$/);
}

// 11. 工具层：index.mjs 的 run 接上真连接，且审计日志落一行
{
	const plugin = await MagpieSsh(
		{},
		{ hosts: [host], auditLog: true },
	);
	const text = await plugin.tool.run.execute({ host: "e2e-run", command: "echo via-tool" });
	assert.equal(expectExit(text, 0), "exit 0\nvia-tool");
	const logged = readFileSync(join(home, "magpie", "magpie-ssh-audit.log"), "utf8")
		.trim()
		.split("\n");
	assert.equal(logged.length, 1);
	const record = JSON.parse(logged[0]);
	assert.equal(record.tool, "run");
	assert.equal(record.command, "echo via-tool");
	assert.deepEqual(record.hosts, ["e2e-run"]);
}

// 12. 连接复用：第二次调用不再握手；超时把连接作废，池里不留半死连接
{
	closeAllConnections();
	expectExit(await execRemote(host, "echo first"), 0);
	assert.equal(poolStats().length, 1, "第一次调用后应该有一条复用连接");
	expectExit(await execRemote(host, "echo second"), 0);
	assert.equal(poolStats().length, 1, "第二次调用不该再开一条");
	assert.equal(poolStats()[0].busy, 0);

	await execRemote(host, "hang", { timeoutMs: 300 });
	assert.equal(poolStats().length, 0, "超时后那条连接应该被作废");
	// 作废之后还能重新连上
	expectExit(await execRemote(host, "echo after-timeout"), 0);
}

closeAllConnections();
server.close();
lenientServer.close();
clearTimeout(watchdog);
console.log("e2e-run ok");
