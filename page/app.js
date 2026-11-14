// 页面只能改插件自己的 options（沙箱里没有 fetch），主机就存在这里。
const $ = (id) => document.getElementById(id);
const fields = {
	name: $("f-name"),
	host: $("f-host"),
	port: $("f-port"),
	user: $("f-user"),
	proxyJump: $("f-jump"),
	password: $("f-pw"),
	identityFile: $("f-key"),
	passphrase: $("f-pass"),
	strictHostKeyChecking: $("f-strict"),
	note: $("f-note"),
};

let hosts = [];
let editingId = null;
let armedDelete = null;

const newId = () =>
	`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function flashInto(element, message, bad) {
	element.textContent = message;
	element.classList.toggle("bad", Boolean(bad));
	clearTimeout(element.timer);
	element.timer = setTimeout(() => {
		element.textContent = "";
		element.classList.remove("bad");
	}, 4000);
}

function flash(message, bad) {
	flashInto($("status"), message, bad);
}

function readForm() {
	const draft = {
		name: fields.name.value.trim(),
		host: fields.host.value.trim(),
		port: Number(fields.port.value) || 22,
		user: fields.user.value.trim(),
		proxyJump: fields.proxyJump.value.trim(),
		identityFile: fields.identityFile.value.trim(),
		passphrase: fields.passphrase.value,
		strictHostKeyChecking: fields.strictHostKeyChecking.value,
		password: fields.password.value,
		note: fields.note.value.trim(),
	};
	if (!draft.identityFile) delete draft.identityFile;
	// 口令只在有私钥时才有意义：密码认证和 agent 用不上它
	if (!draft.identityFile || !draft.passphrase) delete draft.passphrase;
	if (!draft.password) delete draft.password;
	if (!draft.strictHostKeyChecking) delete draft.strictHostKeyChecking;
	if (!draft.user) delete draft.user;
	if (!draft.proxyJump) delete draft.proxyJump;
	if (!draft.note) delete draft.note;
	return draft;
}

function fillForm(host) {
	fields.name.value = host ? host.name : "";
	fields.host.value = host ? host.host : "";
	fields.port.value = host ? host.port || 22 : "";
	fields.user.value = host ? host.user || "" : "";
	fields.proxyJump.value = host ? host.proxyJump || "" : "";
	fields.identityFile.value = host ? host.identityFile || "" : "";
	fields.passphrase.value = host ? host.passphrase || "" : "";
	fields.password.value = host ? host.password || "" : "";
	// 老记录没有这个字段：插件按 accept-new 处理，页面也得选在 accept-new 上
	const strict = host ? host.strictHostKeyChecking : "accept-new";
	fields.strictHostKeyChecking.value =
		strict === "yes" || strict === "no" ? strict : "accept-new";
	fields.note.value = host ? host.note || "" : "";
}

async function persist(next) {
	try {
		const current = (await magpie.options.get()) || {};
		const saved = await magpie.options.set({ ...current, hosts: next });
		hosts = Array.isArray(saved?.hosts) ? saved.hosts : next;
		render();
		return true;
	} catch (error) {
		// 选项每秒只能写一次；失败必须说出来，否则点了按钮像没反应
		flash(`没存下来：${error?.message ?? error}`, true);
		return false;
	}
}

function render() {
	const list = $("list");
	list.replaceChildren();
	$("empty").hidden = hosts.length > 0;
	for (const host of hosts) {
		const row = document.createElement("li");
		const main = document.createElement("div");
		main.className = "row-main";
		const target = `${host.user ? `${host.user}@` : ""}${host.host}:${host.port || 22}`;

		const name = document.createElement("strong");
		name.textContent = host.name;
		const where = document.createElement("code");
		const auth = host.password
			? "  密码"
			: host.identityFile
				? host.passphrase
					? "  私钥+口令"
					: "  私钥"
				: "";
		where.textContent =
			target + auth + (host.proxyJump ? `  经 ${host.proxyJump}` : "");
		main.append(name, where);
		if (host.note) {
			const note = document.createElement("span");
			note.className = "note";
			note.textContent = host.note;
			main.append(note);
		}

		const buttons = document.createElement("div");
		buttons.className = "row-actions";

		const edit = document.createElement("button");
		edit.type = "button";
		edit.textContent = "编辑";
		edit.addEventListener("click", () => {
			editingId = host.id;
			fillForm(host);
			$("submit").textContent = "保存修改";
			$("cancel").hidden = false;
			fields.name.focus();
		});

		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "danger";
		remove.textContent = "删除";
		remove.addEventListener("click", async () => {
			if (armedDelete !== host.id) {
				armedDelete = host.id;
				remove.textContent = "再点一次";
				setTimeout(() => {
					if (armedDelete === host.id) {
						armedDelete = null;
						remove.textContent = "删除";
					}
				}, 4000);
				return;
			}
			armedDelete = null;
			if (editingId === host.id) stopEditing();
			if (await persist(hosts.filter((item) => item.id !== host.id)))
				flash("已删除");
		});

		buttons.append(edit, remove);
		row.append(main, buttons);
		list.append(row);
	}
}

function stopEditing() {
	editingId = null;
	fillForm(null);
	$("submit").textContent = "添加";
	$("cancel").hidden = true;
}

$("form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const draft = readForm();
	if (!draft.name || !draft.host) return flash("名称和主机必填", true);
	// 名字要按大小写不敏感查重：agent 传 host 名时也是不敏感的
	const duplicate = hosts.find(
		(item) =>
			item.name.toLowerCase() === draft.name.toLowerCase() &&
			item.id !== editingId,
	);
	if (duplicate) return flash("这个名称已经有了", true);
	// 编辑的那个可能刚被删掉：那就当新增，别假装保存成功
	const target = editingId && hosts.some((item) => item.id === editingId);
	const next = target
		? hosts.map((item) =>
				item.id === editingId ? { ...draft, id: editingId } : item,
			)
		: [...hosts, { ...draft, id: newId() }];
	$("submit").disabled = true;
	try {
		if (await persist(next)) {
			flash(target ? "已保存" : "已添加");
			stopEditing();
		}
	} finally {
		$("submit").disabled = false;
	}
});

$("cancel").addEventListener("click", stopEditing);

// 导出 / 导入：沙箱里写不了文件、读不到剪贴板，就用一个文本框当中转站。
// magpie plugin rm 会把设置一起删掉，删之前先导一份出来。
// 导出的字段里不放 id：它是这份设置内部的身份，带出去再导回来只会撞车。
// 按名称合并时，覆盖的沿用原来的 id，新增的现生成。
const HOST_FIELDS = [
	"name",
	"host",
	"port",
	"user",
	"password",
	"identityFile",
	"passphrase",
	"proxyJump",
	"strictHostKeyChecking",
	"note",
];

const knownFields = (item) => {
	const host = {};
	for (const key of HOST_FIELDS)
		if (item[key] !== undefined && item[key] !== "") host[key] = item[key];
	return host;
};

const looksLikeHost = (item) =>
	Boolean(item) &&
	typeof item === "object" &&
	!Array.isArray(item) &&
	typeof item.name === "string" &&
	item.name.trim().length > 0 &&
	typeof item.host === "string" &&
	item.host.trim().length > 0;

$("export").addEventListener("click", () => {
	$("io").value = JSON.stringify(hosts.map(knownFields), null, 2);
	flashInto($("io-status"), `已导出 ${hosts.length} 台`);
});

$("import").addEventListener("click", async () => {
	const status = $("io-status");
	let parsed;
	try {
		parsed = JSON.parse($("io").value);
	} catch (error) {
		flashInto(status, `不是合法 JSON：${error.message}`, true);
		return;
	}
	if (!Array.isArray(parsed)) {
		flashInto(status, "要一个数组，形如 [{name, host, …}, …]", true);
		return;
	}
	const usable = parsed.filter(looksLikeHost).map(knownFields);
	const skipped = parsed.length - usable.length;
	if (!usable.length) {
		flashInto(status, "没有能认出来的主机：每条至少要有 name 和 host", true);
		return;
	}
	// 按名称合并：同名的覆盖（沿用原来的 id），其余的追加
	const merged = new Map(hosts.map((item) => [item.name.toLowerCase(), item]));
	let added = 0;
	let updated = 0;
	for (const host of usable) {
		const key = host.name.toLowerCase();
		const existing = merged.get(key);
		if (existing) {
			merged.set(key, { ...host, id: existing.id });
			updated += 1;
		} else {
			merged.set(key, { ...host, id: newId() });
			added += 1;
		}
	}
	if (await persist([...merged.values()])) {
		$("io").value = "";
		flashInto(
			status,
			`导入完成：新增 ${added} 台，更新 ${updated} 台${skipped ? `，跳过 ${skipped} 条认不出的` : ""}`,
		);
	}
});

async function main() {
	await magpie.ready;
	const options = await magpie.options.get();
	hosts = Array.isArray(options?.hosts) ? options.hosts : [];
	render();
}

main();
