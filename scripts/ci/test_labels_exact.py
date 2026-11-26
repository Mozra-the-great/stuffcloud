#!/usr/bin/env python3
"""Exact tests of labels.py: the defaults of every optional config key, the planned actions of a
sync, and the `gh` calls of every subcommand.

`test_labels.py` pins the decisions on the real label config. This file uses small configs (a
missing key must fall back to "nothing", never fail) and replaces `gh`, so that every command line
and every printed line of the GitHub side is asserted without a network.

    python3 -m unittest discover -s scripts/ci -p "test_*.py"
"""
from __future__ import annotations

import contextlib
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import labels as lbl  # noqa: E402


class FakeGh:
    """Stands in for `lbl.gh`: records every call and answers from a function."""

    def __init__(self, answer) -> None:
        self.answer = answer
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, *args: str) -> str:
        self.calls.append(args)
        return self.answer(args)


def run_printing(function, *args, **kwargs) -> str:
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        function(*args, **kwargs)
    return out.getvalue()


class ConfigTests(unittest.TestCase):
    def test_the_config_is_read_as_utf8(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "labels.json"
            path.write_text(json.dumps({"labels": [{"name": "café"}]}), encoding="utf-8")
            real = pathlib.Path.read_text
            seen: list[object] = []

            def spy(self_path, *args, **kwargs):
                seen.append(kwargs.get("encoding"))
                return real(self_path, *args, **kwargs)

            with mock.patch.object(pathlib.Path, "read_text", spy):
                self.assertEqual(lbl.load_config(path), {"labels": [{"name": "café"}]})
        self.assertEqual(seen, ["utf-8"])

    def test_the_default_config_is_the_one_in_the_repository(self) -> None:
        self.assertEqual(lbl.CONFIG, lbl.REPO / ".github" / "labels.json")
        self.assertEqual(lbl.TRIAGE, "status/triage")


class OptionalKeyTests(unittest.TestCase):
    def test_a_title_without_a_known_prefix_or_scope_gets_nothing(self) -> None:
        self.assertEqual(lbl.labels_for_title("zzz(ci): x", {}), set())
        self.assertEqual(lbl.labels_for_title("zzz(ci): x", {}, None), set())
        self.assertEqual(lbl.labels_for_title("zzz: x", {"fix": ["a"]}, {"ci": ["b"]}), set())
        self.assertEqual(lbl.labels_for_title("fix: x", {"fix": ["a"]}, {"ci": ["b"]}), {"a"})
        self.assertEqual(lbl.labels_for_title("FIX(CI, Docs)!: x", {"fix": ["a"]}, {"ci": ["b"], "docs": ["c"]}), {"a", "b", "c"})
        self.assertEqual(lbl.labels_for_title("fix(a/b c): x", {}, {"a": ["1"], "b": ["2"], "c": ["3"]}), {"1", "2", "3"})
        self.assertEqual(lbl.labels_for_title("fix(): x", {"fix": ["a"]}, {"": ["z"]}), {"a"})

    def test_an_issue_title_works_with_an_empty_config(self) -> None:
        for title in ("[CI] x", "[a/b] x", "Bug; x", "fix(ci): x", "plain"):
            with self.subTest(title):
                self.assertEqual(lbl.labels_for_issue_title(title, {}), set())

    def test_an_unknown_tag_is_ignored_among_known_ones(self) -> None:
        config = {"issue_tags": {"ci": ["area/ci"]}}
        self.assertEqual(lbl.labels_for_issue_title("[zzz/CI] x", config), {"area/ci"})
        self.assertEqual(lbl.labels_for_issue_title("[zzz] x", config), set())

    def test_title_words_prefixes_and_scopes_default_to_nothing_independently(self) -> None:
        self.assertEqual(lbl.labels_for_issue_title("Bug; x", {"title_words": {"bug": ["t"]}}), {"t"})
        self.assertEqual(lbl.labels_for_issue_title("fix: x", {"title_prefixes": {"fix": ["t"]}}), {"t"})
        self.assertEqual(
            lbl.labels_for_issue_title("fix(ci): x", {"title_prefixes": {"fix": ["t"]}, "title_scopes": {"ci": ["s"]}}),
            {"t", "s"},
        )
        self.assertEqual(lbl.labels_for_issue_title("fix(ci): x", {"title_prefixes": {"fix": ["t"]}}), {"t"})

    def test_a_pr_inherits_nothing_without_inherit_prefixes(self) -> None:
        self.assertEqual(lbl.inherited_labels({"prio/high", "type/bug"}, {}), set())
        self.assertEqual(lbl.inherited_labels({"prio/high", "type/bug", "status/x"}, {"inherit_prefixes": ["prio/", "type/"]}), {"prio/high", "type/bug"})
        self.assertEqual(lbl.inherited_labels(set(), {"inherit_prefixes": ["prio/"]}), set())

    def test_pr_labels_combine_paths_title_scope_docs_and_inheritance(self) -> None:
        config = {
            "labels": [{"name": n} for n in ("area/ci", "type/bug", "type/docs", "area/docs", "prio/high")],
            "paths": {"scripts/**": ["area/ci"], "*.md": ["area/docs"]},
            "title_prefixes": {"fix": ["type/bug"]},
            "title_scopes": {"docs": ["area/docs"]},
            "inherit_prefixes": ["prio/"],
        }
        self.assertEqual(
            lbl.pr_labels("fix(docs): x", ["scripts/a.py"], config, {"prio/high", "status/triage"}),
            {"area/ci", "type/bug", "area/docs", "prio/high"},
        )
        # Without a title_scopes key the scope is simply not known.
        del config["title_scopes"]
        self.assertEqual(lbl.pr_labels("fix(docs): x", ["scripts/a.py"], config), {"area/ci", "type/bug"})
        # Labels from the issues are added to those from the paths, never instead of them.
        self.assertEqual(lbl.pr_labels("x", ["README.md"], config, {"prio/high"}), {"area/docs", "type/docs", "prio/high"})

    def test_a_status_label_alone_triages_an_open_issue(self) -> None:
        exists = {lbl.TRIAGE, "status/blocked", "prio/low"}
        self.assertEqual(lbl.issue_final_labels(set(), {"status/blocked"}, exists, True), set())
        self.assertEqual(lbl.issue_final_labels(set(), {"prio/low"}, exists, True), set())
        self.assertEqual(lbl.issue_final_labels(set(), {"other"}, exists, True), {lbl.TRIAGE})
        self.assertEqual(lbl.issue_final_labels({"status/blocked"}, set(), exists, True), {"status/blocked"})


class PlanSyncTests(unittest.TestCase):
    def test_a_label_without_description_and_color_defaults(self) -> None:
        self.assertEqual(lbl.plan_sync({"a": {"color": "ffffff", "description": ""}}, [{"name": "a", "color": "ffffff"}]), [])
        self.assertEqual(lbl.plan_sync({"a": {"color": "ffffff", "description": None}}, [{"name": "a", "color": "ffffff"}]), [])
        self.assertEqual(
            lbl.plan_sync({"a": {"color": "000000", "description": ""}}, [{"name": "a", "color": "ffffff"}]),
            [("update", "a", "a", "ffffff", "")],
        )
        self.assertEqual(
            lbl.plan_sync({"a": {"color": "ffffff"}}, [{"name": "a", "color": "ffffff", "description": "d"}]),
            [("update", "a", "a", "ffffff", "d")],
        )
        self.assertEqual(
            lbl.plan_sync({"a": {"color": "FFFFFF", "description": "d"}}, [{"name": "a", "color": "ffffff", "description": "d"}]),
            [],
        )

    def test_a_missing_label_is_created_with_all_its_fields(self) -> None:
        self.assertEqual(
            lbl.plan_sync({}, [{"name": "New", "color": "ABCDEF", "description": "d"}]),
            [("create", "New", "abcdef", "d")],
        )
        self.assertEqual(lbl.plan_sync({}, [{"name": "New", "color": "abcdef"}]), [("create", "New", "abcdef", "")])

    def test_a_case_difference_in_the_name_is_an_update(self) -> None:
        self.assertEqual(
            lbl.plan_sync({"bug": {"color": "ffffff", "description": ""}}, [{"name": "Bug", "color": "ffffff"}]),
            [("update", "bug", "Bug", "ffffff", "")],
        )

    def test_an_unchanged_label_does_not_stop_the_plan(self) -> None:
        wanted = [{"name": "a", "color": "ffffff"}, {"name": "b", "color": "000000"}]
        self.assertEqual(lbl.plan_sync({"a": {"color": "ffffff", "description": ""}}, wanted), [("create", "b", "000000", "")])

    def test_a_label_created_earlier_can_be_the_alias_of_a_later_one(self) -> None:
        wanted = [{"name": "a", "color": "111111"}, {"name": "b", "color": "222222", "aliases": ["A"]}]
        self.assertEqual(
            lbl.plan_sync({}, wanted),
            [("create", "a", "111111", ""), ("rename", "a", "b", "222222", "")],
        )

    def test_a_renamed_alias_is_gone_for_later_labels(self) -> None:
        wanted = [
            {"name": "b", "color": "222222", "aliases": ["old"]},
            {"name": "c", "color": "333333", "aliases": ["old"]},
        ]
        self.assertEqual(
            lbl.plan_sync({"old": {"color": "000000", "description": ""}}, wanted),
            [("rename", "old", "b", "222222", ""), ("create", "c", "333333", "")],
        )

    def test_aliases_are_matched_in_any_case_and_keep_the_existing_spelling(self) -> None:
        self.assertEqual(
            lbl.plan_sync({"Old Name": {"color": "000000", "description": ""}}, [{"name": "new", "color": "111111", "aliases": ["old name"]}]),
            [("rename", "Old Name", "new", "111111", "")],
        )


class GhTests(unittest.TestCase):
    def test_gh_runs_the_cli_and_returns_stdout(self) -> None:
        done = subprocess.CompletedProcess([], 0, stdout="out", stderr="")
        with mock.patch.object(lbl.subprocess, "run", return_value=done) as run:
            self.assertEqual(lbl.gh("label", "list"), "out")
        run.assert_called_once_with(["gh", "label", "list"], check=True, text=True, capture_output=True, encoding="utf-8")

    def test_a_failing_gh_raises(self) -> None:
        with mock.patch.object(lbl.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "gh")):
            with self.assertRaises(subprocess.CalledProcessError):
                lbl.gh("x")


