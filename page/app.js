// 页面只能改插件自己的 options（沙箱里没有 fetch），主机就存在这里。
const $ = (id) => document.getElementById(id);
const fields = {
	name: $("f-name"),
	host: $("f-host"),
	port: $("f-port"),
	user: $("f-user"),
	password: $("f-pw"),
	identityFile: $("f-key"),
	strictHostKeyChecking: $("f-strict"),
	note: $("f-note"),
};

let hosts = [];
let editingId = null;
let armedDelete = null;

const newId = () =>
	`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function flash(message, bad) {
	const status = $("status");
	status.textContent = message;
	status.classList.toggle("bad", Boolean(bad));
	clearTimeout(flash.timer);
	flash.timer = setTimeout(() => {
		status.textContent = "";
		status.classList.remove("bad");
	}, 4000);
}

function readForm() {
	const draft = {
		name: fields.name.value.trim(),
		host: fields.host.value.trim(),
		port: Number(fields.port.value) || 22,
		user: fields.user.value.trim(),
		identityFile: fields.identityFile.value.trim(),
		strictHostKeyChecking: fields.strictHostKeyChecking.value,
		password: fields.password.value,
		note: fields.note.value.trim(),
	};
	if (!draft.identityFile) delete draft.identityFile;
	if (!draft.password) delete draft.password;
	if (!draft.strictHostKeyChecking) delete draft.strictHostKeyChecking;
	if (!draft.user) delete draft.user;
	if (!draft.note) delete draft.note;
	return draft;
}

function fillForm(host) {
	fields.name.value = host ? host.name : "";
	fields.host.value = host ? host.host : "";
	fields.port.value = host ? host.port || 22 : "";
	fields.user.value = host ? host.user || "" : "";
	fields.identityFile.value = host ? host.identityFile || "" : "";
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
		const auth = host.password ? "  密码" : host.identityFile ? "  私钥" : "";
		where.textContent = target + auth;
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

async function main() {
	await magpie.ready;
	const options = await magpie.options.get();
	hosts = Array.isArray(options?.hosts) ? options.hosts : [];
	render();
}

main();
