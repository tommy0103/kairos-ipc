from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from utils.bridge import KairosBridgeError, client_from_runtime, optional_string


class GetTraceTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        session_id = optional_string(tool_parameters, "session_id")
        run_id = optional_string(tool_parameters, "run_id")
        if session_id:
            path = f"/sessions/{session_id}/trace"
        elif run_id:
            path = f"/runs/{run_id}/trace"
        else:
            raise KairosBridgeError("session_id or run_id is required")
        yield self.create_json_message(client_from_runtime(self.runtime).get(path))
