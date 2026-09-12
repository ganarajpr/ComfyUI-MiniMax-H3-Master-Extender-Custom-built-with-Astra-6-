"""
MiniMax H3 Master Extender Suite
=================================
Combining the Pure 2-Stage 2-Pass PDD 8-Step + 3D Latent Upscaler Engine
with the Multishot Master Extender UI & Continuity Architecture.
"""

import os
import folder_paths

# Ensure model folders are registered
if "pdd_acc" not in folder_paths.folder_names_and_paths:
    folder_paths.add_model_folder_path("pdd_acc", os.path.join(folder_paths.models_dir, "pdd_acc"))

if "latent_upscale_models" not in folder_paths.folder_names_and_paths:
    folder_paths.add_model_folder_path("latent_upscale_models", os.path.join(folder_paths.models_dir, "latent_upscale_models"))

from .master_node import (
    NODE_CLASS_MAPPINGS as MASTER_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as MASTER_NODE_DISPLAY_NAME_MAPPINGS,
)
from .final_decode import (
    NODE_CLASS_MAPPINGS as DECODE_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as DECODE_NODE_DISPLAY_NAME_MAPPINGS,
)
from .metadata_nodes import (
    NODE_CLASS_MAPPINGS as METADATA_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as METADATA_NODE_DISPLAY_NAME_MAPPINGS,
)

NODE_CLASS_MAPPINGS = {
    **MASTER_NODE_CLASS_MAPPINGS,
    **DECODE_NODE_CLASS_MAPPINGS,
    **METADATA_NODE_CLASS_MAPPINGS,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    **MASTER_NODE_DISPLAY_NAME_MAPPINGS,
    **DECODE_NODE_DISPLAY_NAME_MAPPINGS,
    **METADATA_NODE_DISPLAY_NAME_MAPPINGS,
}

WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