class SyncCommandTests(unittest.TestCase):
    def test_sync_creates_renames_and_updates_through_gh(self) -> None:
        existing = [
            {"name": "bug", "color": "ffffff", "description": ""},
            {"name": "same", "color": "000000", "description": "d"},
            {"name": "Upd", "color": "111111", "description": "old"},
        ]
        fake = FakeGh(lambda args: json.dumps(existing) if args[:2] == ("label", "list") else "")
        config = {
            "labels": [
                {"name": "type/bug", "color": "D73A4A", "description": "Broken", "aliases": ["bug"]},
                {"name": "same", "color": "000000", "description": "d"},
                {"name": "Upd", "color": "222222", "description": "new"},
                {"name": "brand-new", "color": "333333", "description": "n"},
            ]
        }
        with mock.patch.object(lbl, "gh", fake):
            printed = run_printing(lbl.cmd_sync, config)
        self.assertEqual(
            fake.calls,
            [
                ("label", "list", "--limit", "1000", "--json", "name,color,description"),
                ("label", "edit", "bug", "--name", "type/bug", "--color", "d73a4a", "--description", "Broken"),
                ("label", "edit", "Upd", "--name", "Upd", "--color", "222222", "--description", "new"),
                ("label", "create", "brand-new", "--color", "333333", "--description", "n"),
            ],
        )
        self.assertEqual(printed, "rename: bug -> type/bug\nupdate: Upd -> Upd\ncreate: brand-new\n")

    def test_sync_with_nothing_to_do_prints_nothing(self) -> None:
        fake = FakeGh(lambda args: json.dumps([{"name": "a", "color": "ffffff", "description": ""}]))
        with mock.patch.object(lbl, "gh", fake):
            self.assertEqual(run_printing(lbl.cmd_sync, {"labels": [{"name": "a", "color": "ffffff"}]}), "")
        self.assertEqual(len(fake.calls), 1)


