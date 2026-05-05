#!/usr/bin/env python3
"""
Mutation-test runner for Fission Protocol.

For each Gambit-generated mutant:
  1. Snapshot the original source file.
  2. Overwrite the original with the mutant.
  3. Run `forge test --no-match-path "test/fork/*" --silent`.
  4. Restore the original.
  5. Record killed (tests failed) or survived (tests passed).

Outputs a JSON + markdown summary under audits/mutation/.

Usage:
  python3 audits/mutation/run_mutation_tests.py [--gambit-out PATH]
"""
from __future__ import annotations
import argparse, json, os, shutil, subprocess, sys, time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO_ROOT / "audits/mutation/gambit-out"
RESULTS_DIR = REPO_ROOT / "audits/mutation"
FORGE = os.environ.get("FORGE", str(Path.home() / ".foundry/bin/forge"))


def run_forge() -> tuple[bool, str]:
    """Run forge test, return (passed, tail-of-output)."""
    try:
        proc = subprocess.run(
            [FORGE, "test", "--no-match-path", "test/fork/*"],
            cwd=REPO_ROOT / "contracts",
            capture_output=True, text=True, timeout=600,
        )
    except subprocess.TimeoutExpired:
        return False, "TIMEOUT"
    out = (proc.stdout + proc.stderr)[-300:]
    return proc.returncode == 0, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gambit-out", type=Path, action="append", default=None,
                    help="Gambit output directory (repeatable for multiple targets)")
    args = ap.parse_args()
    if not args.gambit_out:
        args.gambit_out = [DEFAULT_OUT]

    mutants = []
    for d in args.gambit_out:
        results_path = d / "gambit_results.json"
        if not results_path.exists():
            print(f"FATAL: gambit_results.json not found at {results_path}", file=sys.stderr)
            sys.exit(2)
        chunk = json.loads(results_path.read_text())
        for m in chunk:
            m["_source_dir"] = str(d)
        mutants.extend(chunk)
        print(f"Loaded {len(chunk)} mutants from {results_path}")
    print(f"Total mutants: {len(mutants)}")

    by_file: dict[str, list[dict]] = {}
    for m in mutants:
        by_file.setdefault(m["original"], []).append(m)

    # Baseline: original suite must be green before we trust kill signals.
    print("Baseline: running forge test on unmutated tree…")
    t0 = time.time()
    baseline_pass, baseline_tail = run_forge()
    print(f"  baseline: {'PASS' if baseline_pass else 'FAIL'} ({time.time()-t0:.1f}s)")
    if not baseline_pass:
        print("FATAL: baseline test suite failed. Fix before mutation testing.")
        print(baseline_tail)
        sys.exit(1)

    log_lines: list[dict] = []
    started = time.time()

    for fname, ms in by_file.items():
        print(f"\n=== {fname} ({len(ms)} mutants) ===")
        original_path = REPO_ROOT / fname
        backup = original_path.read_bytes()
        try:
            for i, m in enumerate(ms, 1):
                mutant_src = Path(m["_source_dir"]) / m["name"]
                if not mutant_src.exists():
                    print(f"  [{i}/{len(ms)}] mutant#{m['id']} missing artifact, skipping")
                    continue
                original_path.write_bytes(mutant_src.read_bytes())
                t = time.time()
                passed, tail = run_forge()
                elapsed = time.time() - t
                killed = not passed
                print(f"  [{i}/{len(ms)}] mutant#{m['id']:>4} {m['description']:<35} "
                      f"{'KILLED' if killed else 'SURVIVED':>9} ({elapsed:.0f}s)")
                log_lines.append({
                    "file": fname,
                    "id": m["id"],
                    "description": m["description"],
                    "killed": killed,
                    "elapsed_s": round(elapsed, 1),
                    "tail": tail if not killed else "",
                })
        finally:
            original_path.write_bytes(backup)

    total_elapsed = time.time() - started

    # Aggregate
    summary = {}
    for fname in by_file:
        f_log = [l for l in log_lines if l["file"] == fname]
        killed = sum(1 for l in f_log if l["killed"])
        summary[fname] = {
            "mutants_run": len(f_log),
            "killed": killed,
            "survived": len(f_log) - killed,
            "kill_rate_percent": round(100 * killed / max(1, len(f_log)), 1),
        }

    overall_killed = sum(s["killed"] for s in summary.values())
    overall_total  = sum(s["mutants_run"] for s in summary.values())

    out = {
        "ran_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "total_elapsed_s": round(total_elapsed, 1),
        "overall": {
            "mutants_run": overall_total,
            "killed": overall_killed,
            "survived": overall_total - overall_killed,
            "kill_rate_percent": round(100 * overall_killed / max(1, overall_total), 1),
        },
        "by_file": summary,
        "details": log_lines,
    }

    json_path = RESULTS_DIR / "mutation-results.json"
    md_path   = RESULTS_DIR / "mutation-results.md"
    json_path.write_text(json.dumps(out, indent=2))

    md_lines = [
        "# Mutation testing results",
        "",
        f"Ran at: `{out['ran_at']}` — total elapsed `{out['total_elapsed_s']}s`",
        "",
        f"**Overall:** {overall_killed}/{overall_total} killed "
        f"({out['overall']['kill_rate_percent']}%)",
        "",
        "## By file",
        "",
        "| File | Mutants | Killed | Survived | Kill % |",
        "|------|--------:|-------:|---------:|-------:|",
    ]
    for fname, s in summary.items():
        md_lines.append(
            f"| `{fname}` | {s['mutants_run']} | {s['killed']} | {s['survived']} | {s['kill_rate_percent']} |"
        )
    md_lines += [
        "",
        "## Survived mutants",
        "",
        "Mutants that survived (tests still passed despite the change) reveal coverage gaps. Each survived mutant should be reviewed: either the mutation is semantically equivalent, or a new test is needed.",
        "",
    ]
    survivors = [l for l in log_lines if not l["killed"]]
    if not survivors:
        md_lines.append("_None — every mutant was killed._")
    else:
        for l in survivors:
            md_lines += [
                f"### `{l['file']}` mutant #{l['id']} — {l['description']}",
                "",
                "_Test suite still passed with this mutation applied. Review the diff in_ "
                f"`audits/mutation/gambit-out/mutants/{l['id']}/{l['file']}` _and either add a test that catches it, or annotate as semantically-equivalent._",
                "",
            ]
    md_path.write_text("\n".join(md_lines))

    print(f"\nWrote {json_path}\n      {md_path}")
    print(f"Overall kill rate: {out['overall']['kill_rate_percent']}%")


if __name__ == "__main__":
    main()
