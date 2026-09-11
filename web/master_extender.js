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

function clampDuration(sec, beyond) {
    const max = beyond ? DUR_HARD_MAX : DUR_SOFT_MAX;
    const n = Math.round(Number(sec));
    if (!Number.isFinite(n)) return DUR_MIN;
    return Math.min(max, Math.max(DUR_MIN, n));
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

                        <!-- Prompt Box -->
                        <div>
                            <div style="font-size: 10px; color: #8888a4; margin-bottom: 2px;">Prompt:</div>
                            <textarea class="prompt-box" rows="4" placeholder="Enter clip prompt..." style="width: 100%; box-sizing: border-box; background: #101016; border: 1px solid #2e2e42; border-radius: 4px; color: #ececf4; padding: 6px 8px; font-size: 11px; line-height: 1.4; resize: vertical;"></textarea>
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
                    promptBox.value = clip.prompt || "";
                    promptBox.oninput = () => {
                        clip.prompt = promptBox.value;
                        clip.validated = false;
                        saveState();
                    };

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
