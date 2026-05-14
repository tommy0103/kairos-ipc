from typing import Any

from dify_plugin import ToolProvider
from dify_plugin.errors.tool import ToolProviderCredentialValidationError

from utils.bridge import KairosBridgeClient, KairosBridgeError


class KairosProvider(ToolProvider):
    def _validate_credentials(self, credentials: dict[str, Any]) -> None:
        try:
            KairosBridgeClient.from_credentials(credentials).health()
        except KairosBridgeError as error:
            raise ToolProviderCredentialValidationError(str(error))
