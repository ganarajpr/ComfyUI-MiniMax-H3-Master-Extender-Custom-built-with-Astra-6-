#!/usr/bin/env python3
"""Add an H3 Story Writer node to a ComfyUI workflow (UI format: litegraph JSON with nodes and links) that holds a Master Extender node.

  tools/add_story_writer.py in.json out.json [--clips 8] [--seconds 15] [--no-preview] [--node-id N] [--workflow-id ID]

The writer is placed to the left of the whole graph, level with the Extender, and its ``story`` output is wired into the Extender's ``rewrite_story`` widget
input (a widget input stays in the node's ``inputs`` with its ``widget`` key and gets the link id; its value stays in ``widgets_values``). The Extender's
story_engine becomes e4.10 and its auto_clips the writer's clips (E4 needs auto_clips > 0 to plan, and decides the count itself). The writer starts with the
Extender's story text as its brief, the Extender's rewrite_writer_model and e4_language as its own, seed control fixed. A core ``PreviewAny`` ("Preview as
Text") node is wired to the story so it can be read in the graph (``--no-preview`` skips it).

Running it again on its own output changes nothing: a writer already wired into the Extender's rewrite_story is reused.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys

EXTENDER = "MiniMaxH3MasterExtender"
WRITER = "H3StoryWriter"
PREVIEW = "PreviewAny"
STORY_INPUT = "rewrite_story"
WRITER_WIDGETS = [("brief", "STRING"), ("clips", "INT"), ("seconds", "INT"), ("language", "STRING"), ("seed", "INT"), ("seed_control", None),
                  ("writer_model", "COMBO"), ("thinking_budget", "COMBO")]
WRITER_SIZE = (440, 430)
GAP = 80


class WorkflowError(ValueError):
    pass


def widget_names(node: dict) -> list:
    return [i["name"] for i in node.get("inputs", []) if i.get("widget")]


def get_widget(node: dict, name: str):
    names = widget_names(node)
    values = node.get("widgets_values") or []
    return values[names.index(name)] if name in names and names.index(name) < len(values) else None


def set_widget(node: dict, name: str, value) -> None:
    names = widget_names(node)
    if name not in names:
        raise WorkflowError(f"node {node['id']} ({node['type']}) has no widget '{name}'")
    index = names.index(name)
    values = node.setdefault("widgets_values", [])
    while len(values) <= index:
        values.append(None)
    values[index] = value


def find_extender(workflow: dict, node_id=None) -> dict:
    found = [n for n in workflow.get("nodes", []) if n.get("type") == EXTENDER and (node_id is None or n["id"] == node_id)]
    if not found:
        raise WorkflowError("no MiniMaxH3MasterExtender node in the workflow" + (f" with id {node_id}" if node_id is not None else ""))
    if len(found) > 1 and node_id is None:
        raise WorkflowError(f"{len(found)} Master Extender nodes ({', '.join(str(n['id']) for n in found)}); pick one with --node-id")
    return found[0]


def link_by_id(workflow: dict, link_id):
    for link in workflow.get("links", []):
        if link[0] == link_id:
            return link
    return None


def existing_writer(workflow: dict, extender: dict):
    """The writer already wired into the Extender's story input, with that link, or (None, None)."""
    story_input = next((i for i in extender.get("inputs", []) if i["name"] == STORY_INPUT), None)
    if story_input is None or story_input.get("link") is None:
        return None, None
    link = link_by_id(workflow, story_input["link"])
    if link is None:
        return None, None
    origin = next((n for n in workflow["nodes"] if n["id"] == link[1]), None)
    return (origin, link) if origin is not None and origin.get("type") == WRITER else (None, None)


