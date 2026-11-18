"""End-to-end latency split from the LangSmith traces of an eval run. No model calls.

    uv run python -m eval.trace_latency baseline
    uv run python -m eval.trace_latency baseline final      # side by side

For every finished trace tagged ["eval", <label>] in the project:

  model     every LLM run (each Gemini chat call) + the embed_question span (the embedding API)
  tool      every tool run (the ledger tools, i.e. our database queries) + the policy_search span
  our code  the rest of the trace: graph plumbing, prompt building, verification, the audit row

reported as p50 / p95 over traces, overall and per category. The eval's local
timers measure the same split independently (eval/report.py); the two should
agree to within the tracer's overhead.

Uses client.runs.query (POST /api/v2/runs/query), the supported replacement of
the deprecated list_runs; LangSmith deprecation warnings are errors here.
"""

import asyncio
import os
import statistics
import sys
import warnings
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from langsmith.types.run_select_field import RunSelectField

from ledger_agent.config import apply_tracing_env

from .run import load_label

MODEL_TYPES = {"llm", "embedding"}
TOOL_TYPES = {"tool", "retriever"}
SELECTS: list[RunSelectField] = [
    "ID",
    "TRACE_ID",
    "IS_ROOT",
    "RUN_TYPE",
    "NAME",
    "LATENCY_SECONDS",
    "METADATA",
    "STATUS",
]


@dataclass(frozen=True)
class Split:
    item: str
    rep: int
    category: str
    total: float
    model: float
    tool: float

    @property
    def own(self) -> float:
        return max(0.0, self.total - self.model - self.tool)


def _kind(run: Any) -> str:
    return str(run.run_type).lower()


def split_traces(runs: list[Any], waits: dict[tuple[str, int], float] | None = None) -> list[Split]:
    """Group runs by trace and attribute each finished trace's time. Unfinished or failed traces are skipped.

    waits: the runner's own throttle wait per (item, rep). The throttle sleeps inside a callback that runs
    after the tracer started the LLM run's clock, so the trace counts that wait as model time; it is
    subtracted here. With waits given, a trace whose (item, rep) has no recorded wait is skipped.
    """
    by_trace: dict[str, list[Any]] = defaultdict(list)
    for r in runs:
        by_trace[str(r.trace_id)].append(r)
    out: list[Split] = []
    for members in by_trace.values():
        root = next((r for r in members if r.is_root), None)
        if root is None or root.status != "success" or root.latency_seconds is None:
            continue
        meta = root.metadata or {}
        item, rep = str(meta.get("eval_item", "?")), int(meta.get("eval_rep", 0) or 0)
        wait = 0.0
        if waits is not None:
            if (item, rep) not in waits:
                continue
            wait = waits[(item, rep)]
        model = sum(float(r.latency_seconds or 0.0) for r in members if _kind(r) in MODEL_TYPES) - wait
        tool = sum(float(r.latency_seconds or 0.0) for r in members if _kind(r) in TOOL_TYPES)
        out.append(
            Split(item, rep, str(meta.get("eval_category", "?")), float(root.latency_seconds) - wait, model, tool)
        )
    return out


def p(values: list[float], q: int) -> float:
    if not values:
        return 0.0
    if len(values) == 1:
        return values[0]
    return statistics.quantiles(sorted(values), n=100, method="inclusive")[q - 1]


async def fetch_runs(label: str) -> list[Any]:
    from langsmith import Client

    client = Client()
    project = await client.aread_project(project_name=os.environ["LANGSMITH_PROJECT"])
    records = load_label(label)
    tag = label.partition("@")[0]  # a view (baseline@subset) reads the traces of its run
    starts = [datetime.fromisoformat(r["started_at"]) for r in records if "started_at" in r]
    since = (min(starts) if starts else datetime.now(UTC)) - timedelta(minutes=5)
    runs: list[Any] = []
    # Every run inside every trace whose root carries both tags: one paged query.
    async for r in client.runs.query(
        project_ids=[str(project.id)],
        min_start_time=since,
        trace_filter=f'and(has(tags, "eval"), has(tags, "{tag}"))',
        selects=SELECTS,
    ):
        runs.append(r)
    return runs


def summary(splits: list[Split]) -> dict[str, tuple[float, float]]:
    return {
        k: (p(v, 50), p(v, 95))
        for k, v in (
            ("total", [s.total for s in splits]),
            ("model", [s.model for s in splits]),
            ("tool", [s.tool for s in splits]),
            ("our code", [s.own for s in splits]),
        )
    }


def print_label(label: str, splits: list[Split]) -> None:
    print(f"\n{label}: {len(splits)} finished traces")
    cats = sorted({s.category for s in splits})
    print(f"{'':14s} {'total p50/p95':>16s} {'model':>14s} {'tool':>12s} {'our code':>12s}")
    for name, group in [("all", splits), *[(c, [s for s in splits if s.category == c]) for c in cats]]:
        sm = summary(group)
        cells = [f"{sm[k][0]:.1f}/{sm[k][1]:.1f}s" for k in ("total", "model", "tool", "our code")]
        print(f"{name:14s} {cells[0]:>16s} {cells[1]:>14s} {cells[2]:>12s} {cells[3]:>12s}")


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 1
    warnings.filterwarnings("error", message=r".*is deprecated and will be removed after", category=DeprecationWarning)
    apply_tracing_env()
    if not os.environ.get("LANGSMITH_API_KEY"):
        print("LANGSMITH_API_KEY is not set: no traces to read. eval/report.py gives the same split from local timers.")
        return 0
    for label in argv:
        records = load_label(label)
        waits = {
            (r["item"], r["rep"]): float(r["wait_s"]) for r in records if r.get("status") == "ok" and "wait_s" in r
        }
        print_label(label, split_traces(asyncio.run(fetch_runs(label)), waits))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
