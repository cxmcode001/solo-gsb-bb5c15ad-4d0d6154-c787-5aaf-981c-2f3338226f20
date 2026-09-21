"""End-to-end API tests using FastAPI's TestClient against a temp SQLite DB."""
import os
import tempfile
import unittest

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["AGENDA_DB"] = _tmp.name

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        cls.client.__enter__()  # trigger lifespan -> init_db

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)
        os.unlink(_tmp.name)

    def setUp(self):
        # fresh meeting per test
        r = self.client.post("/api/meetings", json={
            "title": "测试会议",
            "start_time": "2026-09-21T09:00",
            "end_time": "2026-09-21T10:00",
        })
        self.assertEqual(r.status_code, 201)
        self.mid = r.json()["id"]

    def add_item(self, title, planned, minimum, priority=3, incompressible=False):
        r = self.client.post(f"/api/meetings/{self.mid}/items", json={
            "title": title, "planned_minutes": planned,
            "minimum_minutes": minimum, "priority": priority,
            "incompressible": incompressible,
        })
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    def add_break(self, start, duration, title="茶歇"):
        r = self.client.post(f"/api/meetings/{self.mid}/breaks", json={
            "title": title, "fixed_start": start, "duration_minutes": duration,
        })
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    def test_meeting_validation(self):
        r = self.client.post("/api/meetings", json={
            "title": "x", "start_time": "2026-09-21T10:00",
            "end_time": "2026-09-21T09:00",
        })
        self.assertEqual(r.status_code, 422)

    def test_item_validation(self):
        r = self.client.post(f"/api/meetings/{self.mid}/items", json={
            "title": "bad", "planned_minutes": 10, "minimum_minutes": 20})
        self.assertEqual(r.status_code, 422)

    def test_plan_endpoint_structure(self):
        self.add_item("开场", 10, 5, priority=5)
        self.add_item("讨论", 30, 10, priority=2)
        self.add_break("2026-09-21T09:30", 10)
        r = self.client.get(f"/api/meetings/{self.mid}")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertFalse(data["live"])
        self.assertEqual(len(data["original"]["segments"]), 3)
        self.assertIn("current", data)

    def test_record_actual_triggers_compression_and_conflict(self):
        a = self.add_item("A", 20, 10, priority=5)
        b = self.add_item("B", 25, 5, priority=1)
        c = self.add_item("C", 20, 10, priority=5)
        # A finishes 35 minutes late at 09:35
        r = self.client.post(f"/api/meetings/{self.mid}/actuals", json={
            "item_id": a, "actual_end": "2026-09-21T09:35"})
        self.assertEqual(r.status_code, 200, r.text)
        data = r.json()
        self.assertTrue(data["live"])
        segs = {s["id"]: s for s in data["current"]["segments"] if s["kind"] == "item"}
        self.assertEqual(segs[b]["duration"], 5)
        self.assertEqual(segs[b]["status"], "compressed")
        self.assertEqual(segs[c]["duration"], 20)
        self.assertEqual(data["current"]["planned_end"], "2026-09-21T10:00")
        self.assertEqual(data["current"]["conflicts"], [])

    def test_overflow_conflict_reports_minutes(self):
        r = self.client.post("/api/meetings", json={
            "title": "短会", "start_time": "2026-09-21T09:00",
            "end_time": "2026-09-21T09:30"})
        mid = r.json()["id"]
        a = self.client.post(f"/api/meetings/{mid}/items", json={
            "title": "A", "planned_minutes": 10, "minimum_minutes": 5}).json()["id"]
        self.client.post(f"/api/meetings/{mid}/items", json={
            "title": "B", "planned_minutes": 20, "minimum_minutes": 20,
            "priority": 1, "incompressible": True})
        r = self.client.post(f"/api/meetings/{mid}/actuals", json={
            "item_id": a, "actual_end": "2026-09-21T09:20"})
        data = r.json()
        conflicts = data["current"]["conflicts"]
        self.assertTrue(any(x["type"] == "overflow" and x["overflow_minutes"] == 10
                            for x in conflicts))

    def test_ordered_recording_required(self):
        a = self.add_item("A", 10, 5)
        b = self.add_item("B", 10, 5)
        r = self.client.post(f"/api/meetings/{self.mid}/actuals", json={
            "item_id": b, "actual_end": "2026-09-21T09:10"})
        self.assertEqual(r.status_code, 409)
        # A first -> ok
        r = self.client.post(f"/api/meetings/{self.mid}/actuals", json={
            "item_id": a, "actual_end": "2026-09-21T09:10"})
        self.assertEqual(r.status_code, 200)

    def test_undo_restores_plan(self):
        a = self.add_item("A", 20, 10)
        self.add_item("B", 20, 10)
        self.client.post(f"/api/meetings/{self.mid}/actuals", json={
            "item_id": a, "actual_end": "2026-09-21T09:25"})
        r = self.client.post(f"/api/meetings/{self.mid}/undo")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertFalse(data["live"])
        self.assertEqual(data["undo_count"], 0)
        # undo again -> 404
        r = self.client.post(f"/api/meetings/{self.mid}/undo")
        self.assertEqual(r.status_code, 404)

    def test_reset_is_undoable(self):
        a = self.add_item("A", 20, 10)
        self.client.post(f"/api/meetings/{self.mid}/actuals", json={
            "item_id": a, "actual_end": "2026-09-21T09:25"})
        r = self.client.post(f"/api/meetings/{self.mid}/reset")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["live"])
        r = self.client.post(f"/api/meetings/{self.mid}/undo")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["live"])

    def test_fixed_break_overlap_rejected(self):
        self.add_break("2026-09-21T09:30", 20)
        r = self.client.post(f"/api/meetings/{self.mid}/breaks", json={
            "title": "另一个", "fixed_start": "2026-09-21T09:40",
            "duration_minutes": 10})
        self.assertEqual(r.status_code, 422)

    def test_editing_blocked_while_live(self):
        a = self.add_item("A", 20, 10)
        self.client.post(f"/api/meetings/{self.mid}/actuals", json={
            "item_id": a, "actual_end": "2026-09-21T09:25"})
        self.assertEqual(self.client.post(
            f"/api/meetings/{self.mid}/items",
            json={"title": "X", "planned_minutes": 5, "minimum_minutes": 5}
        ).status_code, 409)
        self.assertEqual(self.client.delete(f"/api/items/{a}").status_code, 409)

    def test_move_item(self):
        a = self.add_item("A", 10, 5)
        b = self.add_item("B", 10, 5)
        r = self.client.post(f"/api/items/{b}/move", json={"direction": "up"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual([it["id"] for it in r.json()], [b, a])

    # ------------------------------------------------------------------
    # postponement suggestions
    # ------------------------------------------------------------------

    def _make_overflowing_live_meeting(self):
        """09:00-10:00; A done at 09:35 (25 min left). Pending:
        B(30/10,P1) + C(25/25,P5,incompressible) -> floors 35 > 25."""
        a = self.add_item("A", 20, 10, priority=5)
        b = self.add_item("B", 30, 10, priority=1)
        c = self.add_item("C", 25, 25, priority=5, incompressible=True)
        r = self.client.post(f"/api/meetings/{self.mid}/actuals", json={
            "item_id": a, "actual_end": "2026-09-21T09:35"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(any(x["overflow_minutes"] > 0
                            for x in r.json()["current"]["conflicts"]))
        return a, b, c

    def test_suggestion_previews_without_writing(self):
        _, b, _ = self._make_overflowing_live_meeting()
        r = self.client.post(f"/api/meetings/{self.mid}/postpone-suggestion")
        self.assertEqual(r.status_code, 200, r.text)
        s = r.json()
        self.assertTrue(s["feasible"])
        self.assertEqual([p["id"] for p in s["postponed"]], [b])
        self.assertEqual(s["remaining_overflow_minutes"], 0)
        # trial timeline no longer contains the postponed item
        seg_ids = {seg["id"] for seg in s["timeline"]["segments"]}
        self.assertNotIn(b, seg_ids)
        # nothing persisted yet
        plan = self.client.get(f"/api/meetings/{self.mid}").json()
        self.assertTrue(all(not it["postponed"] for it in plan["items"]))
        self.assertTrue(any(x["overflow_minutes"] > 0
                            for x in plan["current"]["conflicts"]))

    def test_confirm_postpones_atomically_and_is_undoable(self):
        _, b, c = self._make_overflowing_live_meeting()
        undo_before = self.client.get(f"/api/meetings/{self.mid}").json()["undo_count"]
        r = self.client.post(f"/api/meetings/{self.mid}/postpone",
                             json={"item_ids": [b]})
        self.assertEqual(r.status_code, 200, r.text)
        plan = r.json()
        items = {it["id"]: it for it in plan["items"]}
        self.assertEqual(items[b]["postponed"], 1)
        self.assertEqual(items[c]["postponed"], 0)
        # immediately re-scheduled: postponed item gone from both timelines,
        # conflicts cleared
        for tl in ("original", "current"):
            self.assertNotIn(b, {s["id"] for s in plan[tl]["segments"]})
        self.assertEqual(plan["current"]["conflicts"], [])
        self.assertEqual(plan["undo_count"], undo_before + 1)
        # undo restores the postponed item (and the conflict)
        r = self.client.post(f"/api/meetings/{self.mid}/undo")
        self.assertEqual(r.status_code, 200)
        plan = r.json()
        items = {it["id"]: it for it in plan["items"]}
        self.assertEqual(items[b]["postponed"], 0)
        self.assertTrue(any(x["overflow_minutes"] > 0
                            for x in plan["current"]["conflicts"]))

    def test_confirm_rejects_stale_or_wrong_item_set(self):
        _, b, _ = self._make_overflowing_live_meeting()
        r = self.client.post(f"/api/meetings/{self.mid}/postpone",
                             json={"item_ids": [999]})
        self.assertEqual(r.status_code, 409)
        plan = self.client.get(f"/api/meetings/{self.mid}").json()
        self.assertTrue(all(not it["postponed"] for it in plan["items"]))

    def test_infeasible_suggestion_cannot_be_confirmed(self):
        # B is the only postponable item; removing it still leaves C (25 min,
        # incompressible) overflowing the 25-minute remainder... use a tighter
        # meeting: C needs 25 but only 20 remain after A ends at 09:40.
        a = self.add_item("A", 20, 10, priority=5)
        b = self.add_item("B", 10, 5, priority=1)
        c = self.add_item("C", 25, 25, priority=5, incompressible=True)
        self.client.post(f"/api/meetings/{self.mid}/actuals", json={
            "item_id": a, "actual_end": "2026-09-21T09:40"})
        r = self.client.post(f"/api/meetings/{self.mid}/postpone-suggestion")
        s = r.json()
        self.assertFalse(s["feasible"])
        self.assertEqual([p["id"] for p in s["postponed"]], [b])
        self.assertEqual(s["remaining_overflow_minutes"], 5)
        r = self.client.post(f"/api/meetings/{self.mid}/postpone",
                             json={"item_ids": [b]})
        self.assertEqual(r.status_code, 409)
        plan = self.client.get(f"/api/meetings/{self.mid}").json()
        self.assertTrue(all(not it["postponed"] for it in plan["items"]))

    def test_postponed_items_are_skipped_by_recording_order(self):
        _, b, c = self._make_overflowing_live_meeting()
        self.client.post(f"/api/meetings/{self.mid}/postpone",
                         json={"item_ids": [b]})
        # recording the postponed item itself is rejected
        r = self.client.post(f"/api/meetings/{self.mid}/actuals", json={
            "item_id": b, "actual_end": "2026-09-21T09:50"})
        self.assertEqual(r.status_code, 409)
        # C may be recorded even though B (earlier in order) has no actual_end
        r = self.client.post(f"/api/meetings/{self.mid}/actuals", json={
            "item_id": c, "actual_end": "2026-09-21T10:00"})
        self.assertEqual(r.status_code, 200, r.text)

    def test_suggestion_works_before_going_live(self):
        # 60 planned minutes in a 60-minute meeting is fine; add 20 more -> overflow
        self.add_item("A", 40, 20, priority=5)
        b = self.add_item("B", 40, 20, priority=1)
        r = self.client.post(f"/api/meetings/{self.mid}/postpone-suggestion")
        s = r.json()
        self.assertTrue(s["feasible"])
        self.assertEqual([p["id"] for p in s["postponed"]], [b])
        r = self.client.post(f"/api/meetings/{self.mid}/postpone",
                             json={"item_ids": [b]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["original"]["conflicts"], [])


if __name__ == "__main__":
    unittest.main()
