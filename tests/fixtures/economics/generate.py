"""Regenerate the dashboard's economics fixtures from Athena-Backend's own routes.

SYNTHETIC / ILLUSTRATIVE. Every fixture beside this script is what Athena-Backend's
own economics routes answered, through DRF's APIClient, in a throwaway test database
that pytest-django made and dropped, for scenarios built by Athena-Backend's own test
helpers (``tests/test_economics_report.py`` ``stored``; at PR #160,
``tests/test_economics_remediation.py`` ``proposed``). No customer data, no real
tenant: every deployment, scenario and finding is made up by those helpers, and
every parameter's evidence reads "SYNTHETIC / ILLUSTRATIVE". The receipt is signed
with a key generated in memory for the run and discarded: no key is written.

Nothing in the fixtures is written by hand. The dashboard is tested against what the
backend sends, not against what somebody expected it to send.

Two backend commits, one directory each:

  ab-master-6a8f8e6/  Athena-Backend master 6a8f8e61e85e9aaf152b461bc75d816ead6fbf07
                      (steps 5, 6 and 8: the scenario, events and results routes;
                      no ROI route, whose answer is recorded as it is: 404)
  ab-pr160-f7c9f09/   Athena-Backend PR #160 head f7c9f09ed176bf9dc2d8ad2fcd1ff75466bc346f
                      (step 13, in fix: the ROI route; its fix round adds the
                      deployment-decision statement and the gross line beside the
                      retained one, which this head does not serve yet)

The ``bridge-*`` files are not a route's answer: no route serves a currency bridge
at either commit. They are ``Normalization.as_dict()`` records the backend's own
engine (``assurance/economics/engine/normalization.py``) made from its committed
synthetic snapshot (``snapshots/synthetic-fx-and-cost-index-v1.json``), the shape
the spec (section 12.6) gives the provenance chain; the dashboard renders that shape
as served and, until a route serves one, says "not served".

Usage, from a checkout of Athena-Backend at one of those commits with its CI
dependencies installed: copy this file into the checkout's ``tests/`` as
``test_zz_dashboard_economics_fixtures.py`` and run it there with pytest, in the
environment the backend's CI gives its tests, plus ``ECON_FIXTURES_OUT`` (the output
directory) and ``ECON_FIXTURES_SHA`` (the checkout's commit). pytest loads the
backend's test configuration through the checkout's own pytest.ini; nothing else
does. Delete the copy afterwards.

Each fixture: ``{"synthetic", "backend", "scenario", "exchanges": [{"name",
"method", "path", "status", "content_type", "body"}]}``; ``body`` is the answer's
bytes as text, exactly (the report and the ROI document are canonical ASCII JSON
carrying their own digest, so a byte changed is a digest that no longer verifies).
Uuids, times and digests differ on every run; the tests read them from the files.
"""

from __future__ import annotations

import json
import os
from datetime import date
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from django.contrib.auth import get_user_model
from mythos_core import exposure_receipt as core

from assurance.economics import receipt_service
from assurance.economics.engine import normalization, snapshot
from assurance.economics.engine import scenario_simulation as ss
from assurance.economics.engine.cost_index import IndexSelector
from assurance.economics.engine.fx import FXPolicy
from assurance.economics.engine.money import Money
from assurance.economics.models import FinancialParameter, LossComponent, LossEvent, SimulationResult
from assurance.models import Deployment
from tests.test_economics_report import POISSON, QUICK, _base, _client, _parameter, _simulate, stored

try:  # PR #160 only
    from tests.test_economics_remediation import proposed
except ImportError:  # master: no remediation option, no ROI route
    proposed = None

pytestmark = pytest.mark.django_db
User = get_user_model()
SYNTHETIC = (
    "SYNTHETIC / ILLUSTRATIVE: made by Athena-Backend's own test helpers in a throwaway test database; no customer "
    "data, no real tenant, no key that outlived the run"
)
OUT = Path(os.environ.get("ECON_FIXTURES_OUT", "")) if os.environ.get("ECON_FIXTURES_OUT") else None
SHA = os.environ.get("ECON_FIXTURES_SHA", "")
MASTER = "6a8f8e61e85e9aaf152b461bc75d816ead6fbf07"
PR160 = "f7c9f09ed176bf9dc2d8ad2fcd1ff75466bc346f"
SNAPSHOT_PATH = Path(__file__).resolve().parent.parent / "assurance" / "economics" / "snapshots" / (
    "synthetic-fx-and-cost-index-v1.json")
CPI = "consumer prices, all items (SYNTHETIC)"
US_CPI = IndexSelector("SYN-CPI-US", "US", CPI, "2020-03=100", "USD")


