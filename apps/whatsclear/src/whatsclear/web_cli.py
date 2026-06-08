from __future__ import annotations

import argparse
import os

import uvicorn

from .web_api import create_app


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="WhatsClear Web UI server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--db-path", default=os.getenv("WHATSCLEAR_DATABASE_URL") or "whatsclear.db")
    parser.add_argument("--reload", action="store_true")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    app = create_app(db_path=args.db_path)
    uvicorn.run(app, host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
