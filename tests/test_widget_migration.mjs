import assert from "node:assert/strict";
import fs from "node:fs";
import { dropCaptionModelValue, dropSingleTextEncodeValue, normalizeReasoningBudget } from "../web/widget_migration.js";

const workflows = fs.readdirSync(new URL("../example_workflows/", import.meta.url)).filter(f => f.endsWith(".json"));
assert(workflows.length >= 5);

for (const file of workflows) {
    const flow = JSON.parse(fs.readFileSync(new URL(`../example_workflows/${file}`, import.meta.url), "utf8"));
    const node = flow.nodes.find(n => n.type === "MiniMaxH3MasterExtender");
    // widget order of the current node = its widget inputs, then the JS-only master_ui
    const names = [...node.inputs.filter(i => i.widget).map(i => i.name), "master_ui"];
    const current = node.widgets_values;
    assert.equal(names.length, current.length, file);
    assert.equal(dropCaptionModelValue(names, current), null, `${file}: current layout is left alone`);
    assert.equal(dropSingleTextEncodeValue(names, current), null, `${file}: no single_text_encode value to drop`);

    // the same workflow as saved before single_text_encode was removed: one boolean right after audio_refine_cache
    const cache = names.indexOf("audio_refine_cache");
    for (const flag of [true, false]) {
        const withFlag = [...current];
        withFlag.splice(cache + 1, 0, flag);
        const fixed = dropSingleTextEncodeValue(names, withFlag);
        assert.deepEqual(fixed, current, `${file}: single_text_encode=${flag} dropped, later widgets re-seated`);
    }

    // the same workflow as saved before the merge: one extra value right after the writer, an INT budget
    const w = names.indexOf("rewrite_writer_model");
    const old = [...current];
    old.splice(w + 1, 0, "Some Captioner (local) · with its bf16 mmproj");
    old[names.indexOf("rewrite_reasoning_budget") + 1] = 4096;
    const migrated = dropCaptionModelValue(names, old);
    assert.deepEqual(migrated.slice(0, 42), current.slice(0, 42), file);
    assert.equal(migrated.length, current.length, file);
    assert.equal(migrated[names.indexOf("rewrite_caption_length")], current[names.indexOf("rewrite_caption_length")], file);
    assert.equal(migrated[names.indexOf("rewrite_story")], current[names.indexOf("rewrite_story")], file);
    assert.equal(migrated[names.indexOf("auto_clip_seconds")], 15, file);
    assert.equal(migrated[names.indexOf("master_ui")], "", file);
    assert.equal(normalizeReasoningBudget(migrated[names.indexOf("rewrite_reasoning_budget")]), "4096");

    // an old workflow saved before the trailing widgets existed: shorter array, master_ui's "" in a new slot
    const older = old.slice(0, names.indexOf("rewrite_story") + 1 + 1);
    const olderMigrated = dropCaptionModelValue(names, older);
    assert.equal(olderMigrated.length, older.length - 1);
    assert.equal(olderMigrated[names.indexOf("rewrite_caption_length")], current[names.indexOf("rewrite_caption_length")]);
}

assert.equal(dropCaptionModelValue(["rewrite_writer_model"], ["w"]), null);
assert.equal(dropCaptionModelValue(["rewrite_writer_model", "rewrite_caption_length"], undefined), null);

const table = [[-1, "4096"], [0, "4096"], [512, "1024"], [1024, "1024"], [1500, "1024"], [1536, "2048"], [2048, "2048"],
    [3072, "4096"], [4096, "4096"], [8192, "4096"], [16384, "4096"], [32768, "4096"], ["2048", "2048"], ["", "4096"], [null, "4096"], ["x", "4096"]];
for (const [given, want] of table) assert.equal(normalizeReasoningBudget(given), want, String(given));
console.log("widget migration ok");
