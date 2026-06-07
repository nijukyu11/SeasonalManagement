from __future__ import annotations

import os

import uvicorn

from agent.main import app


def main() -> None:
    port = int(os.environ.get("SEASONAL_AI_AGENT_PORT", "8765"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
