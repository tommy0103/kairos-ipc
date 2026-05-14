from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from utils.bridge import client_from_runtime, optional_bool, optional_list, optional_string, required_string, source_from_parameters


PATH_TEMPLATE = "/sessions/{session_id}/runs"


class StartRunTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        session_id = required_string(tool_parameters, "session_id")
        agents = optional_list(tool_parameters, "agents") or []
        body: dict[str, Any] = {
            "instruction": required_string(tool_parameters, "instruction"),
            "agents": agents,
            "source": source_from_parameters(tool_parameters),
        }
        for key in ("mode", "expected_output"):
            value = optional_string(tool_parameters, key)
            if value:
                body[key] = value
        synthesis_requested = optional_bool(tool_parameters, "synthesis_requested")
        if synthesis_requested is not None:
            body["synthesis_requested"] = synthesis_requested
        yield self.create_json_message(client_from_runtime(self.runtime).post(PATH_TEMPLATE.format(session_id=session_id), body))
