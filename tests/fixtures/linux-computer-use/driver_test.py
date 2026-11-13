"""Deterministic action-admission tests; no desktop or GI dependency."""
import io
import json
import unittest
from unittest.mock import Mock, patch
from driver import Helper, HelperError


class FreshActionTests(unittest.TestCase):
    def helper(self, outcomes):
        helper = Helper.__new__(Helper)
        helper.action_retries = 0
        observations = [
            {"stateHash": f"state-{index}", "elements": [
                {"title": "Apply fixture", "locator": [index], "actions": ["click"]}
            ]}
            for index in range(3)
        ]
        helper.observe = Mock(side_effect=observations)
        helper.act = Mock(side_effect=outcomes)
        return helper, observations

    def run_action(self, helper, **kwargs):
        return helper.act_fresh({"pid": 123}, {"kind": "click"},
            lambda row: row["title"] == "Apply fixture", **kwargs)

    @patch("driver.time.sleep")
    def test_given_stale_admission_when_retried_then_target_comes_from_new_observation(self, sleep):
        stale = HelperError({"code": "COMPUTER_STALE_OBSERVATION", "message": "changed"})
        helper, observations = self.helper([stale, {"channel": "accessibility"}])
        scope = {"name": "Apply fixture", "exact": True}
        self.assertEqual(self.run_action(helper, scope=scope), {"channel": "accessibility"})
        self.assertEqual(helper.action_retries, 1)
        self.assertEqual(helper.observe.call_args_list[0].args, ({"pid": 123}, scope))
        self.assertEqual(helper.observe.call_args_list[1].args, ({"pid": 123}, scope))
        for index, call in enumerate(helper.act.call_args_list):
            self.assertIs(call.args[0], observations[index])
            self.assertIs(call.args[2], observations[index]["elements"][0])
        sleep.assert_called_once_with(0.11)

    @patch("driver.time.sleep")
    def test_given_stable_admission_then_success_is_never_replayed(self, sleep):
        helper, _ = self.helper([{"channel": "accessibility"}])
        self.run_action(helper)
        helper.observe.assert_called_once()
        helper.act.assert_called_once()
        self.assertEqual(helper.action_retries, 0)
        sleep.assert_not_called()

    @patch("driver.time.sleep")
    def test_given_continual_stale_admissions_then_retry_budget_is_bounded(self, sleep):
        stale = HelperError({"code": "COMPUTER_STALE_OBSERVATION", "message": "changed"})
        helper, _ = self.helper([stale] * 3)
        with self.assertRaises(HelperError) as caught:
            self.run_action(helper)
        self.assertIs(caught.exception, stale)
        self.assertEqual(helper.observe.call_count, 3)
        self.assertEqual(helper.act.call_count, 3)
        self.assertEqual(helper.action_retries, 2)
        self.assertEqual(sleep.call_count, 2)

    @patch("driver.time.sleep")
    def test_given_other_or_uncertain_failure_then_action_is_never_replayed(self, sleep):
        failures = [
            HelperError({"code": "COMPUTER_ACTION_BLOCKED", "message": "refused"}),
            RuntimeError("Helper timed out: act"),
            RuntimeError("COMPUTER_STALE_OBSERVATION"),
            json.JSONDecodeError("invalid response", "", 0),
        ]
        for failure in failures:
            with self.subTest(failure=failure):
                helper, _ = self.helper([failure])
                with self.assertRaises(type(failure)) as caught:
                    self.run_action(helper)
                self.assertIs(caught.exception, failure)
                helper.act.assert_called_once()
                helper.observe.assert_called_once()
                self.assertEqual(helper.action_retries, 0)
        sleep.assert_not_called()

    def test_given_missing_or_ambiguous_target_then_no_action_is_attempted(self):
        for elements in [[], [{"title": "Apply fixture"}] * 2]:
            with self.subTest(elements=elements):
                helper, _ = self.helper([])
                helper.observe.side_effect = None
                helper.observe.return_value = {"elements": elements}
                with self.assertRaisesRegex(AssertionError, "one matching target"):
                    self.run_action(helper)
                helper.act.assert_not_called()

    def test_given_observation_failure_then_it_is_not_retried_as_action_admission(self):
        helper, _ = self.helper([])
        helper.observe.side_effect = HelperError({"code": "COMPUTER_STALE_OBSERVATION", "message": "root changed"})
        with self.assertRaises(HelperError):
            self.run_action(helper)
        helper.observe.assert_called_once()
        helper.act.assert_not_called()

    def test_given_invalid_attempt_budget_then_no_action_is_attempted(self):
        helper, _ = self.helper([])
        with self.assertRaises(ValueError):
            self.run_action(helper, max_attempts=0)
        helper.observe.assert_not_called()
        helper.act.assert_not_called()


class HelperErrorTests(unittest.TestCase):
    @patch("driver.select.select", return_value=([True], [], []))
    def test_given_helper_error_then_call_preserves_structured_code_and_runtime_error_compatibility(self, _select):
        helper = Helper.__new__(Helper)
        helper.seq, helper.calls = 0, []
        error = {"code": "COMPUTER_STALE_OBSERVATION", "message": "changed"}
        helper.process = Mock(stdin=io.StringIO(), stdout=io.StringIO(json.dumps({"error": error}) + "\n"))
        with self.assertRaises(RuntimeError) as caught:
            helper.call("act")
        self.assertIsInstance(caught.exception, HelperError)
        self.assertEqual(caught.exception.code, "COMPUTER_STALE_OBSERVATION")
        self.assertEqual(json.loads(str(caught.exception)), error)
        self.assertEqual(helper.calls[0]["command"], "act")


if __name__ == "__main__":
    unittest.main()
