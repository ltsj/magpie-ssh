// 端到端：起一个进程内的 ssh2 SFTP 服务端（映射到临时目录），用真的 SSH 连接跑 put/get。
// 这里验证的是「真连接上递归传输到底对不对」，纯逻辑部分在 smoke.mjs。
// 不需要外部主机，CI 里跑得动；跑不出结果就 60 秒超时失败，别让 CI 挂着。
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import ssh2 from "ssh2";
import { closeAllConnections, transferRemote } from "../lib.mjs";

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;
// SFTP 的 ATTRS 里 mode 的高 4 位是文件类型；ssh2 没导出这组常量
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

const WATCHDOG_MS = 60_000;
const watchdog = setTimeout(() => {
	console.error(`e2e 超时：${WATCHDOG_MS} 毫秒内没跑完`);
	process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

// 测试自己的家目录：known_hosts、~/.ssh、plugins.json 都别碰真的
const home = mkdtempSync(join(tmpdir(), "magpie-e2e-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = home;
mkdirSync(join(home, ".ssh"), { recursive: true });
mkdirSync(join(home, "magpie"), { recursive: true });
writeFileSync(join(home, ".ssh", "id_ed25519"), "私钥内容不该被传出去");
writeFileSync(join(home, "magpie", "plugins.json"), JSON.stringify({ plugins: [] }));

const root = mkdtempSync(join(tmpdir(), "magpie-e2e-srv-"));
const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
	type: "pkcs1",
	format: "pem",
});

// 远端路径 → 磁盘路径：/a/b 落在 root/a/b，挡掉 .. 穿越
const diskOf = (path) => {
	const rel = posix.normalize(`/${path}`).replace(/^\/+/, "");
	return join(root, ...rel.split("/").filter(Boolean));
};

const modeOf = (stat) =>
	(stat.isDirectory() ? S_IFDIR : S_IFREG) | (stat.isDirectory() ? 0o755 : 0o644);

const attrsOf = (stat) => ({
	mode: modeOf(stat),
	uid: 0,
	gid: 0,
	size: stat.isDirectory() ? 0 : stat.size,
	atime: Math.floor(stat.atimeMs),
	mtime: Math.floor(stat.mtimeMs),
});

const status = (sftp, reqid, code) => sftp.status(reqid, code);
const NO_SUCH_FILE = STATUS_CODE.NO_SUCH_FILE;

const startServer = () =>
	new Promise((resolve) => {
		const server = new Server({ hostKeys: [hostKey] }, (client) => {
			client.on("authentication", (ctx) => {
				if (ctx.method === "password" && ctx.password === "pw") ctx.accept();
				else ctx.reject(["password"]);
			});
			client.on("ready", () => {
				client.on("session", (accept) => {
					const session = accept();
					session.on("sftp", (acceptSftp) => {
						const sftp = acceptSftp();
						const handles = new Map();
						let nextHandle = 1;
						const makeHandle = (state) => {
							const handle = Buffer.alloc(4);
							handle.writeUInt32BE(nextHandle, 0);
							handles.set(nextHandle, state);
							nextHandle += 1;
							return handle;
						};
						const byHandle = (handle) =>
							handle.length === 4 ? handles.get(handle.readUInt32BE(0)) : undefined;

						const statOf = (reqid, path, follow) => {
							const disk = diskOf(path);
							(follow ? fs.stat : fs.lstat)(disk, (error, stat) => {
								if (error) return status(sftp, reqid, NO_SUCH_FILE);
								sftp.attrs(reqid, attrsOf(stat));
							});
						};

						sftp
							.on("OPEN", (reqid, filename, flags) => {
								const disk = diskOf(filename);
								const wantsWrite = Boolean(flags & OPEN_MODE.WRITE);
								if (wantsWrite) {
									// 客户端 fastPut 先建文件再写，这里不能要求文件已经存在
									return fs.open(disk, "w", (openError, fd) => {
										if (openError) return status(sftp, reqid, NO_SUCH_FILE);
										fs.fstat(fd, (_error, stat) =>
											sftp.handle(reqid, makeHandle({ fd, stat })),
										);
									});
								}
								// 读：目录也算「打开」，READDIR 走同一个 handle
								fs.stat(disk, (error, stat) => {
									if (error) return status(sftp, reqid, NO_SUCH_FILE);
									if (stat.isDirectory()) {
										return sftp.handle(reqid, makeHandle({ dir: disk, stat }));
									}
									fs.open(disk, "r", (openError, fd) => {
										if (openError) return status(sftp, reqid, NO_SUCH_FILE);
										sftp.handle(reqid, makeHandle({ fd, stat }));
									});
								});
							})
							.on("READ", (reqid, handle, offset, length) => {
								const state = byHandle(handle);
								if (!state || state.fd === undefined)
									return status(sftp, reqid, STATUS_CODE.FAILURE);
								const buffer = Buffer.alloc(length);
								fs.read(state.fd, buffer, 0, length, offset, (error, bytes) => {
									if (error) return status(sftp, reqid, STATUS_CODE.FAILURE);
									if (!bytes) return status(sftp, reqid, STATUS_CODE.EOF);
									sftp.data(reqid, buffer.subarray(0, bytes));
								});
							})
							.on("WRITE", (reqid, handle, offset, data) => {
								const state = byHandle(handle);
								if (!state || state.fd === undefined)
									return status(sftp, reqid, STATUS_CODE.FAILURE);
								fs.write(state.fd, data, 0, data.length, offset, (error) =>
									status(sftp, reqid, error ? STATUS_CODE.FAILURE : STATUS_CODE.OK),
								);
							})
							.on("CLOSE", (reqid, handle) => {
								const state = byHandle(handle);
								handles.delete(handle.readUInt32BE(0));
								if (!state || state.fd === undefined)
									return status(sftp, reqid, STATUS_CODE.OK);
								fs.close(state.fd, () => status(sftp, reqid, STATUS_CODE.OK));
							})
							.on("FSTAT", (reqid, handle) => {
								const state = byHandle(handle);
								if (!state) return status(sftp, reqid, STATUS_CODE.FAILURE);
								if (state.fd === undefined)
									return sftp.attrs(reqid, attrsOf(state.stat));
								fs.fstat(state.fd, (error, stat) =>
									error
										? status(sftp, reqid, STATUS_CODE.FAILURE)
										: sftp.attrs(reqid, attrsOf(stat)),
								);
							})
							.on("STAT", (reqid, path) => statOf(reqid, path, true))
							.on("LSTAT", (reqid, path) => statOf(reqid, path, false))
							.on("REALPATH", (reqid, path) => {
								const wanted = path && path !== "." ? posix.normalize(path) : "/";
								sftp.name(reqid, [
									{
										filename: wanted.startsWith("/") ? wanted : `/${wanted}`,
										longname: wanted,
										attrs: {},
									},
								]);
							})
							// 客户端用路径 readdir 时走的是 OPENDIR，不是 OPEN
							.on("OPENDIR", (reqid, path) => {
								const disk = diskOf(path);
								fs.stat(disk, (error, stat) => {
									if (error || !stat.isDirectory())
										return status(sftp, reqid, NO_SUCH_FILE);
									sftp.handle(reqid, makeHandle({ dir: disk, stat }));
								});
							})
							.on("READDIR", (reqid, handle) => {
								const state = byHandle(handle);
								if (!state || !state.dir)
									return status(sftp, reqid, STATUS_CODE.FAILURE);
								if (state.done) return status(sftp, reqid, STATUS_CODE.EOF);
								state.done = true;
								fs.readdir(state.dir, { withFileTypes: true }, (error, entries) => {
									if (error) return status(sftp, reqid, STATUS_CODE.FAILURE);
									const list = entries.map((entry) => {
										let attrs = {};
										try {
											attrs = attrsOf(
												fs.lstatSync(join(state.dir, entry.name)),
											);
										} catch {
											// 列不出来就按空属性给，客户端会当成特殊文件跳过
										}
										return { filename: entry.name, longname: entry.name, attrs };
									});
									sftp.name(reqid, list);
								});
							})
							.on("MKDIR", (reqid, path) => {
								fs.mkdir(diskOf(path), (error) =>
									status(
										sftp,
										reqid,
										error && error.code !== "EEXIST"
											? STATUS_CODE.FAILURE
											: STATUS_CODE.OK,
									),
								);
							})
							.on("REMOVE", (reqid, path) => {
								fs.rm(diskOf(path), (error) =>
									status(sftp, reqid, error ? STATUS_CODE.FAILURE : STATUS_CODE.OK),
								);
							})
							.on("RMDIR", (reqid, path) => {
								fs.rmdir(diskOf(path), (error) =>
									status(sftp, reqid, error ? STATUS_CODE.FAILURE : STATUS_CODE.OK),
								);
							});
					});
				});
			});
		});
		server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
	});

const { server, port } = await startServer();

const host = {
	name: "e2e",
	host: "127.0.0.1",
	port,
	user: "tester",
	password: "pw",
	strictHostKeyChecking: "no",
};

const run = (direction, local, remote, extra = {}) =>
	transferRemote(host, local, remote, direction, { reuse: false, ...extra });

const expectOk = (text) => {
	assert.match(text, /^exit 0/, `期望成功，实际：${text}`);
	return text;
};

// 1. 单文件往返
{
	const local = join(home, "one.txt");
	writeFileSync(local, "hello e2e\n");
	expectOk(await run("put", local, "/one.txt"));
	assert.equal(readFileSync(join(root, "one.txt"), "utf8"), "hello e2e\n");
	expectOk(await run("get", join(home, "one-back.txt"), "/one.txt"));
	assert.equal(readFileSync(join(home, "one-back.txt"), "utf8"), "hello e2e\n");
}

// 2. 目录上传：嵌套目录、空目录、符号链接
{
	const src = join(home, "site");
	mkdirSync(join(src, "css", "deep"), { recursive: true });
	mkdirSync(join(src, "empty"), { recursive: true });
	writeFileSync(join(src, "index.html"), "<html>hi</html>");
	writeFileSync(join(src, "css", "app.css"), "body{color:red}");
	writeFileSync(join(src, "css", "deep", "x.css"), "x");
	let linked = false;
	try {
		symlinkSync(join(src, "index.html"), join(src, "link.html"));
		linked = true;
	} catch {
		// Windows 没权限建符号链接就跳过这条
	}
	const text = expectOk(await run("put", src, "/site"));
	assert.equal(readFileSync(join(root, "site", "index.html"), "utf8"), "<html>hi</html>");
	assert.equal(
		readFileSync(join(root, "site", "css", "deep", "x.css"), "utf8"),
		"x",
	);
	assert.match(text, /上传 3\/3 个文件/);
	if (linked) {
		assert.match(text, /跳过 1 个符号链接/);
		assert.equal(fs.existsSync(join(root, "site", "link.html")), false);
	}
}

// 3. 目录下载回来，内容逐字节一致
{
	const local = join(home, "site-back");
	const text = expectOk(await run("get", local, "/site"));
	assert.equal(readFileSync(join(local, "index.html"), "utf8"), "<html>hi</html>");
	assert.equal(readFileSync(join(local, "css", "app.css"), "utf8"), "body{color:red}");
	assert.match(text, /下载 3\/3 个文件/);
}

// 4. 递归也护住凭据目录：put 一个装着 ~/.ssh 的上层目录，私钥不许被带走
{
	const text = expectOk(await run("put", home, "/home-copy"));
	assert.equal(fs.existsSync(join(root, "home-copy", ".ssh", "id_ed25519")), false);
	assert.match(text, /跳过 2 个在受保护目录/);
	assert.equal(fs.existsSync(join(root, "home-copy", "one.txt")), true);
}

// 5. 时间预算：一毫秒等于什么都不做，但仍然给一份「部分结果」而不是抛异常
{
	const text = await run("put", join(home, "site"), "/site-timeout", { timeoutMs: 1 });
	assert.match(text, /^exit -1/);
	assert.match(text, /时间预算用完/);
	assert.match(text, /上传 0\/3 个文件/);
}

// 6. 本机路径不存在时是文本报错，不是异常
{
	const text = await run("put", join(home, "nope-does-not-exist"), "/x");
	assert.match(text, /^exit -1/);
	assert.match(text, /本机路径读不到/);
}

// 7. 远端不存在的路径也是文本报错
{
	const text = await run("get", join(home, "nothing"), "/no-such-path");
	assert.match(text, /^exit -1/);
	assert.match(text, /No such file|no such file|ENOENT|SFTP/i);
}

closeAllConnections();
server.close();
clearTimeout(watchdog);
console.log("e2e ok");
