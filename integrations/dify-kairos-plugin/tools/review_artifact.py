from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from utils.bridge import client_from_runtime, optional_string, required_string, source_from_parameters


PATH_TEMPLATE = "/artifacts/{artifact_id}/review"


class ReviewArtifactTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        artifact_id = required_string(tool_parameters, "artifact_id")
        body: dict[str, Any] = {
            "status": required_string(tool_parameters, "status"),
            "source": source_from_parameters(tool_parameters),
        }
        for key in ("session_id", "note", "revision_instruction"):
            value = optional_string(tool_parameters, key)
            if value:
                body[key] = value
        yield self.create_json_message(client_from_runtime(self.runtime).post(PATH_TEMPLATE.format(artifact_id=artifact_id), body))
