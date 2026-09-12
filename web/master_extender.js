import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { createProjectControls } from "./master_projects.js";

const TARGET_NODE = "MiniMaxH3MasterExtender";
const EVENT_PROGRESS = "master_extender_progress";

function alignH3Frames(sec) {
    let frames = Math.max(5, Math.round(Number(sec) * 24.0));
    while (frames % 17 !== 5) {
        frames++;
    }
    return frames;
}

// Clip duration slider: whole seconds, 5-15 s by default; the per-clip
// "go beyond" checkbox unlocks up to 30 s (longer clips need far more VRAM).
const DUR_MIN = 5;
const DUR_SOFT_MAX = 15;
const DUR_HARD_MAX = 30;

const PROMPT_PREVIEW_LINES = 4;      // compact preview inside the clip card
const PANEL_WIDTH = 640;               // screen px, independent of canvas zoom
const PANEL_MIN_HEIGHT = 460;
const PANEL_GAP = 18;

// Known H3 prompt sections get a stronger colour than ad-hoc headings.
const H3_SECTIONS = new Set([
    "subject_definitions", "summary", "retention_analysis", "detailed_description",
    "overall_soundscape", "non_diegetic_music", "dialogue", "sound_effects",
    "camera", "style", "negative", "audio", "music", "voice", "shots",
]);

function escapeHtml(text) {
    return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Inline tokens: <Picture 1> / <Subject 2> / <Audio 1> references, [Shot 3] and
// [reference generation] tags, 00:04.500 timestamps, "quoted dialogue".
function highlightInline(text) {
    const re = /(<(?:Picture|Subject|Audio|Image|Ref)\s*\d*>)|(\[[^\]\n]{1,40}\])|(\b\d{1,2}:\d{2}(?:\.\d{1,3})?\b|\b\d+(?:\.\d+)?s\b)|("[^"\n]{1,200}")|(\*\*[^*\n]+\*\*)/g;
    let out = "";
    let last = 0;
    for (const m of text.matchAll(re)) {
        out += escapeHtml(text.slice(last, m.index));
        const tok = escapeHtml(m[0]);
        if (m[1]) out += `<span class="h3-ref">${tok}</span>`;
        else if (m[2]) out += `<span class="h3-tag">${tok}</span>`;
        else if (m[3]) out += `<span class="h3-time">${tok}</span>`;
        else if (m[4]) out += `<span class="h3-quote">${tok}</span>`;
        else out += `<span class="h3-bold">${tok}</span>`;
        last = m.index + m[0].length;
    }
    return out + escapeHtml(text.slice(last));
}

