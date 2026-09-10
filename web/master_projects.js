import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const MASTER = "MiniMaxH3MasterExtender";
const FINAL = "MiniMaxH3MasterFinalDecode";
const FORMAT = "minimax-h3-master-project";
const style = "background:#252538;color:#eee;border:1px solid #454560;border-radius:5px;padding:6px 10px;cursor:pointer";
const masters = () => app.graph._nodes.filter(n => n.type === MASTER);
const widget = (node, name) => node.widgets?.find(w => w.name === name);

function pictures(node) {
    const images = JSON.parse(widget(node, "refs_json").value || "{}").images || [];
    return Array.from({ length: 9 }, (_, i) => images[i] || null);
}

function imageURL(name) {
    const parts = name.replaceAll("\\", "/").split("/");
    return `/view?${new URLSearchParams({filename: parts.pop(), subfolder: parts.join("/"), type: "input"})}`;
}

async function responseJSON(response) {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
}

async function upload(file) {
    if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
    const form = new FormData();
    const extension = file.name.split(".").pop().replace(/[^a-zA-Z0-9]/g, "") || "png";
    form.append("image", file, `${crypto.randomUUID()}.${extension}`);
    form.append("type", "input");
    form.append("subfolder", "minimax_master");
    const result = await responseJSON(await api.fetchApi("/upload/image", {method: "POST", body: form}));
    return [result.subfolder, result.name].filter(Boolean).join("/");
}

function dataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read picture."));
        reader.readAsDataURL(blob);
    });
}

function pickFile(accept, action) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => { if (input.files[0]) action(input.files[0]); };
    input.click();
}

async function clearCache(extraOwners = [], extraFinals = []) {
    const owners = [...new Set([...masters().map(n => String(n.id)), ...extraOwners])];
    const final_ids = [...new Set([...app.graph._nodes.filter(n => n.type === FINAL).map(n => String(n.id)), ...extraFinals])];
    await responseJSON(await api.fetchApi("/minimax_master/clear_cache", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({owners, final_ids}),
    }));
}

function readProject(text) {
    const project = JSON.parse(text);
    if (project.format !== FORMAT || project.version !== 1 || !Array.isArray(project.workflow?.nodes) || !Array.isArray(project.masters)) {
        throw new Error("Choose a MiniMax Master project file saved with Save Project.");
    }
    const ids = new Set(project.workflow.nodes.filter(n => n.type === MASTER).map(n => String(n.id)));
    if (!ids.size || project.masters.length !== ids.size) throw new Error("Project is missing its Master settings.");
    for (const entry of project.masters) {
        if (!ids.delete(String(entry.id)) || !entry.settings || !Array.isArray(entry.images) || entry.images.length !== 9) {
            throw new Error("Invalid Master project data.");
        }
        const clips = JSON.parse(entry.settings.clips_json);
        if (!Array.isArray(clips)) throw new Error("Invalid clip list.");
        for (const clip of clips) {
            if (!clip || typeof clip.prompt !== "string" || !Number.isFinite(clip.duration) || clip.duration <= 0 || !Number.isSafeInteger(clip.seed) || clip.seed < 0) {
                throw new Error("Invalid clip settings in project.");
            }
        }
        for (const image of entry.images) {
            if (image !== null && (typeof image?.name !== "string" || !/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(image?.data))) {
                throw new Error("Project contains an invalid picture.");
            }
        }
    }
    return project;
}

