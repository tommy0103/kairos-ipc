from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from utils.bridge import client_from_runtime, required_string


class ListArtifactsTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        session_id = required_string(tool_parameters, "session_id")
        yield self.create_json_message(client_from_runtime(self.runtime).get(f"/sessions/{session_id}/artifacts"))
