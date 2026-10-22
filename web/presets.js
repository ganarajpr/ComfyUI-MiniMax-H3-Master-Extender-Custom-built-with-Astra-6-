// Engine presets for the panel's Preset dropdown. One entry per preset: add a row here and it appears.
// `values` are real widget values; the dropdown itself is never serialized, only these widgets are.
const PRUNED = "custom_node_hyperflow_8step_v1.0_comfyui_pruned.safetensors";
const DMAD = "h3\\minimax_h3_DMAD_4step_full_lora_avg_rank_39_bf16.safetensors";
const DUAL_MODE = "HyperFlow 8-step · dual sampling";

const kPreset = (k, res, label, hint) => ({
    id: `k${k}${res === "864x480 (16:9)" ? "-480p" : ""}`,
    label,
    hint,
    values: {
        accel_mode: DUAL_MODE,
        hyperflow_file: PRUNED,
        hyperflow_curve_refit: true,
        dual_sampling: true,
        pass1_early_stop: true,
        dual_split_step: k,
        pass1_resolution: res,
        pass2_resolution: "1280x720",
        pass2_lora: "none",
        pass2_steps: 0,
    },
});

const STANDARD_VALUES = {
    accel_mode: "HyperFlow 8-step",
    hyperflow_file: PRUNED,
    hyperflow_curve_refit: true,
    pass2_lora: DMAD,
    pass2_lora_mode: "replace engine LoRA",
    pass2_steps: 4,
    pass2_denoise: 0.25,
    pass1_resolution: "608x352 (16:9)",
    pass2_resolution: "1280x720",
    dual_sampling: false,
    pass1_early_stop: false,
    dual_split_step: 2,
    pass2_chunk_frames: 124,
    pass1_steps: 0,
};

const stdP1Preset = (k) => ({
    id: `standard-p1-${k}`,
    label: `Standard \u00b7 pass 1 = ${k} steps`,
    hint: `The Standard recipe with pass 1 stopped after ${k} of 8 HyperFlow steps; its clean estimate is upscaled and the normal refine runs. Not measured.`,
    values: { ...STANDARD_VALUES, pass1_steps: k },
});

export const MASTER_PRESETS = [
    {
        id: "standard",
        label: "Standard · ~122 s",
        hint: "HyperFlow 8-step, DMAD refiner. 15 s clip measured ~122 s.",
        values: STANDARD_VALUES,
    },
    stdP1Preset(7),
    stdP1Preset(6),
    kPreset(4, "608x352 (16:9)", "K4 · 352p · ~198 s", "Dual sampling, split 4, 352p pass 1. 15 s heavy clip ~198 s."),
    kPreset(5, "608x352 (16:9)", "K5 · 352p · ~176 s", "Dual sampling, split 5, 352p pass 1. 15 s clip ~176 s."),
    kPreset(6, "608x352 (16:9)", "K6 · 352p · not measured", "Dual sampling, split 6, 352p pass 1. Not measured."),
    kPreset(7, "608x352 (16:9)", "K7 · 352p · ~112 s", "Dual sampling, split 7, 352p pass 1. 15 s clip ~112 s."),
    kPreset(4, "864x480 (16:9)", "K4 · 480p · ~188 s", "Dual sampling, split 4, 480p pass 1. 15 s clip ~188 s."),
    kPreset(5, "864x480 (16:9)", "K5 · 480p · ~172 s", "Dual sampling, split 5, 480p pass 1. 15 s clip ~172 s."),
    kPreset(6, "864x480 (16:9)", "K6 · 480p · ~158 s", "Dual sampling, split 6, 480p pass 1. 15 s clip ~158 s."),
    kPreset(7, "864x480 (16:9)", "K7 · 480p · not measured", "Dual sampling, split 7, 480p pass 1. Not measured."),
];

export const CUSTOM_PRESET_ID = "custom";

const same = (a, b) => (typeof b === "number" ? Number(a) === b : typeof b === "boolean" ? a === b : String(a) === String(b));

// getValue(name) -> the widget's current value. Returns the first preset whose every listed value matches, else null.
export function matchPreset(getValue, presets = MASTER_PRESETS) {
    for (const p of presets) {
        if (Object.entries(p.values).every(([name, want]) => {
            const have = getValue(name);
            return have !== undefined && have !== null && same(have, want);
        })) return p;
    }
    return null;
}