// Line-level structure: # title, ## section, "- key: value" definitions.
function highlightH3(text) {
    const lines = (text || "").split("\n");
    const html = lines.map((line) => {
        let m;
        if ((m = /^(\s*)(#{1,6})(\s+)(.*)$/.exec(line))) {
            const name = m[4].trim().toLowerCase();
            const cls = m[2].length >= 2 && H3_SECTIONS.has(name) ? "h3-section" : "h3-heading";
            return `${m[1]}<span class="${cls}"><span class="h3-hash">${m[2]}</span>${m[3]}${highlightInline(m[4])}</span>`;
        }
        if ((m = /^(\s*[-*]\s+)([A-Za-z0-9_][\w .\-]{0,40}?)(:)(.*)$/.exec(line))) {
            return `${escapeHtml(m[1])}<span class="h3-key">${escapeHtml(m[2])}</span><span class="h3-colon">${m[3]}</span>${highlightInline(m[4])}`;
        }
        if ((m = /^(\s*[-*]\s+)(.*)$/.exec(line))) {
            return `<span class="h3-bullet">${escapeHtml(m[1])}</span>${highlightInline(m[2])}`;
        }
        return highlightInline(line);
    });
    // Trailing newline needs a visible line so the overlay height matches the textarea.
    return html.join("\n") + "\n";
}

const H3_HIGHLIGHT_CSS = `
.minimax-prompt-panel .h3-heading { color: #c4b5fd; font-weight: 700; }
.minimax-prompt-panel .h3-section { color: #9d8cff; font-weight: 700; }
.minimax-prompt-panel .h3-hash { color: #5b5b7a; font-weight: 400; }
.minimax-prompt-panel .h3-key { color: #7dd3fc; font-weight: 600; }
.minimax-prompt-panel .h3-colon { color: #5b5b7a; }
.minimax-prompt-panel .h3-bullet { color: #5b5b7a; }
.minimax-prompt-panel .h3-ref { color: #fbbf24; font-weight: 600; }
.minimax-prompt-panel .h3-tag { color: #4ade80; }
.minimax-prompt-panel .h3-time { color: #f472b6; }
.minimax-prompt-panel .h3-quote { color: #fcd9a8; font-style: italic; }
.minimax-prompt-panel .h3-bold { color: #ffffff; font-weight: 700; }
.minimax-prompt-panel textarea::selection { background: rgba(157, 140, 255, 0.35); }
.minimax-prompt-preview .h3-heading, .minimax-prompt-preview .h3-section { color: #b8a9ff; font-weight: 600; }
.minimax-prompt-preview .h3-hash, .minimax-prompt-preview .h3-colon, .minimax-prompt-preview .h3-bullet { color: #5b5b7a; }
.minimax-prompt-preview .h3-key { color: #7dd3fc; }
.minimax-prompt-preview .h3-ref { color: #fbbf24; }
.minimax-prompt-preview .h3-tag { color: #4ade80; }
.minimax-prompt-preview .h3-time { color: #f472b6; }
`;

function ensureHighlightStyles() {
    if (document.getElementById("minimax-h3-highlight-css")) return;
    const style = document.createElement("style");
    style.id = "minimax-h3-highlight-css";
    style.textContent = H3_HIGHLIGHT_CSS;
    document.head.appendChild(style);
}

// Card preview: the "## summary" section when the prompt has one, else the
// prompt from the top. Blank lines are dropped so the four visible lines count.
function previewText(prompt) {
    const lines = (prompt || "").split(/\r?\n/);
    const start = lines.findIndex((l) => /^\s*#{1,6}\s+summary\s*$/i.test(l));
    if (start >= 0) {
        const body = [];
        for (let i = start + 1; i < lines.length; i++) {
            if (/^\s*#{1,6}\s+\S/.test(lines[i])) break;
            if (lines[i].trim()) body.push(lines[i]);
        }
        if (body.length) return { text: body.join("\n"), fromSummary: true };
    }
    return { text: lines.filter((l) => l.trim()).join("\n"), fromSummary: false };
}

function describePrompt(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return "empty";
    const words = trimmed.split(/\s+/).length;
    const lines = trimmed.split(/\r?\n/).length;
    return `${words} words · ${lines} lines`;
}

// Screen-space rectangle of a node, from LiteGraph's canvas transform.
function nodeScreenRect(node) {
    const canvas = app.canvas;
    const rect = canvas.canvas.getBoundingClientRect();
    const ds = canvas.ds;
    const titleH = (window.LiteGraph && window.LiteGraph.NODE_TITLE_HEIGHT) || 30;
    const x = rect.left + (node.pos[0] + ds.offset[0]) * ds.scale;
    const y = rect.top + (node.pos[1] - titleH + ds.offset[1]) * ds.scale;
    return { x, y, w: node.size[0] * ds.scale, h: (node.size[1] + titleH) * ds.scale, canvasRect: rect };
}

// Place the panel beside the node: right of it when there is room, else left,
// else clamped inside the canvas. Height follows the node but stays readable.
function placePanelNextToNode(panel, node) {
    const r = nodeScreenRect(node);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const height = Math.max(PANEL_MIN_HEIGHT, Math.min(r.h, vh - 40));
    let x = r.x + r.w + PANEL_GAP;
    if (x + PANEL_WIDTH > vw - 10) x = r.x - PANEL_GAP - PANEL_WIDTH;
    if (x < 10) x = Math.max(10, Math.min(vw - PANEL_WIDTH - 10, r.x + r.w + PANEL_GAP));
    let y = r.y;
    if (y + height > vh - 10) y = vh - 10 - height;
    if (y < 10) y = 10;
    panel.style.left = `${Math.round(x)}px`;
    panel.style.top = `${Math.round(y)}px`;
    panel.style.width = `${PANEL_WIDTH}px`;
    panel.style.height = `${Math.round(height)}px`;
}

function clampDuration(sec, beyond) {
    const max = beyond ? DUR_HARD_MAX : DUR_SOFT_MAX;
    const n = Math.round(Number(sec));
    if (!Number.isFinite(n)) return DUR_MIN;
    return Math.min(max, Math.max(DUR_MIN, n));
}

// Conditional widget visibility on the Master node. A hidden widget keeps its
// value and its slot in widgets_values; it just draws with zero height.
const TURBO_ONLY_WIDGETS = ["turbo_lora", "turbo_lora_strength", "turbo_sampler", "turbo_scheduler"];
const PDD_ONLY_WIDGETS = ["pdd_file"];
const SLA_ONLY_WIDGETS = ["sla_sparsity"];

function setWidgetVisible(widget, visible) {
    if (!widget) return;
    if (widget._origType === undefined) {
        widget._origType = widget.type;
        widget._origComputeSize = widget.computeSize;
    }
    if (visible) {
        widget.type = widget._origType;
        widget.computeSize = widget._origComputeSize;
    } else {
        widget.type = "hidden";
        widget.computeSize = () => [0, -4];
    }
}

function setupModeWidgets(node) {
    const byName = (name) => node.widgets?.find(w => w.name === name);
    const accel = byName("accel_mode");
    const sla = byName("sla_enabled");
    if (!accel && !sla) return;

    const apply = () => {
        const turbo = String(accel?.value ?? "").toLowerCase().startsWith("turbo");
        const slaOn = sla ? !!sla.value : false;
        TURBO_ONLY_WIDGETS.forEach(n => setWidgetVisible(byName(n), turbo));
        PDD_ONLY_WIDGETS.forEach(n => setWidgetVisible(byName(n), !turbo));
        SLA_ONLY_WIDGETS.forEach(n => setWidgetVisible(byName(n), slaOn));
        // Let LiteGraph recompute the node height without shrinking the DOM
        // editor that sits at the bottom of the node.
        const size = node.computeSize();
        node.setSize([Math.max(node.size[0], size[0]), Math.max(node.size[1], size[1])]);
        node.setDirtyCanvas(true, true);
    };
    node.applyModeWidgets = apply;

    for (const w of [accel, sla]) {
        if (!w) continue;
        const original = w.callback;
        w.callback = function () {
            const r = original?.apply(this, arguments);
            apply();
            return r;
        };
    }
    apply();
}

app.registerExtension({
    name: "MiniMaxH3.MasterExtender",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== TARGET_NODE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            this.setupMasterUI();
            return r;
        };

        nodeType.prototype.setupMasterUI = function () {
            const node = this;
            node.setSize([960, 680]);

            // Hide raw JSON widgets
            const clipsWidget = node.widgets?.find(w => w.name === "clips_json");
            const refsWidget = node.widgets?.find(w => w.name === "refs_json");

            if (clipsWidget) clipsWidget.type = "hidden";
            if (refsWidget) refsWidget.type = "hidden";

            let clipsState = [];
            try {
                clipsState = JSON.parse(clipsWidget.value || "[]");
            } catch (e) {
                clipsState = [];
            }
            // The side panel addresses clips by id, so ids must be unique numbers.
            const nextClipId = (clips) => clips.reduce((m, c) => Math.max(m, typeof c.id === "number" ? c.id : -1), -1) + 1;
            const ensureClipIds = (clips) => {
                const seen = new Set();
                clips.forEach((c) => {
                    if (typeof c.id !== "number" || seen.has(c.id)) c.id = nextClipId(clips);
                    seen.add(c.id);
                });
                return clips;
            };
            if (Array.isArray(clipsState)) ensureClipIds(clipsState);
            if (!Array.isArray(clipsState) || clipsState.length === 0) {
                clipsState = [
                    {
                        id: 0,
                        title: "Clip 1",
                        prompt: "",
                        duration: 5.1,
                        seed: Math.floor(Math.random() * 1000000000),
                        seed_mode: "randomize",
                        validated: false,
                        loras: []
                    }
                ];
            }

            // Create Master UI DOM container
            const container = document.createElement("div");
            container.className = "minimax-master-container";
            container.style.cssText = `
                display: flex;
                flex-direction: column;
                gap: 12px;
                padding: 12px;
                background: #14141c;
                border-radius: 8px;
                border: 1px solid #2a2a3c;
                color: #e2e2ec;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                font-size: 12px;
                user-select: none;
                max-width: 930px;
            `;

            function saveState() {
                if (clipsWidget) {
                    clipsWidget.value = JSON.stringify(clipsState, null, 2);
                }
                node.setDirtyCanvas(true, true);
            }

            const originalConfigure = node.onConfigure;
            node.onConfigure = function () {
                const result = originalConfigure?.apply(this, arguments);
                // Older workflows stored the empty master_ui value in this slot.
                const attentionWidget = node.widgets?.find(w => w.name === "attention_backend");
                if (attentionWidget && attentionWidget.value === "") {
                    attentionWidget.value = "comfy kitchen attention";
                }
                try {
                    const restored = JSON.parse(clipsWidget.value || "[]");
                    if (Array.isArray(restored)) clipsState = ensureClipIds(restored);
                } catch (error) {
                    console.warn("MiniMax Master: invalid saved clips JSON", error);
                }
                renderUI();
                node.applyModeWidgets?.();
                return result;
            };

            const projectControls = createProjectControls(node, {
                getClips: () => clipsState,
                setClips: clips => { clipsState = clips; },
                save: saveState,
                render: () => renderUI(),
            });

            // ---- Prompt side panel: one per node, lives on document.body ----
            const promptPanel = { el: null, clipId: null, raf: 0, textarea: null, layer: null, title: null, meta: null };

            function markCardSelected(card, on) {
                card.style.outline = on ? "2px solid #9d8cff" : "none";
                card.style.outlineOffset = on ? "-1px" : "0";
            }

            function findClip(clipId) {
                const index = clipsState.findIndex((c) => c.id === clipId);
                return { index, clip: index >= 0 ? clipsState[index] : null };
            }

            function closePromptPanel() {
                if (promptPanel.raf) cancelAnimationFrame(promptPanel.raf);
                promptPanel.raf = 0;
                promptPanel.el?.remove();
                promptPanel.el = null;
                promptPanel.textarea = null;
                promptPanel.clipId = null;
                container.querySelectorAll(".minimax-clip-card").forEach((c) => markCardSelected(c, false));
            }

            function buildPromptPanel() {
                ensureHighlightStyles();
                const el = document.createElement("div");
                el.className = "minimax-prompt-panel";
                el.style.cssText = `
                    position: fixed; z-index: 9000;
                    display: flex; flex-direction: column; gap: 8px;
                    background: #14141c; border: 1px solid #383852; border-radius: 10px;
                    padding: 10px 12px; box-shadow: 0 14px 44px rgba(0,0,0,0.55);
                    color: #e2e2ec; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 12px;
                    user-select: text;
                `;
                el.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <button class="pp-prev" title="Previous clip" style="background: #252536; border: 1px solid #3f3f58; color: #c7c7e0; border-radius: 3px; font-size: 11px; padding: 1px 7px; cursor: pointer;">&#9664;</button>
                            <span class="pp-title" style="font-size: 13px; font-weight: 700; color: #9d8cff;"></span>
                            <button class="pp-next" title="Next clip" style="background: #252536; border: 1px solid #3f3f58; color: #c7c7e0; border-radius: 3px; font-size: 11px; padding: 1px 7px; cursor: pointer;">&#9654;</button>
                        </div>
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <span class="pp-meta" style="color: #6f6f8a; font-size: 11px; font-variant-numeric: tabular-nums;"></span>
                            <button class="pp-close" title="Close (Esc)" style="background: transparent; border: none; color: #9c9cb2; font-size: 15px; cursor: pointer; padding: 0 2px;">&#10005;</button>
                        </div>
                    </div>
                    <div class="pp-editor" style="position: relative; flex: 1; min-height: 0; border: 1px solid #2e2e42; border-radius: 6px; background: #0f0f16; overflow: hidden;">
                        <pre class="pp-layer" aria-hidden="true" style="position: absolute; inset: 0; margin: 0; padding: 12px 14px; overflow: auto; pointer-events: none; white-space: pre-wrap; word-break: break-word; color: #d9d9e6; font: 13px/1.6 'Cascadia Mono', Consolas, 'JetBrains Mono', ui-monospace, monospace; tab-size: 2;"></pre>
                        <textarea class="pp-text" spellcheck="false" style="position: absolute; inset: 0; width: 100%; height: 100%; box-sizing: border-box; margin: 0; padding: 12px 14px; border: none; outline: none; resize: none; background: transparent; color: transparent; caret-color: #ffffff; overflow: auto; white-space: pre-wrap; word-break: break-word; font: 13px/1.6 'Cascadia Mono', Consolas, 'JetBrains Mono', ui-monospace, monospace; tab-size: 2; user-select: text; -webkit-user-select: text;"></textarea>
                    </div>
                    <div style="display: flex; justify-content: space-between; align-items: center; color: #6f6f8a; font-size: 10.5px;">
                        <span>Saves as you type · Esc closes · Tab inserts two spaces</span>
                        <span style="display: flex; gap: 8px;">
                            <span><span class="h3-section">## section</span></span>
                            <span><span class="h3-key">key</span><span class="h3-colon">:</span></span>
                            <span class="h3-ref">&lt;Picture 1&gt;</span>
                            <span class="h3-tag">[Shot 1]</span>
                            <span class="h3-time">00:04.500</span>
                        </span>
                    </div>
                `;
                document.body.appendChild(el);

                const textarea = el.querySelector(".pp-text");
                const layer = el.querySelector(".pp-layer");
                const paint = () => { layer.innerHTML = highlightH3(textarea.value); };
                const syncScroll = () => { layer.scrollTop = textarea.scrollTop; layer.scrollLeft = textarea.scrollLeft; };

                let saveTimer = 0;
                textarea.oninput = () => {
                    paint();
                    const { clip } = findClip(promptPanel.clipId);
                    if (!clip) return;
                    clip.prompt = textarea.value;
                    clip.validated = false;
                    el.querySelector(".pp-meta").textContent = describePrompt(textarea.value);
                    const card = [...container.querySelectorAll(".minimax-clip-card")].find((c) => c._clipId === clip.id);
                    card?._paintPreview?.();
                    clearTimeout(saveTimer);
                    saveTimer = setTimeout(saveState, 150);
                };
                textarea.onscroll = syncScroll;
                textarea.addEventListener("keydown", (e) => {
                    if (e.key === "Escape") { e.preventDefault(); closePromptPanel(); return; }
                    if (e.key === "Tab") {
                        e.preventDefault();
                        const { selectionStart: a, selectionEnd: b } = textarea;
                        textarea.setRangeText("  ", a, b, "end");
                        textarea.oninput();
                    }
                    e.stopPropagation();   // no graph shortcuts while typing
                });
                el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
                el.addEventListener("pointerdown", (e) => e.stopPropagation());
                el.querySelector(".pp-close").onclick = closePromptPanel;
                el.querySelector(".pp-prev").onclick = () => stepPromptPanel(-1);
                el.querySelector(".pp-next").onclick = () => stepPromptPanel(1);

                promptPanel.el = el;
                promptPanel.textarea = textarea;
                promptPanel.layer = layer;
                promptPanel.title = el.querySelector(".pp-title");
                promptPanel.meta = el.querySelector(".pp-meta");
                promptPanel.paint = paint;

                const follow = () => {
                    if (!promptPanel.el) return;
                    if (!node.graph) { closePromptPanel(); return; }   // node was deleted
                    placePanelNextToNode(el, node);
                    promptPanel.raf = requestAnimationFrame(follow);
                };
                follow();
            }

            function stepPromptPanel(delta) {
                const { index } = findClip(promptPanel.clipId);
                if (index < 0) return;
                const next = clipsState[(index + delta + clipsState.length) % clipsState.length];
                openPromptPanel(next.id);
            }

            function openPromptPanel(clipId, { focus = true } = {}) {
                const { index, clip } = findClip(clipId);
                if (!clip) return;
                if (!promptPanel.el) buildPromptPanel();
                promptPanel.clipId = clipId;
                promptPanel.title.textContent = `Clip ${index + 1}${clip.title && clip.title !== `Clip ${index + 1}` ? ` · ${clip.title}` : ""}`;
                promptPanel.meta.textContent = describePrompt(clip.prompt || "");
                promptPanel.textarea.value = clip.prompt || "";
                promptPanel.paint();
                promptPanel.textarea.scrollTop = 0;
                promptPanel.layer.scrollTop = 0;
                container.querySelectorAll(".minimax-clip-card").forEach((c) => markCardSelected(c, c._clipId === clipId));
                if (focus) promptPanel.textarea.focus({ preventScroll: true });
            }

            const originalOnRemoved = node.onRemoved;
            node.onRemoved = function () {
                closePromptPanel();
                return originalOnRemoved?.apply(this, arguments);
            };

            function renderUI() {
                container.innerHTML = "";

                // 1. Master Header
                const header = document.createElement("div");
                header.style.cssText = `
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-bottom: 1px solid #2e2e42;
                    padding-bottom: 10px;
                `;

                const totalSec = clipsState.reduce((acc, c) => acc + Number(c.duration || 5.1), 0);
                const totalFrames = clipsState.reduce((acc, c) => acc + alignH3Frames(c.duration || 5.1), 0);

                header.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 15px; font-weight: 700; color: #9d8cff; letter-spacing: -0.2px;">🎬 MiniMax H3 Master</span>
                        <span style="background: #252538; color: #a5a5c5; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; border: 1px solid #383852;">2-Pass Pure PDD 8-Step</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <span style="color: #9292ab; font-size: 11px; font-weight: 500;">
                            ${clipsState.length} Clips (${totalSec.toFixed(1)}s / ${totalFrames} frames)
                        </span>
                        <button id="add-clip-btn" style="background: #6355d8; hover: #7568e6; color: #ffffff; border: none; padding: 5px 12px; border-radius: 5px; cursor: pointer; font-weight: 600; font-size: 12px; box-shadow: 0 2px 4px rgba(99,85,216,0.3);">+ Add Clip</button>
                    </div>
                `;
                container.appendChild(header);
                container.appendChild(projectControls.toolbar());

                header.querySelector("#add-clip-btn").onclick = () => {
                    const nextId = nextClipId(clipsState);
                    clipsState.push({
                        id: nextId,
                        title: `Clip ${nextId + 1}`,
                        prompt: "",
                        duration: 5,
                        beyond: false,
                        seed: Math.floor(Math.random() * 1000000000),
                        seed_mode: "randomize",
                        validated: false,
                        loras: []
                    });
                    saveState();
                    renderUI();
                };

                container.appendChild(projectControls.references());

                // 3. HORIZONTAL Clip Cards Container (Placed horizontally side-by-side)
                const horizontalContainer = document.createElement("div");
                horizontalContainer.style.cssText = `
                    display: flex;
                    flex-direction: row;
                    overflow-x: auto;
                    gap: 14px;
                    padding: 6px 2px 14px 2px;
                    scroll-behavior: smooth;
                `;

                clipsState.forEach((clip, index) => {
                    const card = document.createElement("div");
                    card.className = "minimax-clip-card";
                    const isValidated = Boolean(clip.validated);
                    card.style.cssText = `
                        flex: 0 0 310px;
                        width: 310px;
                        background: ${isValidated ? "#18261e" : "#1c1c28"};
                        border: 1px solid ${isValidated ? "#2e6a45" : "#323246"};
                        border-radius: 7px;
                        padding: 10px;
                        display: flex;
                        flex-direction: column;
                        gap: 8px;
                        box-shadow: 0 3px 6px rgba(0,0,0,0.25);
                        box-sizing: border-box;
                    `;

                    const durValue = clampDuration(clip.duration || DUR_MIN, clip.beyond);
                    const durMax = clip.beyond ? DUR_HARD_MAX : DUR_SOFT_MAX;
                    const frames = alignH3Frames(durValue);
                    const seedMode = clip.seed_mode || "randomize";

                    card.innerHTML = `
                        <!-- Card Header -->
                        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid ${isValidated ? '#285236' : '#28283a'}; padding-bottom: 6px;">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <span style="font-weight: 700; color: ${isValidated ? "#4ade80" : "#ffffff"}; font-size: 13px;">Clip ${index + 1}</span>
                                <span style="background: #111118; color: #9c9cb8; padding: 1px 5px; border-radius: 3px; font-size: 10px;">${clip.duration}s (${frames}f)</span>
                                ${index > 0 ? `<span style="background: #2b2866; color: #c7d2fe; padding: 1px 5px; border-radius: 3px; font-size: 9px; font-weight: 500;">🔗 Linked</span>` : ''}
                            </div>
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <label style="display: flex; align-items: center; gap: 4px; cursor: pointer; color: ${isValidated ? "#4ade80" : "#aaa"}; font-size: 11px;">
                                    <input type="checkbox" class="val-check" ${isValidated ? "checked" : ""}>
                                    <span>Validated</span>
                                </label>
                                ${clipsState.length > 1 ? `<button class="del-btn" title="Delete Clip" style="background: transparent; border: none; color: #ef4444; cursor: pointer; font-size: 14px; padding: 0 2px;">✕</button>` : ''}
                            </div>
                        </div>

                        <!-- Prompt: compact preview; click it (or the card) to edit in the side panel -->
                        <div>
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px;">
                                <span style="font-size: 10px; color: #8888a4;">Prompt:</span>
                                <span class="prompt-meta" style="font-size: 10px; color: #6f6f8a; font-variant-numeric: tabular-nums;"></span>
                            </div>
                            <div class="prompt-preview minimax-prompt-preview" title="Click to edit in the prompt panel" style="box-sizing: border-box; width: 100%; min-height: ${PROMPT_PREVIEW_LINES * 15 + 12}px; max-height: ${PROMPT_PREVIEW_LINES * 15 + 12}px; overflow: hidden; background: #101016; border: 1px solid #2e2e42; border-radius: 4px; color: #d4d4e4; padding: 6px 8px; font-size: 11px; line-height: 15px; white-space: pre-wrap; word-break: break-word; cursor: text; position: relative;"></div>
                        </div>

                        <!-- Duration Setting: 5-15 s slider, "go beyond" unlocks up to 30 s -->
                        <div style="display: flex; flex-direction: column; gap: 4px; background: #13131c; padding: 4px 6px; border-radius: 4px; border: 1px solid #242434;">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <span style="color: #9c9cb2; font-size: 11px;">Duration:</span>
                                <span class="dur-label" style="color: #fff; font-size: 11px; font-variant-numeric: tabular-nums;">${durValue}s</span>
                            </div>
                            <input type="range" class="dur-slider" value="${durValue}" step="1" min="${DUR_MIN}" max="${durMax}" style="width: 100%; accent-color: #6355d8; cursor: pointer;">
                            <label style="display: flex; align-items: center; gap: 5px; color: #8888a4; font-size: 10px; cursor: pointer;">
                                <input type="checkbox" class="dur-beyond" ${clip.beyond ? "checked" : ""} style="accent-color: #6355d8; margin: 0;">
                                go beyond ${DUR_SOFT_MAX}s (up to ${DUR_HARD_MAX}s, more VRAM)
                            </label>
                        </div>

                        <!-- Seed & Seed Mode Controls -->
                        <div style="display: flex; flex-direction: column; gap: 4px; background: #13131c; padding: 6px; border-radius: 4px; border: 1px solid #242434;">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <span style="color: #9c9cb2; font-size: 11px;">Seed Control:</span>
                                <select class="seed-mode" style="background: #1b1b26; border: 1px solid #36364e; border-radius: 3px; color: #9d8cff; font-size: 10px; padding: 2px 4px; cursor: pointer;">
                                    <option value="randomize" ${seedMode === "randomize" ? "selected" : ""}>randomize</option>
                                    <option value="fixed" ${seedMode === "fixed" ? "selected" : ""}>fixed</option>
                                    <option value="increment" ${seedMode === "increment" ? "selected" : ""}>increment</option>
                                    <option value="decrement" ${seedMode === "decrement" ? "selected" : ""}>decrement</option>
                                </select>
                            </div>
                            <div style="display: flex; gap: 4px; align-items: center;">
                                <input type="number" class="seed-input" value="${clip.seed || 42}" style="flex: 1; background: #1b1b26; border: 1px solid #36364e; border-radius: 3px; color: #fff; padding: 3px 6px; font-size: 11px;">
                                <button class="dice-btn" title="Roll Random Seed" style="background: #252536; border: 1px solid #3f3f58; color: #eee; border-radius: 3px; cursor: pointer; padding: 2px 8px; font-size: 12px;">🎲</button>
                            </div>
                        </div>
                    `;

                    // Event Listeners for Card
                    const preview = card.querySelector(".prompt-preview");
                    const promptMeta = card.querySelector(".prompt-meta");
                    const paintPreview = () => {
                        const text = clip.prompt || "";
                        const { text: shown, fromSummary } = previewText(text);
                        preview.innerHTML = text.trim()
                            ? highlightH3(shown)
                            : `<span style="color: #55556e;">Enter clip prompt…</span>`;
                        preview.title = fromSummary ? "Showing the ## summary section. Click to edit the full prompt." : "Click to edit in the prompt panel";
                        promptMeta.textContent = text.trim()
                            ? `${fromSummary ? "summary · " : ""}${describePrompt(text)}`
                            : "";
                    };
                    paintPreview();
                    card._paintPreview = paintPreview;
                    card._clipId = clip.id;
                    if (promptPanel.clipId === clip.id) markCardSelected(card, true);
                    preview.onclick = () => openPromptPanel(clip.id);
                    card.addEventListener("click", (e) => {
                        if (e.target.closest("input, button, select, label, textarea")) return;
                        openPromptPanel(clip.id);
                    });

                    const durSlider = card.querySelector(".dur-slider");
                    const durLabel = card.querySelector(".dur-label");
                    const durBeyond = card.querySelector(".dur-beyond");
                    durSlider.oninput = () => {
                        durLabel.textContent = `${durSlider.value}s`;
                    };
                    durSlider.onchange = () => {
                        clip.duration = clampDuration(parseInt(durSlider.value, 10), clip.beyond);
                        saveState();
                        renderUI();
                    };
                    durBeyond.onchange = () => {
                        clip.beyond = durBeyond.checked;
                        clip.duration = clampDuration(clip.duration, clip.beyond);
                        saveState();
                        renderUI();
                    };

                    const seedInput = card.querySelector(".seed-input");
                    seedInput.onchange = () => {
                        clip.seed = parseInt(seedInput.value) || 42;
                        saveState();
                    };

                    const seedModeSelect = card.querySelector(".seed-mode");
                    seedModeSelect.onchange = () => {
                        clip.seed_mode = seedModeSelect.value;
                        saveState();
                    };

                    const diceBtn = card.querySelector(".dice-btn");
                    diceBtn.onclick = () => {
                        clip.seed = Math.floor(Math.random() * 1000000000);
                        seedInput.value = clip.seed;
                        saveState();
                    };

                    const valCheck = card.querySelector(".val-check");
                    valCheck.onchange = () => {
                        clip.validated = valCheck.checked;
                        saveState();
                        renderUI();
                    };

                    const delBtn = card.querySelector(".del-btn");
                    if (delBtn) {
                        delBtn.onclick = () => {
                            clipsState.splice(index, 1);
                            saveState();
                            renderUI();
                        };
                    }

                    horizontalContainer.appendChild(card);
                });

                container.appendChild(horizontalContainer);

                const continueButton = document.createElement("button");
                continueButton.textContent = "Run / Continue after validation";
                continueButton.disabled = !clipsState.length || projectControls.isBusy();
                continueButton.onclick = async () => {
                    saveState();
                    continueButton.disabled = true;
                    try { await app.queuePrompt(0, 1); }
                    finally { continueButton.disabled = false; }
                };
                container.appendChild(continueButton);

                // 4. Progress Bar Area
                const progressBox = document.createElement("div");
                progressBox.id = "minimax-master-progress";
                progressBox.style.cssText = `
                    display: none;
                    background: #14141e;
                    border: 1px solid #333348;
                    border-radius: 6px;
                    padding: 8px 10px;
                    flex-direction: column;
                    gap: 4px;
                `;
                progressBox.innerHTML = `
                    <div style="display: flex; justify-content: space-between; font-size: 11px;">
                        <span id="master-progress-msg" style="color: #9d8cff; font-weight: 500;">Rendering...</span>
                        <span id="master-progress-pct" style="color: #aaa;">0%</span>
                    </div>
                    <div style="width: 100%; height: 6px; background: #222230; border-radius: 3px; overflow: hidden;">
                        <div id="master-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #6355d8, #9d8cff); transition: width 0.2s;"></div>
                    </div>
                `;
                container.appendChild(progressBox);

                if (promptPanel.el) {
                    const { clip } = findClip(promptPanel.clipId);
                    if (clip) openPromptPanel(clip.id, { focus: false }); else closePromptPanel();
                }
            }

            renderUI();
            node.addDOMWidget("master_ui", "Master Director UI", container);

            // Show the turbo-only inputs only in Turbo LoRA mode, the PDD file
            // only in PDD mode, and the SLA sparsity only when SLA is on.
            // Hidden widgets keep their values, so switching back loses nothing.
            setupModeWidgets(node);

            // Real-time WebSocket Progress Listener
            const progressHandler = (event) => {
                const data = event.detail;
                if (!data || String(data.owner) !== String(node.id)) return;

                const pBox = container.querySelector("#minimax-master-progress");
                const pMsg = container.querySelector("#master-progress-msg");
                const pPct = container.querySelector("#master-progress-pct");
                const pBar = container.querySelector("#master-progress-bar");

                if (pBox) {
                    pBox.style.display = "flex";
                    if (pMsg) pMsg.textContent = data.message || `Rendering clip ${data.clip_index + 1}...`;
                    const pct = Math.round((data.percent || 0.0) * 100);
                    if (pPct) pPct.textContent = `${pct}%`;
                    if (pBar) pBar.style.width = `${pct}%`;
                }
            };
            api.addEventListener(EVENT_PROGRESS, progressHandler);
            const onRemoved = node.onRemoved;
            node.onRemoved = function () {
                api.removeEventListener(EVENT_PROGRESS, progressHandler);
                return onRemoved?.apply(this, arguments);
            };
        };
    }
});