class AddLabelsTests(unittest.TestCase):
    def test_labels_are_posted_sorted_through_the_rest_api(self) -> None:
        fake = FakeGh(lambda args: "")
        with mock.patch.object(lbl, "gh", fake):
            printed = run_printing(lbl.add_labels, "pr", "7", {"b/x", "a/y"})
        self.assertEqual(
            fake.calls,
            [("api", "--method", "POST", "repos/{owner}/{repo}/issues/7/labels", "-f", "labels[]=a/y", "-f", "labels[]=b/x")],
        )
        self.assertEqual(printed, "pr #7: a/y, b/x\n")

    def test_no_labels_means_no_call(self) -> None:
        fake = FakeGh(lambda args: "")
        with mock.patch.object(lbl, "gh", fake):
            printed = run_printing(lbl.add_labels, "issue", "3", set())
        self.assertEqual(fake.calls, [])
        self.assertEqual(printed, "issue #3: (nothing)\n")

    def test_existing_labels(self) -> None:
        fake = FakeGh(lambda args: json.dumps([{"name": "a"}, {"name": "b"}]))
        with mock.patch.object(lbl, "gh", fake):
            self.assertEqual(lbl.existing_labels(), {"a", "b"})
        self.assertEqual(fake.calls, [("label", "list", "--limit", "1000", "--json", "name")])


