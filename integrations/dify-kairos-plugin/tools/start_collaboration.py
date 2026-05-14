from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from utils.bridge import client_from_runtime, optional_list, optional_string, required_string, source_from_parameters


class StartCollaborationTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        body: dict[str, Any] = {
            "message": required_string(tool_parameters, "message"),
            "source": source_from_parameters(tool_parameters),
        }
        for key in ("title", "expected_output"):
            value = optional_string(tool_parameters, key)
            if value:
                body[key] = value
        agents = optional_list(tool_parameters, "agents")
        if agents:
            body["agents"] = agents
        yield self.create_json_message(client_from_runtime(self.runtime).post("/chat", body, text=True))