def add_story_writer(workflow: dict, *, clips: int = 8, seconds: int = 15, preview: bool = True, node_id=None, workflow_id=None) -> dict:
    wf = copy.deepcopy(workflow)
    if workflow_id:
        wf["id"] = workflow_id
    extender = find_extender(wf, node_id)
    if STORY_INPUT not in widget_names(extender):
        raise WorkflowError(f"the Extender node has no '{STORY_INPUT}' input: this is not a build with the story widgets")
    story_input = next(i for i in extender["inputs"] if i["name"] == STORY_INPUT)
    writer, link = existing_writer(wf, extender)
    if writer is None and story_input.get("link") is not None:
        raise WorkflowError(f"the Extender's {STORY_INPUT} is already wired to something else (link {story_input['link']}); unwire it first")

    nodes, links = wf["nodes"], wf.setdefault("links", [])
    next_node = max([wf.get("last_node_id", 0)] + [n["id"] for n in nodes]) + 1
    next_link = max([wf.get("last_link_id", 0)] + [l[0] for l in links]) + 1

    if writer is None:
        brief = get_widget(extender, STORY_INPUT) or ""
        values = [brief, int(clips), int(seconds), get_widget(extender, "e4_language") or "English", 42, "fixed",
                  get_widget(extender, "rewrite_writer_model") or "", "4096"]
        left = min(n["pos"][0] for n in nodes if isinstance(n.get("pos"), list))
        order = max([n.get("order", 0) for n in nodes] + [0]) + 1
        writer = {
            "id": next_node, "type": WRITER, "pos": [left - WRITER_SIZE[0] - GAP, extender["pos"][1]], "size": list(WRITER_SIZE), "flags": {}, "order": order, "mode": 0,
            "inputs": [{"localized_name": n, "name": n, "type": t, "widget": {"name": n}, "link": None} for n, t in WRITER_WIDGETS if t],
            "outputs": [{"localized_name": "story", "name": "story", "type": "STRING", "links": [next_link]}],
            "properties": {"Node name for S&R": WRITER}, "widgets_values": values,
        }
        nodes.append(writer)
        next_node += 1
        link = [next_link, writer["id"], 0, extender["id"], extender["inputs"].index(story_input), "STRING"]
        links.append(link)
        story_input["link"] = link[0]
        next_link += 1

    if preview and not any(n.get("type") == PREVIEW and any(l[1] == writer["id"] and l[3] == n["id"] for l in links) for n in nodes):
        node = {
            "id": next_node, "type": PREVIEW, "pos": [writer["pos"][0], writer["pos"][1] + writer["size"][1] + 40], "size": [WRITER_SIZE[0], 200], "flags": {},
            "order": max(n.get("order", 0) for n in nodes) + 1, "mode": 0,
            "inputs": [{"localized_name": "source", "name": "source", "type": "*", "link": next_link}],
            "outputs": [{"localized_name": "STRING", "name": "STRING", "type": "STRING", "links": None}],
            "properties": {"Node name for S&R": PREVIEW}, "widgets_values": [""],
        }
        nodes.append(node)
        links.append([next_link, writer["id"], 0, node["id"], 0, "STRING"])
        writer["outputs"][0].setdefault("links", []).append(next_link)
        next_node += 1
        next_link += 1

    set_widget(extender, "story_engine", "e4.10")
    set_widget(extender, "auto_clips", int(clips))
    wf["last_node_id"] = max(next_node - 1, wf.get("last_node_id", 0))
    wf["last_link_id"] = max(next_link - 1, wf.get("last_link_id", 0))
    return wf


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source")
    ap.add_argument("target")
    ap.add_argument("--clips", type=int, default=8)
    ap.add_argument("--seconds", type=int, default=15)
    ap.add_argument("--no-preview", action="store_true")
    ap.add_argument("--node-id", type=int)
    ap.add_argument("--workflow-id", help="a new id for the workflow (a copy of an example would otherwise keep the original's)")
    a = ap.parse_args(argv)
    with open(a.source, encoding="utf-8") as handle:
        workflow = json.load(handle)
    try:
        out = add_story_writer(workflow, clips=a.clips, seconds=a.seconds, preview=not a.no_preview, node_id=a.node_id, workflow_id=a.workflow_id)
    except WorkflowError as error:
        print(f"add_story_writer: {error}", file=sys.stderr)
        return 1
    with open(a.target, "w", encoding="utf-8") as handle:
        json.dump(out, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    print(f"{a.target}: {len(out['nodes'])} nodes, {len(out['links'])} links")
    return 0


if __name__ == "__main__":
    sys.exit(main())
