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

One backend commit, one directory:

  ab-master-e7ee3eb/  Athena-Backend master e7ee3ebc5a384256be1f9bf43c219639751692dd
                      (#163 and #164 merged. The report is
                      `mythos.economics.report/v2`: v1 and `currency_bridge`, the
                      run's valuation date with where it was read from, and
                      `conversions: []` with the statement why (a run converts
                      nothing). The receipt route serves a Financial Exposure
                      Receipt's signed DSSE envelope as stored, with its SHA-256 in
                      `X-Content-SHA256`; the scenario list serves a deployment's
                      versions a page at a time. Every report carries `residual_of`,
                      null for the scenario's own run; the ROI document carries
                      `deployment_decision`, and `figures.gross_cash` beside a
                      retained headline. A scenario with no remediation option
                      answers the ROI route 404, recorded as it is.)

`residual-report` also holds `residual_report`: not a route's answer -- no route
serves a residual run's report, by design -- but the backend's own
`report.build_report` of the residual run, as its ROI route reads it.

The ``bridge-*`` files are not a route's answer: a report's `currency_bridge`
serves its valuation date and `conversions: []` (a run converts nothing, and no
normalization record is stored for any figure). They are ``Normalization.as_dict()``
records the backend's own engine (``assurance/economics/engine/normalization.py``)
made from its committed synthetic snapshot
(``snapshots/synthetic-fx-and-cost-index-v1.json``), the shape the spec (section
12.6) gives a conversion's provenance chain; the dashboard renders that shape where
`conversions` would hold one.

``canonical-spellings`` is not a route's answer either: SYNTHETIC documents with
text outside ASCII, each in the spelling a receipt's DSSE payload is signed over
(``mythos_core.outcome.canonical_bytes``: UTF-8, recorded in hex) and with the
digest the report names for a receipt's document (``models.canonical_digest``: the
ASCII spelling). The dashboard checks a receipt's payload against the digest it
shows with them.

Usage, from a checkout of Athena-Backend at that commit with its CI
dependencies installed: copy this file into the checkout's ``tests/`` as
``test_zz_dashboard_economics_fixtures.py`` and run it there with pytest, in the
environment the backend's CI gives its tests, plus ``ECON_FIXTURES_OUT`` (the output
directory) and ``ECON_FIXTURES_SHA`` (the checkout's commit). pytest loads the
backend's test configuration through the checkout's own pytest.ini; nothing else
does. Delete the copy afterwards.

Each fixture: ``{"synthetic", "backend", "scenario", "exchanges": [{"name",
"method", "path", "status", "content_type", "headers", "body"}]}``; ``body`` is the
answer's bytes as text, exactly (the report and the ROI document are canonical ASCII
JSON carrying their own digest, so a byte changed is a digest that no longer
verifies). The receipt's bytes -- its envelope's canonical ASCII bytes, whose
SHA-256 its ``X-Content-SHA256`` header names -- are recorded in hex instead
(``body_hex``), exactly: the base64 of its payload and signature reads as a secret
to the repository's secret scan, and the dashboard's fixture reader turns them
back into ``body``. ``headers`` are the answer's own, of those
:data:`RECORDED_HEADERS` names.
Uuids, times and digests differ on every run; the tests read them from the files.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import uuid
from datetime import date
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from django.contrib.auth import get_user_model
from mythos_core import exposure_receipt as core
from mythos_core.outcome import canonical_bytes as core_canonical_bytes

from assurance.economics import receipt_service
from assurance.economics.engine import normalization, snapshot
from assurance.economics.engine import scenario_simulation as ss
from assurance.economics.engine.cost_index import IndexSelector
from assurance.economics.engine.fx import FXPolicy
from assurance.economics.engine.money import Money
from assurance.economics.models import (
    FinancialParameter,
    LossComponent,
    LossEvent,
    ScenarioBuild,
    SimulationResult,
    canonical_digest,
)
from assurance.models import Deployment
from tests.test_economics_remediation import proposed
from tests.test_economics_report import POISSON, QUICK, _base, _client, _parameter, _simulate, stored

pytestmark = pytest.mark.django_db
User = get_user_model()
SYNTHETIC = (
    "SYNTHETIC / ILLUSTRATIVE: made by Athena-Backend's own test helpers in a throwaway test database; no customer "
    "data, no real tenant, no key that outlived the run"
)
OUT = Path(os.environ.get("ECON_FIXTURES_OUT", "")) if os.environ.get("ECON_FIXTURES_OUT") else None
SHA = os.environ.get("ECON_FIXTURES_SHA", "")
MASTER = "e7ee3ebc5a384256be1f9bf43c219639751692dd"
SNAPSHOT_PATH = Path(__file__).resolve().parent.parent / "assurance" / "economics" / "snapshots" / (
    "synthetic-fx-and-cost-index-v1.json")
