import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

let selectedFile, download, clearCalls = 0, uploads = 0, refuseClear = false;
const blobs = new Map();
class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.style = {}; }
    append(...items) { this.children.push(...items); }
    click() {
        if (this.type === "file") { this.files = [selectedFile]; this.onchange(); }
        else if (this.tag === "a") download = blobs.get(this.href);
        else this.onclick?.();
    }
}
class Reader {
    async readAsDataURL(blob) {
        this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`;
        this.onload();
    }
}
const app = {
    graph: {
        _nodes: [],
        serialize() { return {nodes: this._nodes.map(n => ({id: n.id, type: n.type, properties: structuredClone(n.properties || {}), widgets_values: n.widgets.map(w => w.value)})), links: []}; },
        getNodeById(id) { return this._nodes.find(n => String(n.id) === String(id)); },
    },
    async loadGraphData(workflow) {
        this.graph._nodes = workflow.nodes.map(n => n.type === "MiniMaxH3MasterExtender" ? makeMaster(n.id, n.properties).node : {...n, widgets: n.widgets_values.map(value => ({value}))});
    },
};
const api = {
    apiURL: path => path,
    async fetchApi(path, options) {
        if (path === "/upload/image") {
            uploads++;
            assert.equal(options.body.get("type"), "input");
            return Response.json({name: `image${uploads}.png`, subfolder: "minimax_master"});
        }
        if (path.startsWith("/view?")) return new Response(new Blob(["picture bytes"], {type: "image/png"}));
        assert.equal(path, "/minimax_master/clear_cache");
        if (refuseClear) return Response.json({error: "Wait for the running jobs."}, {status: 409});
        clearCalls++;
        const request = JSON.parse(options.body);
        // The project is identified by its clips (server derives the chain key), never by node id.
        assert.equal(request.owners, undefined);
        assert(Array.isArray(request.clips) && request.clips.length === 1);
        assert(Array.isArray(JSON.parse(request.clips[0])));
        return Response.json({ok: true});
    },
};
const context = vm.createContext({
    app, api, document: {createElement: tag => new Element(tag)}, FileReader: Reader,
    Blob, File, FormData, Response, fetch, URLSearchParams, structuredClone, crypto,
    URL: {createObjectURL: blob => { const key = `blob:${blobs.size}`; blobs.set(key, blob); return key; }, revokeObjectURL() {}},
    setTimeout() {},
});
const source = fs.readFileSync(new URL("../web/master_projects.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace("export function createProjectControls", "function createProjectControls");
vm.runInContext(source + "\nthis.controls = createProjectControls; this.parseProject = readProject;", context);

function makeMaster(id = 6, properties = {}) {
    let clips = [{id: 0, prompt: "test <Picture 9>", duration: 5.1, seed: 42, validated: false, seed_mode: "fixed"}];
    const node = {
        id, type: "MiniMaxH3MasterExtender", properties,
        widgets: [
            {name: "clips_json", value: JSON.stringify(clips)},
            {name: "refs_json", value: JSON.stringify({images: Array(9).fill(null)})},
            {name: "pass2_denoise", value: 0.25},
            {name: "attention_backend", value: "comfy kitchen attention"},
        ],
        inputs: Array.from({length: 9}, (_, i) => ({name: `ref_image_${i + 1}`, link: 3})),
        disconnectInput(i) { this.inputs[i].link = null; },
    };
    const result = {node, getClips: () => clips};
    result.controls = context.controls(node, {
        getClips: () => clips, setClips: value => { clips = value; },
        save: () => { node.widgets[0].value = JSON.stringify(clips); }, render() {},
    });
    node.test = result;
    return result;
}
function find(element, label) {
    if (element.tag === "button" && element.textContent === label) return element;
    for (const child of element.children || []) { const result = find(child, label); if (result) return result; }
}
async function idle(controls) {
    for (let i = 0; i < 100 && controls.isBusy(); i++) await new Promise(setImmediate);
    assert.equal(controls.isBusy(), false);
}
let current = makeMaster();
app.graph._nodes = [current.node, {id: 7, type: "MiniMaxH3MasterFinalDecode", widgets: [{name: "crf", value: 19}]}];
selectedFile = new File(["picture"], "test.png", {type: "image/png"});
const slots = current.controls.references().children[1].children;
assert.equal(slots.length, 9);
find(slots[8], "Attach").click();
await idle(current.controls);
assert.equal(JSON.parse(current.node.widgets[1].value).images[8], "minimax_master/image1.png");
assert.equal(current.node.inputs[8].link, null);
current.node.widgets[2].value = 0.4;
current.node.widgets[3].value = "sage attention 2.2";
current.node.properties.master_project_name = "My film";
find(current.controls.toolbar(), "Save Project").click();
await idle(current.controls);
assert(download);
const project = JSON.parse(await download.text());
assert.equal(project.masters[0].images[8].data, "data:image/png;base64,cGljdHVyZSBieXRlcw==");
assert.equal(project.masters[0].settings.pass2_denoise, 0.4);
assert.equal(project.workflow.nodes[1].widgets_values[0], 19);
find(current.controls.references().children[1].children[8], "Remove").click();
assert.equal(JSON.parse(current.node.widgets[1].value).images[8], null);
selectedFile = new File([JSON.stringify(project)], "My film.h3project.json", {type: "application/json"});
find(current.controls.toolbar(), "Load Project").click();
await idle(current.controls);
current = app.graph.getNodeById(6).test;
assert.equal(current.node.widgets[2].value, 0.4);
assert.equal(current.node.widgets[3].value, "sage attention 2.2");
assert.equal(current.getClips()[0].prompt, "test <Picture 9>");
assert.equal(current.getClips()[0].validated, false);
assert.equal(JSON.parse(current.node.widgets[1].value).images[8], "minimax_master/image2.png");
current.getClips()[0].validated = true;
const refs = current.node.widgets[1].value;
find(current.controls.toolbar(), "Clear Cache").click();
await idle(current.controls);
assert.equal(current.node.widgets[1].value, refs);
assert.equal(current.getClips()[0].validated, false);
assert.equal(current.node.widgets[2].value, 0.4);
refuseClear = true;
find(current.controls.toolbar(), "New Project").click();
await idle(current.controls);
assert.equal(current.getClips().length, 1);
refuseClear = false;
find(current.controls.toolbar(), "New Project").click();
await idle(current.controls);
assert.equal(current.getClips().length, 0);
assert(JSON.parse(current.node.widgets[1].value).images.every(i => i === null));
assert(current.node.inputs.every(i => i.link === null));
assert.equal(current.node.widgets[2].value, 0.25);
assert.equal(current.node.properties.master_project_name, "Untitled");
assert.equal(clearCalls, 2);  // Clear Cache + New Project; Load Project no longer clears (chains are per project)
assert.throws(() => context.parseProject('{"format":"wrong"}'));
console.log("PASS: nine slots, upload/remove, portable project round trip, settings, cache clear, blank reset, busy-job rejection");