@pytest.fixture
def people():
    return {
        "analyst": User.objects.create_user(username="ann", password="x", role="analyst"),
        "owner": User.objects.create_user(username="vic", password="x", role="viewer"),
    }


@pytest.fixture
def deployment(people):
    return Deployment.objects.create(name="payments-agent", owner=people["owner"])


def _backend() -> dict:
    assert SHA in (MASTER, PR160), f"generate from master {MASTER} or PR #160 {PR160}, not {SHA!r}"
    return {"repository": "Deltawsierra/Athena-Backend", "sha": SHA, "ref": "master" if SHA == MASTER else "pr160"}


def _exchange(name: str, client, path: str) -> dict:
    response = client.get(path)
    return {
        "name": name,
        "method": "GET",
        "path": path,
        "status": response.status_code,
        "content_type": response.get("Content-Type", ""),
        "body": response.content.decode("utf-8"),
    }


def _write(name: str, exchanges: list[dict] | None = None, **extra) -> None:
    assert OUT is not None, "set ECON_FIXTURES_OUT"
    OUT.mkdir(parents=True, exist_ok=True)
    document = {"synthetic": SYNTHETIC, "backend": _backend(), "scenario": name, **extra}
    if exchanges is not None:
        document["exchanges"] = exchanges
    (OUT / f"{name}.json").write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _routes(deployment, scenario, viewer, *names: str) -> list[dict]:
    client = _client(viewer)
    base = _base(deployment, scenario)
    paths = {"report": base + "results/", "events": base + "events/", "scenario": base, "roi": base + "roi/"}
    return [_exchange(name, client, paths[name]) for name in names]


def _with_market_value(scenario) -> None:
    """A market-value reaction beside the cash components: the share-price formula, two
    expert ranges, on the scenario's one event. SYNTHETIC."""
    event = LossEvent.objects.get(scenario=scenario)
    capitalisation = _parameter(scenario, "exposure.market_capitalisation", "money", "500000000", "800000000",
                                "1200000000", currency=event.currency)
    decline = _parameter(scenario, "exposure.price_decline", "ratio", "0.005", "0.01", "0.03")
    LossComponent.objects.create(
        loss_event=event, component_key="share-price-reaction", family="market_value",
        formula_id="share_price_reaction", formula_version=1, as_of=date(2026, 10, 6),
        cited_parameters={"market_capitalisation": str(capitalisation.uuid), "price_decline": str(decline.uuid)},
    )


def _signing(monkeypatch) -> None:
    """The engine's economics-receipt key, made in memory for this run (as the backend's
    own receipt test makes one) and never written."""
    key = Ed25519PrivateKey.generate()
    raw = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    other = Ed25519PrivateKey.generate().public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ring = core.receipt_keyring([raw], other_roles={"engine-outcome": [other]})
    monkeypatch.setattr(receipt_service, "engine_keyring", lambda: ring)
    monkeypatch.setattr(receipt_service, "engine_signer", lambda document: core.sign_receipt(document, key))


def _simulated(deployment, people, body=None, **kwargs):
    scenario = stored(deployment, people["analyst"], **kwargs)
    return scenario, _simulate(_client(people["analyst"]), deployment, scenario, body)


# Which generators a checkout defines is decided by what it serves: master has no
# remediation option (the ROI fixtures are made at PR #160), and the master fixtures
# are made at master only, so a directory always names the commit that made it.
MASTER_FIXTURES = proposed is None