CONFIG = {
    "labels": [{"name": n} for n in ("area/ci", "type/ci", "prio/high", "type/bug", lbl.TRIAGE)],
    "paths": {"scripts/ci/**": ["area/ci", "type/ci"]},
    "title_prefixes": {"fix": ["type/bug"]},
    "inherit_prefixes": ["prio/"],
    "issue_tags": {"ci": ["area/ci"]},
}


class PrCommandTests(unittest.TestCase):
    def fake(self, view: dict, issues: dict[str, dict] | None = None) -> FakeGh:
        def answer(args: tuple[str, ...]) -> str:
            if args[:2] == ("pr", "view"):
                return json.dumps(view)
            if args[:2] == ("issue", "view"):
                return json.dumps((issues or {})[args[2]])
            return ""

        return FakeGh(answer)

    def test_a_pr_gets_the_labels_of_its_paths_title_and_closed_issues(self) -> None:
        fake = self.fake(
            {
                "title": "fix: x",
                "files": [{"path": "scripts/ci/labels.py"}],
                "labels": [{"name": "type/ci"}],
                "closingIssuesReferences": [{"number": 12}, {"number": 13}],
            },
            {"12": {"labels": [{"name": "prio/high"}]}, "13": {"labels": [{"name": "status/triage"}]}},
        )
        with mock.patch.object(lbl, "gh", fake):
            printed = run_printing(lbl.cmd_pr, CONFIG, "5", {"area/ci", "type/ci", "type/bug", "prio/high"})
        self.assertEqual(
            fake.calls,
            [
                ("pr", "view", "5", "--json", "title,files,labels,closingIssuesReferences"),
                ("issue", "view", "12", "--json", "labels"),
                ("issue", "view", "13", "--json", "labels"),
                ("api", "--method", "POST", "repos/{owner}/{repo}/issues/5/labels", "-f", "labels[]=area/ci",
                 "-f", "labels[]=prio/high", "-f", "labels[]=type/bug"),
            ],
        )
        self.assertEqual(printed, "pr #5: area/ci, prio/high, type/bug\n")

    def test_a_bare_pr_view_is_enough(self) -> None:
        fake = self.fake({"title": "x"})
        with mock.patch.object(lbl, "gh", fake):
            printed = run_printing(lbl.cmd_pr, CONFIG, "6", {lbl.TRIAGE})
        self.assertEqual(printed, "pr #6: status/triage\n")
        self.assertEqual(len(fake.calls), 2)

    def test_a_closed_issue_without_labels_adds_none(self) -> None:
        fake = self.fake({"title": "x", "closingIssuesReferences": [{"number": 4}]}, {"4": {}})
        with mock.patch.object(lbl, "gh", fake):
            self.assertEqual(run_printing(lbl.cmd_pr, CONFIG, "6", {lbl.TRIAGE}), "pr #6: status/triage\n")

    def test_a_null_list_of_closed_issues_is_fine(self) -> None:
        fake = self.fake({"title": "x", "files": [], "labels": [], "closingIssuesReferences": None})
        with mock.patch.object(lbl, "gh", fake):
            self.assertEqual(run_printing(lbl.cmd_pr, CONFIG, "6", {lbl.TRIAGE}), "pr #6: status/triage\n")

    def test_the_existing_labels_are_fetched_when_not_given(self) -> None:
        def answer(args: tuple[str, ...]) -> str:
            if args[:2] == ("pr", "view"):
                return json.dumps({"title": "fix: x"})
            if args[:2] == ("label", "list"):
                return json.dumps([{"name": "type/bug"}])
            return ""

        fake = FakeGh(answer)
        with mock.patch.object(lbl, "gh", fake):
            printed = run_printing(lbl.cmd_pr, CONFIG, "8")
        self.assertEqual(printed, "pr #8: type/bug\n")
        self.assertEqual(fake.calls[1], ("label", "list", "--limit", "1000", "--json", "name"))

    def test_a_given_set_of_existing_labels_saves_the_call(self) -> None:
        fake = self.fake({"title": "fix: x"})
        with mock.patch.object(lbl, "gh", fake):
            run_printing(lbl.cmd_pr, CONFIG, "8", {"type/bug"})
        self.assertEqual([call[0] for call in fake.calls], ["pr", "api"])


