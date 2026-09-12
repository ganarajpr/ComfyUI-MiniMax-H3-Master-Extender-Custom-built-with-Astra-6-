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

const PROMPT_MIN_ROWS = 4;
const PROMPT_MAX_PX = 360;   // inline box grows with the text up to this, then scrolls

function autosizeTextarea(el) {
    if (!el || !el.isConnected) return;
    el.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 17;
    const minPx = Math.ceil(PROMPT_MIN_ROWS * lineHeight + 14);
    const target = Math.min(PROMPT_MAX_PX, Math.max(minPx, el.scrollHeight + 2));
    el.style.height = `${target}px`;
}

function describePrompt(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return "";
    const words = trimmed.split(/\s+/).length;
    const lines = trimmed.split(/\r?\n/).length;
    return `${words} words · ${lines} lines`;
}

// Large modal editor for a clip prompt. Ctrl+Enter saves, Esc or a click on the
// backdrop cancels. Lives on document.body so it is never clipped by the node.
function openPromptEditor({ title, value, onSave }) {
    document.querySelector(".minimax-prompt-editor-backdrop")?.remove();
    const backdrop = document.createElement("div");
    backdrop.className = "minimax-prompt-editor-backdrop";
    backdrop.style.cssText = `
        position: fixed; inset: 0; z-index: 10000;
        background: rgba(6, 6, 12, 0.72);
        display: flex; align-items: center; justify-content: center;
    `;
    const panel = document.createElement("div");
    panel.style.cssText = `
        width: min(920px, 90vw); height: min(78vh, 900px);
        display: flex; flex-direction: column; gap: 10px;
        background: #14141c; border: 1px solid #383852; border-radius: 10px;
        padding: 14px 16px; box-shadow: 0 18px 60px rgba(0,0,0,0.6);
        color: #e2e2ec; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 12px;
    `;
    panel.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 14px; font-weight: 700; color: #9d8cff;">${title}</span>
            <div style="display: flex; align-items: center; gap: 10px;">
                <label style="display: flex; align-items: center; gap: 5px; color: #9c9cb2; font-size: 11px; cursor: pointer;">
                    <input type="checkbox" class="mono-toggle"> monospace
                </label>
                <span class="editor-meta" style="color: #6f6f8a; font-size: 11px; font-variant-numeric: tabular-nums;"></span>
            </div>
        </div>
        <textarea class="editor-box" spellcheck="false" style="flex: 1; width: 100%; box-sizing: border-box; resize: none; background: #0f0f16; border: 1px solid #2e2e42; border-radius: 6px; color: #ececf4; padding: 12px 14px; font-size: 13.5px; line-height: 1.55; user-select: text; -webkit-user-select: text; tab-size: 2;"></textarea>
        <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="color: #6f6f8a; font-size: 11px;">Ctrl+Enter saves · Esc cancels · Tab inserts two spaces</span>
            <div style="display: flex; gap: 8px;">
                <button class="cancel-btn" style="background: #252536; border: 1px solid #3f3f58; color: #c7c7e0; border-radius: 5px; padding: 6px 14px; cursor: pointer;">Cancel</button>
                <button class="save-btn" style="background: #6355d8; border: none; color: #fff; border-radius: 5px; padding: 6px 16px; font-weight: 600; cursor: pointer;">Save</button>
            </div>
        </div>
    `;
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);

    const box = panel.querySelector(".editor-box");
    const meta = panel.querySelector(".editor-meta");
    const mono = panel.querySelector(".mono-toggle");
    box.value = value || "";
    const updateMeta = () => { meta.textContent = describePrompt(box.value) || "empty"; };
    updateMeta();
    box.oninput = updateMeta;
    mono.onchange = () => { box.style.fontFamily = mono.checked ? "Consolas, 'Cascadia Mono', monospace" : ""; };

    const close = () => { backdrop.remove(); document.removeEventListener("keydown", onKey, true); };
    const save = () => { onSave(box.value); close(); };
    // One capture-phase handler owns the keyboard while the editor is open. It
    // runs before the textarea's own listeners would, so Tab is handled here too.
    const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); save(); return; }
        if (e.key === "Tab" && e.target === box) {
            e.preventDefault();
            const { selectionStart: a, selectionEnd: b } = box;
            box.setRangeText("  ", a, b, "end");
            box.oninput();
        }
        // Everything else stays inside the editor: no graph shortcuts while typing.
        e.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    backdrop.onmousedown = (e) => { if (e.target === backdrop) close(); };
    panel.querySelector(".cancel-btn").onclick = close;
    panel.querySelector(".save-btn").onclick = save;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
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
                    if (Array.isArray(restored)) clipsState = restored;
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
                    const nextId = clipsState.length;
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

                        <!-- Prompt Box: auto-grows with the text, scrolls without zooming the canvas, opens a large editor -->
                        <div>
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px;">
                                <span style="font-size: 10px; color: #8888a4;">Prompt:</span>
                                <div style="display: flex; align-items: center; gap: 6px;">
                                    <span class="prompt-meta" style="font-size: 10px; color: #6f6f8a; font-variant-numeric: tabular-nums;"></span>
                                    <button class="expand-btn" title="Open a large editor (Ctrl+Enter saves, Esc cancels)" style="background: #252536; border: 1px solid #3f3f58; color: #c7c7e0; border-radius: 3px; font-size: 10px; padding: 1px 7px; cursor: pointer;">Edit &#8599;</button>
                                </div>
                            </div>
                            <textarea class="prompt-box" rows="${PROMPT_MIN_ROWS}" spellcheck="false" placeholder="Enter clip prompt..." style="width: 100%; box-sizing: border-box; background: #101016; border: 1px solid #2e2e42; border-radius: 4px; color: #ececf4; padding: 6px 8px; font-size: 12px; line-height: 1.45; resize: vertical; overflow-y: auto; user-select: text; -webkit-user-select: text; tab-size: 2;"></textarea>
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
                    const promptBox = card.querySelector(".prompt-box");
                    const promptMeta = card.querySelector(".prompt-meta");
                    const expandBtn = card.querySelector(".expand-btn");
                    promptBox.value = clip.prompt || "";
                    const refreshPromptMeta = () => { promptMeta.textContent = describePrompt(promptBox.value); };
                    const autosize = () => autosizeTextarea(promptBox);
                    promptBox.oninput = () => {
                        clip.prompt = promptBox.value;
                        clip.validated = false;
                        autosize();
                        refreshPromptMeta();
                        saveState();
                    };
                    // Wheel over a scrollable prompt scrolls the text; only at the
                    // ends does it fall through to the canvas zoom.
                    promptBox.addEventListener("wheel", (e) => {
                        if (promptBox.scrollHeight <= promptBox.clientHeight) return;
                        const atTop = promptBox.scrollTop <= 0 && e.deltaY < 0;
                        const atBottom = promptBox.scrollTop + promptBox.clientHeight >= promptBox.scrollHeight - 1 && e.deltaY > 0;
                        if (!atTop && !atBottom) e.stopPropagation();
                    }, { passive: true });
                    // Keep every key inside the textarea (Ctrl+A, Delete, arrows) away from the graph shortcuts.
                    promptBox.addEventListener("keydown", (e) => e.stopPropagation());
                    expandBtn.onclick = () => openPromptEditor({
                        title: `Clip ${index + 1} prompt`,
                        value: promptBox.value,
                        onSave: (text) => {
                            promptBox.value = text;
                            promptBox.oninput();
                        },
                    });
                    refreshPromptMeta();
                    requestAnimationFrame(autosize);

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