export function createProjectControls(node, {getClips, setClips, save, render}) {
    let busy = false;
    let message = "Projects include pictures and the workflow settings; generated cache is separate.";
    const defaults = Object.fromEntries(node.widgets.filter(w => !["clips_json", "refs_json", "master_ui"].includes(w.name)).map(w => [w.name, structuredClone(w.value)]));

    function unvalidate() {
        for (const clip of getClips()) clip.validated = false;
        save();
    }

    async function run(action) {
        if (busy) return;
        busy = true;
        message = "Working…";
        render();
        try { await action(); }
        catch (error) { message = error.message; }
        finally { busy = false; render(); }
    }

    node.masterProjectReset = () => {
        for (const [name, value] of Object.entries(defaults)) {
            const w = widget(node, name);
            if (w) w.value = structuredClone(value);
        }
        // Disconnect legacy picture inputs as well, so a new project is truly empty.
        for (let i = 0; i < (node.inputs?.length || 0); i++) {
            if (/^ref_image_[1-9]$/.test(node.inputs[i].name)) node.disconnectInput(i);
        }
        widget(node, "refs_json").value = JSON.stringify({images: Array(9).fill(null)});
        setClips([]);
        node.properties.master_project_name = "Untitled";
        save();
        render();
    };
    node.masterProjectUnvalidate = () => { unvalidate(); render(); };
    node.masterProjectRestore = () => { setClips(JSON.parse(widget(node, "clips_json").value)); render(); };

    async function saveProject() {
        save();
        const entries = [];
        for (const master of masters()) {
            const settings = Object.fromEntries(master.widgets.filter(w => w.name !== "master_ui" && w.value !== undefined).map(w => [w.name, structuredClone(w.value)]));
            const images = [];
            for (const name of pictures(master)) {
                if (!name) { images.push(null); continue; }
                const response = await api.fetchApi(imageURL(name));
                if (!response.ok) throw new Error(`Picture is missing: ${name}. Attach it again before saving.`);
                images.push({name: name.split("/").pop(), data: await dataURL(await response.blob())});
            }
            entries.push({id: String(master.id), settings, images});
        }
        const project = {format: FORMAT, version: 1, name: node.properties.master_project_name || "Untitled", workflow: app.graph.serialize(), masters: entries};
        const url = URL.createObjectURL(new Blob([JSON.stringify(project)], {type: "application/json"}));
        const link = document.createElement("a");
        link.href = url;
        link.download = `${project.name.replace(/[^a-zA-Z0-9 _-]/g, "_") || "Untitled"}.h3project.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        message = "Project saved with its attached pictures and complete workflow.";
    }

    async function loadProject(file) {
        const project = readProject(await file.text());
        // Upload all embedded pictures before replacing the current project.
        for (const entry of project.masters) {
            const images = [];
            for (const image of entry.images) {
                if (!image) { images.push(null); continue; }
                const blob = await (await fetch(image.data)).blob();
                images.push(await upload(new File([blob], image.name, {type: blob.type})));
            }
            entry.settings.refs_json = JSON.stringify({images});
            const clips = JSON.parse(entry.settings.clips_json);
            for (const clip of clips) clip.validated = false;
            entry.settings.clips_json = JSON.stringify(clips);
        }
        await clearCache(project.masters.map(m => String(m.id)), project.workflow.nodes.filter(n => n.type === FINAL).map(n => String(n.id)));
        await app.loadGraphData(project.workflow);
        for (const entry of project.masters) {
            const master = app.graph.getNodeById(entry.id);
            if (!master) throw new Error("Could not restore the Master node.");
            for (const [name, value] of Object.entries(entry.settings)) {
                const w = widget(master, name);
                if (w) w.value = value;
            }
            master.masterProjectRestore?.();
        }
        message = "Project loaded. Clips are ready for fresh generation.";
    }

    function button(label, action) {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.cssText = style;
        b.disabled = busy;
        b.onclick = action;
        return b;
    }

    function toolbar() {
        const section = document.createElement("div");
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:center";
        const name = document.createElement("input");
        name.value = node.properties.master_project_name || "Untitled";
        name.placeholder = "Project name";
        name.style.cssText = style + ";width:145px";
        name.onchange = () => { node.properties.master_project_name = name.value.trim() || "Untitled"; };
        row.append(name,
            button("Save Project", () => run(saveProject)),
            button("Load Project", () => pickFile(".json", file => run(() => loadProject(file)))),
            button("New Project", () => run(async () => {
                await clearCache();
                for (const master of masters()) master.masterProjectReset?.();
                message = "New blank project. Old generation cache cleared.";
            })),
            button("Clear Cache", () => run(async () => {
                await clearCache();
                for (const master of masters()) master.masterProjectUnvalidate?.();
                message = "Active project cache cleared. Pictures, prompts and settings kept.";
            })),
        );
        const status = document.createElement("div");
        status.textContent = message;
        status.style.cssText = "color:#aaaac2;font-size:11px;padding-top:6px;white-space:normal";
        section.append(row, status);
        return section;
    }

    function references() {
        const section = document.createElement("div");
        section.style.cssText = "padding:10px;border:1px solid #323246;border-radius:6px;background:#1a1a26";
        const title = document.createElement("div");
        title.textContent = "Reference pictures · Attach up to 9 · Use <Picture 1> … <Picture 9> in prompts";
        title.style.cssText = "margin-bottom:8px;color:#b8b8d4";
        const grid = document.createElement("div");
        grid.style.cssText = "display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:6px";
        pictures(node).forEach((name, index) => {
            const slot = document.createElement("div");
            slot.style.cssText = "display:flex;flex-direction:column;gap:4px;min-width:0;text-align:center";
            const label = document.createElement("span");
            label.textContent = `Picture ${index + 1}`;
            const attach = button(name ? "Replace" : "Attach", () => pickFile("image/*", file => run(async () => {
                const uploaded = await upload(file);
                const images = pictures(node);
                images[index] = uploaded;
                widget(node, "refs_json").value = JSON.stringify({images});
                const inputIndex = node.inputs?.findIndex(i => i.name === `ref_image_${index + 1}`);
                if (inputIndex >= 0) node.disconnectInput(inputIndex);
                unvalidate();
                message = `Picture ${index + 1} attached.`;
            })));
            attach.style.fontSize = "10px";
            slot.append(label);
            if (name) {
                const img = document.createElement("img");
                img.src = api.apiURL(imageURL(name));
                img.alt = `Picture ${index + 1}`;
                img.style.cssText = "width:100%;height:64px;object-fit:contain;background:#101016;border-radius:4px";
                slot.append(img);
            } else {
                const empty = document.createElement("div");
                empty.textContent = "+";
                empty.style.cssText = "height:64px;border:1px dashed #454560;display:grid;place-items:center;color:#888;font-size:22px";
                slot.append(empty);
            }
            slot.append(attach);
            if (name) slot.append(button("Remove", () => {
                const images = pictures(node);
                images[index] = null;
                widget(node, "refs_json").value = JSON.stringify({images});
                unvalidate();
                render();
            }));
            grid.append(slot);
        });
        section.append(title, grid);
        return section;
    }

    return {toolbar, references, isBusy: () => busy};
}