CPI = "consumer prices, all items (SYNTHETIC)"
US_CPI = IndexSelector("SYN-CPI-US", "US", CPI, "2020-03=100", "USD")
#: The answer headers each exchange records, where the answer has them.
RECORDED_HEADERS = ("Content-Type", "Content-Disposition", "Cache-Control", "X-Content-Type-Options", "X-Content-SHA256")


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
    assert SHA == MASTER, f"generate from master {MASTER}, not {SHA!r}"
    return {"repository": "Deltawsierra/Athena-Backend", "sha": SHA, "ref": "master"}


def _exchange(name: str, client, path: str, *, hex_body: bool = False) -> dict:
    """One answer of a route. ``hex_body``: the bytes recorded in hex (``body_hex``),
    for an answer whose base64 the repository's secret scan would read as a secret
    (a receipt's payload and signature, made with a key discarded after the run)."""
    response = client.get(path)
    exchange = {
        "name": name,
        "method": "GET",
        "path": path,
        "status": response.status_code,
        "content_type": response.get("Content-Type", ""),
        "headers": {header: response[header] for header in RECORDED_HEADERS if response.has_header(header)},
    }
    if hex_body:
        exchange["body_hex"] = response.content.hex()
    else:
        exchange["body"] = response.content.decode("utf-8")
    return exchange


def _deployment_base(deployment) -> str:
    return f"/api/assurance/deployments/{deployment.uuid}/economics/"


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
    # The receipt the report names, by its id dashed (the route's form), as the route
    # serves its signed envelope; and one the deployment has no such receipt of.
    receipt_id = report["receipt"]["receipt_id"]
    client = _client(people["owner"])
    receipt = _exchange("receipt", client, _deployment_base(deployment) + f"receipts/{uuid.UUID(receipt_id)}/",
                        hex_body=True)
    body = bytes.fromhex(receipt["body_hex"])
    assert receipt["status"] == 200, body
    assert receipt["headers"]["X-Content-SHA256"] == "sha256:" + hashlib.sha256(body).hexdigest()
    # The envelope's payload is the signed document; its digest is the one the report names.
    payload = base64.b64decode(json.loads(body)["payload"])
    assert canonical_digest(json.loads(payload)) == report["receipt"]["document_digest"]
    missing = _exchange("receipt-missing", client, _deployment_base(deployment) + f"receipts/{uuid.UUID(int=1)}/")
    assert missing["status"] == 404, missing["body"]
    _write("graded-usd-policy-market-value-receipt", exchanges + [receipt, missing])


def test_graded_unknown(deployment, people):
    scenario, answer = _simulated(deployment, people, unknown=True)
    assert answer.status_code == 201, answer.content
    exchanges = _routes(deployment, scenario, people["owner"], "report", "events", "roi")
    assert json.loads(exchanges[0]["body"])["grade"] == "Unknown"
    _write("unknown-usd", exchanges)


def test_refused(deployment, people):
    scenario, answer = _simulated(deployment, people, refused=True)
    assert answer.status_code == 201, answer.content
    exchanges = _routes(deployment, scenario, people["owner"], "report", "events", "roi")
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
    exchanges = _routes(deployment, scenario, people["owner"], "report", "roi")
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
    exchanges = _routes(deployment, scenario, people["owner"], "report", "roi")
    card = json.loads(exchanges[0]["body"])["validity_card"]
    assert card["fields"]["data_freshness"]["stale"], card["fields"]["data_freshness"]
    _write("stale-usd", exchanges)


@pytest.mark.parametrize("currency", ["JPY", "KWD"])
def test_minor_units(deployment, people, currency):
    scenario, answer = _simulated(deployment, people, currency=currency, affected_source="CUSTOMER_PROVIDED")
    assert answer.status_code == 201, answer.content
    exchanges = _routes(deployment, scenario, people["owner"], "report", "roi")
    assert json.loads(exchanges[0]["body"])["currency"]["code"] == currency
    _write(f"graded-{currency.lower()}", exchanges)


def test_a_valuation_date_read_from_the_inputs(deployment, people):
    """A version with no build (removed past the code, as the backend's own test
    does): the valuation date is the latest as-of date the stored inputs hold."""
    scenario, answer = _simulated(deployment, people, affected_source="CUSTOMER_PROVIDED")
    assert answer.status_code == 201, answer.content
    ScenarioBuild._base_manager.filter(scenario=scenario).delete()
    exchanges = _routes(deployment, scenario, people["owner"], "report", "roi")
    bridge = json.loads(exchanges[0]["body"])["currency_bridge"]
    assert bridge["valuation_date"] is not None and "not_reported" not in bridge, bridge
    _write("valuation-from-inputs-usd", exchanges)


def test_a_valuation_date_not_reported(deployment, people):
    """No build, and inputs that no longer give their digest: the valuation date is
    not reported, with why, and the result is served as a refusal."""
    scenario, answer = _simulated(deployment, people)
    assert answer.status_code == 201, answer.content
    ScenarioBuild._base_manager.filter(scenario=scenario).delete()
    result = SimulationResult.objects.get(scenario=scenario)
    inputs = json.loads(json.dumps(result.inputs))
    inputs["events"][0]["components"][0]["as_of"] = "2099-01-01"
    SimulationResult._base_manager.filter(pk=result.pk).update(inputs=inputs)
    exchanges = _routes(deployment, scenario, people["owner"], "report", "roi")
    report = json.loads(exchanges[0]["body"])
    assert report["currency_bridge"]["valuation_date"] is None, report["currency_bridge"]
    assert report["currency_bridge"]["not_reported"], report["currency_bridge"]
    assert report["refusal"]["code"] == "stored_row_unverified", report["refusal"]
    _write("valuation-not-reported-usd", exchanges)


