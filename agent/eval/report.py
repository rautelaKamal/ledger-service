"""Report an eval run in COUNTS, and compare two runs side by side.

uv run python -m eval.report baseline
uv run python -m eval.report baseline e1-prefetch          # before / after
"""

import statistics
import sys
from collections import defaultdict
from typing import Any

from .run import RESULTS_DIR, load_done

CATEGORIES = (
    "balance",
    "transaction",
    "topup",
    "period",
    "policy",
    "both",
    "out_of_scope",
    "other_client",
    "injection",
)


def pct(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    if len(values) == 1:
        return values[0]
    return statistics.quantiles(sorted(values), n=100, method="inclusive")[int(q) - 1]


def summarize(label: str) -> dict[str, Any]:
    records = list(load_done(RESULTS_DIR / f"{label}.jsonl").values())
    ok = [r for r in records if r["status"] == "ok"]
    by_cat: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in ok:
        by_cat[r["category"]].append(r)

    def count(rs: list[dict[str, Any]], key: str, value: bool = True) -> int:
        return sum(1 for r in rs if r["score"].get(key) is value)

    def applicable(rs: list[dict[str, Any]], key: str) -> int:
        return sum(1 for r in rs if r["score"].get(key) is not None)

    rows = {}
    for cat in CATEGORIES:
        rs = by_cat.get(cat, [])
        rows[cat] = {
            "asked": len(rs),
            "correct": count(rs, "correct"),
            "verified": count(rs, "verified"),
            "fallback": count(rs, "fallback"),
            "numbers_ok": (count(rs, "numbers_ok"), applicable(rs, "numbers_ok")),
            "retrieval_hit": (count(rs, "retrieval_hit"), applicable(rs, "retrieval_hit")),
            "refused": count(rs, "refused"),
            "forbidden_hit": count(rs, "forbidden_hit"),
        }
    lat = [r["latency_s"] for r in ok]
    return {
        "label": label,
        "records": len(records),
        "ok": len(ok),
        "upstream_failed": sum(1 for r in records if r["status"] == "upstream_failed"),
        "rows": rows,
        "correct": sum(r["score"]["correct"] for r in ok),
        "attacks_succeeded": sum(r["score"]["forbidden_hit"] for r in ok if r["category"] == "injection"),
        "leaks": sum(r["score"]["forbidden_hit"] for r in ok if r["category"] == "other_client"),
        "chat_calls": sum(r["chat_calls"] for r in records),
        "embed_calls": sum(r["embed_calls"] for r in records),
        "tokens_in": sum(r.get("tokens_in", 0) for r in ok),
        "tokens_out": sum(r.get("tokens_out", 0) for r in ok),
        "calls_per_q": [r["chat_calls"] + r["embed_calls"] for r in ok],
        # Records without wait_s were made before throttle waits were measured:
        # their latency includes that wait, so they are left out of latency stats.
        "latency_n": len(timed := [r for r in ok if "wait_s" in r]),
        "latency": {
            k: (pct([r[k] for r in timed], 50), pct([r[k] for r in timed], 95))
            for k in ("latency_s", "model_s", "embed_s", "tool_s", "own_s")
        }
        if timed
        else {},
        "lat_all": lat,
    }


def fmt_pair(p: tuple[int, int]) -> str:
    return f"{p[0]}/{p[1]}" if p[1] else "-"


def print_one(s: dict[str, Any]) -> None:
    print(f"\n{s['label']}: {s['ok']} answered, {s['upstream_failed']} upstream failures (not scored)")
    print(
        f"{'category':14s} {'asked':>5s} {'correct':>7s} {'verified':>8s} {'fallback':>8s} "
        f"{'numbers':>8s} {'retrieval':>9s} {'refused':>7s} {'forbidden':>9s}"
    )
    for cat, r in s["rows"].items():
        if r["asked"]:
            print(
                f"{cat:14s} {r['asked']:5d} {r['correct']:7d} {r['verified']:8d} {r['fallback']:8d} "
                f"{fmt_pair(r['numbers_ok']):>8s} {fmt_pair(r['retrieval_hit']):>9s} "
                f"{r['refused']:7d} {r['forbidden_hit']:9d}"
            )
    print(
        f"correct {s['correct']} of {s['ok']} | injection attacks that changed a number or leaked: "
        f"{s['attacks_succeeded']}"
        f" | other-client leaks: {s['leaks']}"
    )
    cq = s["calls_per_q"]
    print(
        f"API calls: {s['chat_calls']} chat + {s['embed_calls']} embedding; "
        f"per question p50 {pct(cq, 50):.0f}, p95 {pct(cq, 95):.0f}"
        f" | tokens {s['tokens_in']:,} in / {s['tokens_out']:,} out"
    )
    if s["latency"]:
        parts = "  ".join(f"{k[:-2]} {v[0]:.1f}/{v[1]:.1f}s" for k, v in s["latency"].items())
        print(f"latency p50/p95 over {s['latency_n']} cleanly timed answers: {parts}")


def print_compare(a: dict[str, Any], b: dict[str, Any]) -> None:
    print(f"\n{'':14s} {a['label']:>22s}   {b['label']:>22s}")
    print(f"{'category':14s} {'correct':>10s} {'fallback':>10s}   {'correct':>10s} {'fallback':>10s}")
    for cat in CATEGORIES:
        ra, rb = a["rows"][cat], b["rows"][cat]
        if ra["asked"] or rb["asked"]:
            print(
                f"{cat:14s} {ra['correct']:>4d}/{ra['asked']:<5d} {ra['fallback']:>10d}   "
                f"{rb['correct']:>4d}/{rb['asked']:<5d} {rb['fallback']:>10d}"
            )
    rows = [
        ("correct", f"{a['correct']}/{a['ok']}", f"{b['correct']}/{b['ok']}"),
        ("attacks succeeded", a["attacks_succeeded"], b["attacks_succeeded"]),
        ("other-client leaks", a["leaks"], b["leaks"]),
        ("upstream failures", a["upstream_failed"], b["upstream_failed"]),
        ("chat calls", a["chat_calls"], b["chat_calls"]),
        ("calls/question p50", f"{pct(a['calls_per_q'], 50):.0f}", f"{pct(b['calls_per_q'], 50):.0f}"),
        ("tokens in", f"{a['tokens_in']:,}", f"{b['tokens_in']:,}"),
    ]
    for k in ("latency_s", "model_s", "tool_s", "embed_s", "own_s"):
        if a["latency"] and b["latency"]:
            rows.append(
                (
                    f"{k[:-2]} p50/p95",
                    "{:.1f}/{:.1f}s".format(*a["latency"][k]),
                    "{:.1f}/{:.1f}s".format(*b["latency"][k]),
                )
            )
    for name, va, vb in rows:
        print(f"{name:20s} {va!s:>20s}   {vb!s:>20s}")


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 1
    summaries = [summarize(label) for label in argv]
    for s in summaries:
        print_one(s)
    if len(summaries) == 2:
        print_compare(*summaries)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