class IssueCommandTests(unittest.TestCase):
    def fake(self, view: dict) -> FakeGh:
        def answer(args: tuple[str, ...]) -> str:
            return json.dumps(view) if args[:2] == ("issue", "view") else ""

        return FakeGh(answer)

    def test_an_open_untriaged_issue_gets_its_tags_and_triage(self) -> None:
        fake = self.fake({"title": "[CI] x", "labels": [], "state": "OPEN"})
        with mock.patch.object(lbl, "gh", fake):
            printed = run_printing(lbl.cmd_issue, CONFIG, "9", {"area/ci", lbl.TRIAGE})
        self.assertEqual(fake.calls[0], ("issue", "view", "9", "--json", "title,labels,state"))
        self.assertEqual(printed, "issue #9: area/ci, status/triage\n")

    def test_an_issue_without_labels_is_untriaged(self) -> None:
        fake = self.fake({"title": "plain", "state": "OPEN"})
        with mock.patch.object(lbl, "gh", fake):
            printed = run_printing(lbl.cmd_issue, CONFIG, "9", {lbl.TRIAGE})
        self.assertEqual(printed, "issue #9: status/triage\n")

    def test_a_closed_issue_is_never_triaged(self) -> None:
        fake = self.fake({"title": "[CI] x", "labels": [], "state": "CLOSED"})
        with mock.patch.object(lbl, "gh", fake):
            printed = run_printing(lbl.cmd_issue, CONFIG, "9", {"area/ci", lbl.TRIAGE})
        self.assertEqual(printed, "issue #9: area/ci\n")

    def test_the_labels_already_set_are_not_posted_again(self) -> None:
        fake = self.fake({"title": "[CI] x", "labels": [{"name": "area/ci"}, {"name": "prio/high"}], "state": "OPEN"})
        with mock.patch.object(lbl, "gh", fake):
            printed = run_printing(lbl.cmd_issue, CONFIG, "9", {"area/ci", lbl.TRIAGE})
        self.assertEqual(printed, "issue #9: (nothing)\n")

    def test_the_existing_labels_are_fetched_when_not_given(self) -> None:
        def answer(args: tuple[str, ...]) -> str:
            if args[:2] == ("issue", "view"):
                return json.dumps({"title": "[CI] x", "labels": [], "state": "OPEN"})
            if args[:2] == ("label", "list"):
                return json.dumps([{"name": "area/ci"}])
            return ""

        fake = FakeGh(answer)
        with mock.patch.object(lbl, "gh", fake):
            printed = run_printing(lbl.cmd_issue, CONFIG, "9")
        self.assertEqual(printed, "issue #9: area/ci\n")


