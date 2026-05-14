from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from utils.bridge import client_from_runtime, optional_string, required_string


PATH_TEMPLATE = "/approvals/{approval_id}/resolve"


class ResolveApprovalTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        approval_id = required_string(tool_parameters, "approval_id")
        body: dict[str, Any] = {"status": required_string(tool_parameters, "status")}
        for key in ("session_id", "resolution_note"):
            value = optional_string(tool_parameters, key)
            if value:
                body[key] = value
        yield self.create_json_message(client_from_runtime(self.runtime).post(PATH_TEMPLATE.format(approval_id=approval_id), body))