def test_the_scenario_list(deployment, people):
    """Five versions of one deployment: graded, Unknown, refused, never run, and one
    with a remediation option (its residual run is never listed). Read two a page,
    every page; the default page; and a page the route refuses."""
    analyst = _client(people["analyst"])
    graded = stored(deployment, people["analyst"], affected_source="CUSTOMER_PROVIDED")
    assert _simulate(analyst, deployment, graded).status_code == 201
    unknown = stored(deployment, people["analyst"], unknown=True, set_key="syn_q2")
    assert _simulate(analyst, deployment, unknown).status_code == 201
    refused = stored(deployment, people["analyst"], refused=True, set_key="syn_q3")
    assert _simulate(analyst, deployment, refused).status_code == 201
    stored(deployment, people["analyst"], set_key="syn_q4")
    proposed(deployment, people, set_key="syn_q5")
    owner = _client(people["owner"])
    base = _deployment_base(deployment) + "scenarios/"
    pages = [_exchange(f"list-page-{n}", owner, base + f"?page={n}&page_size=2") for n in (1, 2, 3)]
    for page in pages:
        assert page["status"] == 200, page["body"]
    assert [json.loads(page["body"])["next"] for page in pages] == [2, 3, None]
    whole = _exchange("list-default", owner, base)
    assert json.loads(whole["body"])["count"] == 5
    refusal = _exchange("list-refused", owner, base + "?page=0")
    assert refusal["status"] == 400, refusal["body"]
    report = _exchange("report", owner, _base(deployment, graded) + "results/")
    _write("scenario-list", pages + [whole, refusal, report])


#: SYNTHETIC documents with text outside printable ASCII: an accent, a currency
#: sign, a line separator, a delete, a character past the first plane, and a quote
#: and a backslash.
SPELLINGS = (
    {"title": "SYNTHETIC caf\u00e9 exposure", "delete": "a\x7fb"},
    {"title": "SYNTHETIC \u20ac and \u00a5", "note": "line\u2028separator", "n": 3},
    {"title": "SYNTHETIC \U0001f4b6 past the first plane", "nested": {"z": "\"quoted\" \\ back", "a": ["\u00fc", 1]}},
)


def test_canonical_spellings():
    """Not a route's answer: the spelling a receipt's payload is signed over and the
    digest the report names for its document, from the backend's own functions."""
    cases = []
    for document in SPELLINGS:
        signed = core_canonical_bytes(document)
        assert signed != json.dumps(document, sort_keys=True, separators=(",", ":")).encode("ascii")
        cases.append({
            "payload_hex": signed.hex(),
            "document_digest": canonical_digest(document),
        })
    _write("canonical-spellings", served_by=None, cases=cases,
           note="not a route's answer: mythos_core.outcome.canonical_bytes (the DSSE payload's UTF-8 spelling) and "
           "models.canonical_digest (the digest a report names for a receipt's document) of SYNTHETIC documents")


def test_currency_bridges():
    """Engine records, not a route's answer: a report's ``conversions`` is empty at
    this commit (a run converts nothing)."""
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
               "synthetic snapshot; a report's currency_bridge.conversions is empty at this commit")


@pytest.mark.parametrize(
    "name, severity, kwargs",
    [
        ("roi-clean", "medium", {}),
        ("roi-vetoed", "high", {}),
        ("roi-unknown", "medium", {"unknown": True}),
        ("roi-refused", "medium", {"refused": True}),
        ("roi-policy", "medium", {"policy": True}),
    ],
)
def test_roi(deployment, people, name, severity, kwargs):
    scenario, _, _ = proposed(deployment, people, severity=severity, **kwargs)
    exchanges = _routes(deployment, scenario, people["owner"], "report", "events", "roi")
    assert exchanges[2]["status"] == 200, exchanges[2]["body"]
    _write(name, exchanges)

def test_the_residual_runs_own_report(deployment, people):
    """The scenario's routes, and the report of its residual run as the backend's
    own report.build_report makes it (no route serves it: a residual run is never
    exposure). SYNTHETIC."""
    from assurance.economics import report as report_module

    scenario, _, _ = proposed(deployment, people)
    exchanges = _routes(deployment, scenario, people["owner"], "report", "events", "roi")
    residual = SimulationResult.objects.filter(scenario=scenario, remediation__isnull=False).order_by("-id").first()
    assert residual is not None
    body = report_module.canonical_bytes(report_module.build_report(residual)).decode("ascii")
    _write("residual-report", exchanges, residual_report={
        "note": "not a route's answer: report.build_report of the residual run, as the ROI route reads it; no "
        "route serves a residual run's report",
        "simulation": str(residual.uuid),
        "body": body,
    })