class ItemsAndBackfillTests(unittest.TestCase):
    def test_items_ask_for_a_paginated_listing(self) -> None:
        fake = FakeGh(lambda args: "12\ttrue\n7\tfalse\n")
        with mock.patch.object(lbl, "gh", fake):
            self.assertEqual(lbl.items(False), [(12, True), (7, False)])
            self.assertEqual(lbl.items(True), [(12, True), (7, False)])
        jq = ".[] | [.number, (.pull_request != null)] | @tsv"
        self.assertEqual(
            fake.calls,
            [
                ("api", "--paginate", "repos/{owner}/{repo}/issues?state=open&per_page=100", "--jq", jq),
                ("api", "--paginate", "repos/{owner}/{repo}/issues?state=all&per_page=100", "--jq", jq),
            ],
        )

    def test_no_items(self) -> None:
        with mock.patch.object(lbl, "gh", FakeGh(lambda args: "")):
            self.assertEqual(lbl.items(False), [])

    def test_backfill_fetches_the_labels_once_and_dispatches_by_kind(self) -> None:
        calls: list[tuple] = []
        with (
            mock.patch.object(lbl, "existing_labels", return_value={"x"}) as existing,
            mock.patch.object(lbl, "items", return_value=[(1, True), (2, False), (3, True)]) as items,
            mock.patch.object(lbl, "cmd_pr", lambda *a: calls.append(("pr", *a))),
            mock.patch.object(lbl, "cmd_issue", lambda *a: calls.append(("issue", *a))),
        ):
            lbl.cmd_backfill(CONFIG, True)
        existing.assert_called_once_with()
        items.assert_called_once_with(True)
        self.assertEqual(
            calls,
            [("pr", CONFIG, "1", {"x"}), ("issue", CONFIG, "2", {"x"}), ("pr", CONFIG, "3", {"x"})],
        )


class MainTests(unittest.TestCase):
    def run_main(self, argv: list[str]) -> tuple[int, str, str, list[tuple]]:
        calls: list[tuple] = []
        out, err = io.StringIO(), io.StringIO()
        with (
            mock.patch.object(lbl, "load_config", return_value=CONFIG),
            mock.patch.object(lbl, "cmd_sync", lambda *a: calls.append(("sync", *a))),
            mock.patch.object(lbl, "cmd_pr", lambda *a: calls.append(("pr", *a))),
            mock.patch.object(lbl, "cmd_issue", lambda *a: calls.append(("issue", *a))),
            mock.patch.object(lbl, "cmd_backfill", lambda *a: calls.append(("backfill", *a))),
            contextlib.redirect_stdout(out),
            contextlib.redirect_stderr(err),
        ):
            code = lbl.main(argv)
        return code, out.getvalue(), err.getvalue(), calls

    def test_each_subcommand_gets_the_config_and_its_arguments(self) -> None:
        self.assertEqual(self.run_main(["sync"]), (0, "", "", [("sync", CONFIG)]))
        self.assertEqual(self.run_main(["pr", "5"]), (0, "", "", [("pr", CONFIG, "5")]))
        self.assertEqual(self.run_main(["issue", "6"]), (0, "", "", [("issue", CONFIG, "6")]))
        self.assertEqual(self.run_main(["backfill"]), (0, "", "", [("backfill", CONFIG, False)]))
        self.assertEqual(self.run_main(["backfill", "--all"]), (0, "", "", [("backfill", CONFIG, True)]))
        self.assertEqual(self.run_main(["backfill", "x", "--all"]), (0, "", "", [("backfill", CONFIG, True)]))

    def test_anything_else_prints_the_usage_and_fails(self) -> None:
        for argv in ([], ["nope"], ["pr"], ["issue"], ["SYNC"]):
            with self.subTest(argv):
                code, out, err, calls = self.run_main(argv)
                self.assertEqual((code, out, calls), (2, "", []))
                self.assertEqual(err, lbl.__doc__ + "\n")

    def test_the_usage_lists_the_four_subcommands(self) -> None:
        for name in ("sync", "pr <nr>", "issue <nr>", "backfill [--all]"):
            self.assertIn(name, lbl.__doc__)


if __name__ == "__main__":
    unittest.main()
