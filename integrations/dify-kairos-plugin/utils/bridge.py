from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

import requests


DEFAULT_TIMEOUT_SECONDS = 180


class KairosBridgeError(Exception):
    pass


class KairosBridgeClient:
    def __init__(self, bridge_url: str, bridge_token: str | None = None, timeout: int = DEFAULT_TIMEOUT_SECONDS):
        self.bridge_url = bridge_url.rstrip("/")
        self.bridge_token = bridge_token
        self.timeout = timeout

    @classmethod
    def from_credentials(cls, credentials: dict[str, Any]) -> "KairosBridgeClient":
        bridge_url = str(credentials.get("bridge_url") or "").strip()
        if not bridge_url:
            raise KairosBridgeError("bridge_url is required")
        bridge_token = str(credentials.get("bridge_token") or "").strip() or None
        return cls(bridge_url=bridge_url, bridge_token=bridge_token)

    def health(self) -> dict[str, Any]:
        return self.get("/health")

    def get(self, path: str, query: dict[str, Any] | None = None) -> dict[str, Any]:
        return self.request("GET", path, query=query)

    def post(self, path: str, body: dict[str, Any] | None = None, text: bool = False) -> dict[str, Any]:
        return self.request("POST", path, body=body or {}, text=text)

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
        text: bool = False,
    ) -> dict[str, Any]:
        url = self.bridge_url + path
        if query:
            clean_query = {key: value for key, value in query.items() if value not in (None, "")}
            if clean_query:
                url = f"{url}?{urlencode(clean_query)}"

        headers = {"content-type": "application/json"}
        if self.bridge_token:
            headers["authorization"] = f"Bearer {self.bridge_token}"

        try:
            response = requests.request(method, url, json=body, headers=headers, timeout=self.timeout)
        except requests.RequestException as error:
            raise KairosBridgeError(f"Kairos bridge request failed: {error}")

        if response.status_code >= 400:
            raise KairosBridgeError(response.text or f"Kairos bridge returned HTTP {response.status_code}")

        if text:
            return {
                "text": response.text,
                "session_id": response.headers.get("x-kairos-session-id"),
            }

        if not response.text.strip():
            return {}
        return response.json()


def client_from_runtime(runtime: Any) -> KairosBridgeClient:
    credentials = getattr(runtime, "credentials", None) or {}
    return KairosBridgeClient.from_credentials(credentials)


def optional_string(parameters: dict[str, Any], key: str) -> str | None:
    value = parameters.get(key)
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def required_string(parameters: dict[str, Any], key: str) -> str:
    value = optional_string(parameters, key)
    if not value:
        raise KairosBridgeError(f"{key} is required")
    return value


def optional_list(parameters: dict[str, Any], key: str) -> list[str] | None:
    value = parameters.get(key)
    if value is None or value == "":
        return None
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return [item.strip() for item in str(value).split(",") if item.strip()]


def optional_bool(parameters: dict[str, Any], key: str) -> bool | None:
    value = parameters.get(key)
    if isinstance(value, bool):
        return value
    if value is None or value == "":
        return None
    normalized = str(value).strip().lower()
    if normalized in ("true", "1", "yes"):
        return True
    if normalized in ("false", "0", "no"):
        return False
    return None


def source_from_parameters(parameters: dict[str, Any]) -> dict[str, Any]:
    source: dict[str, Any] = {}
    for key in ("app_id", "conversation_id", "message_id", "user_id", "workflow_run_id"):
        value = optional_string(parameters, key)
        if value:
            source[key] = value
    return source
