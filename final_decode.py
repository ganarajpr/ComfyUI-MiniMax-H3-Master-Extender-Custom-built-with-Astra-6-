"""
MiniMax H3 Master Final Decode Node
===================================
Decodes cached multishot latent sequences to video + audio,
encodes via FFmpeg (NVENC hardware accelerated when available),
and outputs the final merged VIDEO.
"""

import os
from .motion_context_disk import (
    CACHE_TYPE,
    MiniMaxH3MotionContextDiskFinalDecode as _BaseFinalDecode,
)

class MiniMaxH3MasterFinalDecode(_BaseFinalDecode):
    CATEGORY = "MiniMax H3 Master"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        base_types = super().INPUT_TYPES()
        return base_types


NODE_CLASS_MAPPINGS = {
    "MiniMaxH3MasterFinalDecode": MiniMaxH3MasterFinalDecode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3MasterFinalDecode": "MiniMax H3 Master Final Decode",
}