if MASTER_FIXTURES:

    def test_graded_with_a_policy_a_market_value_reaction_and_a_receipt(deployment, people, monkeypatch):
        _signing(monkeypatch)
        scenario = stored(deployment, people["analyst"], policy=True, affected_source="CUSTOMER_PROVIDED")
        _with_market_value(scenario)
        answer = _simulate(_client(people["analyst"]), deployment, scenario, {"seed": 7, "policy": QUICK, "receipt": True})
        assert answer.status_code == 201, answer.content
        assert answer.json()["receipt"]["issued"] is True, answer.json()["receipt"]
        exchanges = _routes(deployment, scenario, people["owner"], "report", "events", "scenario", "roi")
        report = json.loads(exchanges[0]["body"])
        assert report["grade"] in {"A", "B", "C", "D"} and report["banner"] is None, report["banner_reason"]
        assert report["summary"]["lines"]["market_value"].get("p50") is not None
        _write("graded-usd-policy-market-value-receipt", exchanges)


    def test_graded_unknown(deployment, people):
        scenario, answer = _simulated(deployment, people, unknown=True)
        assert answer.status_code == 201, answer.content
        exchanges = _routes(deployment, scenario, people["owner"], "report", "events")
        assert json.loads(exchanges[0]["body"])["grade"] == "Unknown"
        _write("unknown-usd", exchanges)


    def test_refused(deployment, people):
        scenario, answer = _simulated(deployment, people, refused=True)
        assert answer.status_code == 201, answer.content
        exchanges = _routes(deployment, scenario, people["owner"], "report", "events")
        assert json.loads(exchanges[0]["body"])["status"] == "refused"
        _write("refused-usd", exchanges)


    def test_a_record_edited_outside_the_code(deployment, people):
        """The backend's own MEDIUM-1 repro: the record's gross P50 edited, so the stored rows
        no longer give their digest and the result is served as a refusal."""
        scenario, answer = _simulated(deployment, people)
        assert answer.status_code == 201, answer.content
        result = SimulationResult.objects.get(scenario=scenario)
        record = json.loads(json.dumps(result.record))
        record["scenario"]["gross_cash"]["p50"] = "1.00"
        SimulationResult._base_manager.filter(pk=result.pk).update(record=record)
        exchanges = _routes(deployment, scenario, people["owner"], "report")
        assert json.loads(exchanges[0]["body"])["refusal"]["code"] == "stored_row_unverified"
        _write("unverified-usd", exchanges)


    def test_a_stale_input(deployment, people):
        """A benchmark frequency past its fresh_until at the run's as-of date (records are
        append-only, so it is recorded so, never edited): the card marks it stale and the
        grade drops a step."""
        scenario = stored(deployment, people["analyst"], frequency=False, affected_source="CUSTOMER_PROVIDED")
        FinancialParameter.objects.create(
            scenario=scenario, name=ss.FREQUENCY_PARAMETER, unit="count", source_type="INDUSTRY_BENCHMARK",
            currency="", low="1", base="2", high="4", evidence_ref="SYNTHETIC / ILLUSTRATIVE: made up",
            effective_date=date(2026, 9, 1), fresh_until=date(2026, 9, 15), distribution=POISSON,
        )
        answer = _simulate(_client(people["analyst"]), deployment, scenario)
        assert answer.status_code == 201, answer.content
        exchanges = _routes(deployment, scenario, people["owner"], "report")
        card = json.loads(exchanges[0]["body"])["validity_card"]
        assert card["fields"]["data_freshness"]["stale"], card["fields"]["data_freshness"]
        _write("stale-usd", exchanges)


    @pytest.mark.parametrize("currency", ["JPY", "KWD"])
    def test_minor_units(deployment, people, currency):
        scenario, answer = _simulated(deployment, people, currency=currency, affected_source="CUSTOMER_PROVIDED")
        assert answer.status_code == 201, answer.content
        exchanges = _routes(deployment, scenario, people["owner"], "report")
        assert json.loads(exchanges[0]["body"])["currency"]["code"] == currency
        _write(f"graded-{currency.lower()}", exchanges)


    def test_currency_bridges():
        """Engine records, not a route's answer: no route serves a bridge at this commit."""
        snap = snapshot.parse_snapshot(SNAPSHOT_PATH.read_bytes())
        fx_book, index_book = snap.fx_book(), snap.index_book()
        cases = {
            "bridge-eur-normalized": (date(2020, 3, 2), "EUR", FXPolicy(("SYNTHETIC-REF",))),
            "bridge-jpy-estimated": (date(2020, 3, 2), "JPY", FXPolicy(("SYNTHETIC-REF",), missing_rate="interpolate")),
            "bridge-unavailable": (date(2020, 3, 4), "EUR", FXPolicy(("SYNTHETIC-REF",))),
        }
        for name, (event_date, reporting, rules) in cases.items():
            made = normalization.normalize(
                Money.parse("1000", "EUR"), event_date=event_date, valuation_date=date(2026, 9, 30),
                policy=normalization.NormalizationPolicy("USD", reporting, rules, US_CPI, 0),
                fx_book=fx_book, index_book=index_book,
            )
            _write(name, served_by=None, engine_record=made.as_dict(),
                   note="not a route's answer: Normalization.as_dict() from the backend's engine and its committed "
                   "synthetic snapshot; no route serves a currency bridge at this commit")

else:

    @pytest.mark.parametrize(
        "name, severity, kwargs",
        [
            ("roi-clean", "medium", {}),
            ("roi-vetoed", "high", {}),
            ("roi-unknown", "medium", {"unknown": True}),
            ("roi-refused", "medium", {"refused": True}),
        ],
    )
    def test_roi(deployment, people, name, severity, kwargs):
        scenario, _, _ = proposed(deployment, people, severity=severity, **kwargs)
        exchanges = _routes(deployment, scenario, people["owner"], "report", "events", "roi")
        assert exchanges[2]["status"] == 200, exchanges[2]["body"]
        _write(name, exchanges)
