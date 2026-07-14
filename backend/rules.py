"""Deterministic rules engine. Runs first, always, no API needed.

Every classification records what it matched on and who classified it; every
finding carries an `evidence` object (systems, reasoning trace, severity,
confidence) per the contract in evidence_reference.py at the repo root.
"""
import re
from collections import defaultdict

# domain, capability, and the data entities a keyword implies touching
# each rule: (regex, domain, capability, [data_entities])
RULES = [
    (r"\bfraud\b|anomaly|risk score|risk model",       "fraud",      "anomaly_detection", ["transaction", "customer"]),
    (r"\bkyc\b|identity|onboard",                        "identity",   "doc_parsing",       ["customer", "identity_doc"]),
    (r"underwrit|lending|\bloan\b",                      "lending",    "doc_parsing",       ["customer", "loan_doc"]),
    (r"chatbot|customer support|contact center|support", "support",    "conversational",    ["customer"]),
    (r"\baml\b|compliance|monitoring|sanction",          "compliance", "anomaly_detection", ["transaction", "customer"]),
    (r"analytic|copilot|warehouse|\bbi\b|reporting",     "analytics",  "bi_query",          ["transaction", "customer"]),
    (r"claim",                                           "claims",     "doc_parsing",       ["customer", "claim_doc"]),
    (r"\bocr\b|document pars|invoice|extract",           "documents",  "doc_parsing",       ["document"]),
    (r"recommend|personaliz",                            "marketing",  "personalization",   ["customer", "product"]),
    (r"churn|retention",                                 "marketing",  "churn_prediction",  ["customer"]),
    (r"marketing|content gen|copywrit|campaign",         "marketing",  "content_generation",["customer", "product"]),
    (r"forecast|inventory|demand",                       "operations", "forecasting",       ["product", "transaction"]),
    (r"pricing|\bprice\b",                               "operations", "forecasting",       ["product", "transaction"]),
]

CONF_RULES = 0.95      # rule-matched classification
CONF_LLM = 0.7         # LLM-fallback classification (set in llm.py)
CONF_UNMATCHED = 0.0   # signals LLM fallback should classify this line

# entities implied per domain, for lines the LLM classifies (no rule entities)
DOMAIN_ENTITIES = {
    "fraud": ["transaction", "customer"],
    "identity": ["customer", "identity_doc"],
    "lending": ["customer", "loan_doc"],
    "support": ["customer"],
    "compliance": ["transaction", "customer"],
    "analytics": ["transaction", "customer"],
    "claims": ["customer", "claim_doc"],
    "documents": ["document"],
    "marketing": ["customer"],
    "operations": ["product", "transaction"],
}

# known cross-domain gaps that should exist but usually don't
MISSING_EDGES = [
    ("fraud",    "lending",    "no risk feed"),
    ("fraud",    "support",    "no signal exchange"),
    ("identity", "lending",    "no shared parsing"),
    ("compliance", "support",  "no shared state"),
    ("claims",   "fraud",      "no fraud signal"),
    ("marketing", "support",   "no churn signal"),
    ("operations", "marketing", "no demand signal"),
    ("fraud",    "analytics",  "batch-only feed"),
]

SEVERITY_HIGH_DOMAINS = {"fraud", "compliance"}

# failure-mode library for MISSING reasoning, picked by domain pair
FAILURE_MODES = {
    ("fraud", "lending"): "a customer flagged by fraud can still receive an automated lending decision",
    ("fraud", "support"): "support can offer service or credits to an account fraud has already flagged",
    ("identity", "lending"): "identity extracts the same documents lending re-parses with a second pipeline",
    ("compliance", "support"): "support has no view of compliance holds, so it can promise actions compliance will block",
    ("claims", "fraud"): "a claim can be paid while its fraud score is still sitting in a nightly batch",
    ("marketing", "support"): "support works tickets from customers marketing already flagged as churn risks",
    ("operations", "marketing"): "campaigns promote products operations is about to run out of",
    ("fraud", "analytics"): "executive dashboards report yesterday's fraud while today's is still in flight",
}


def classify_line(line: str):
    low = line.lower()
    for pattern, domain, cap, entities in RULES:
        m = re.search(pattern, low)
        if m:
            return {"raw": line, "domain": domain, "capability": cap,
                    "entities": entities, "system_label": line.strip(),
                    "matched_on": m.group(0), "classified_by": "rules",
                    "confidence": CONF_RULES}
    return {"raw": line, "domain": None, "capability": None,
            "entities": [], "system_label": line.strip(),
            "matched_on": None, "classified_by": None,
            "confidence": CONF_UNMATCHED}


def classify(lines):
    """Rules pass only. LLM fallback may fill unknowns afterwards."""
    return [classify_line(l) for l in lines if l.strip()]


def _dep_conf(items):
    """A finding's confidence is capped by its weakest classification."""
    return min((i.get("confidence") or CONF_LLM) for i in items) if items else CONF_RULES


# ── evidence builders (ported from evidence_reference.py) ──────────────

def duplicated_evidence(cap, system_items):
    meta = [{"label": i["system_label"], "domain": i["domain"],
             "matched_on": i["matched_on"], "classified_by": i["classified_by"]}
            for i in system_items]
    reasoning = [
        f"{s['label']} classified {cap} (matched on '{s['matched_on'] or 'semantic match'}', by {s['classified_by']})"
        for s in meta
    ]
    reasoning.append(
        f"{len(meta)} independent implementations of {cap.replace('_', ' ')} -> duplicated build and maintenance cost"
    )
    return {
        "capability": cap,
        "systems": meta,
        "reasoning": reasoning,
        "severity": "MEDIUM",
        "confidence": round(_dep_conf(system_items), 2),
    }


def shared_evidence(entity, system_items):
    labels = sorted({i["system_label"] for i in system_items})
    n = len(labels)
    return {
        "entity": entity,
        "systems": labels,
        "reasoning": [
            f"Each of the {n} systems independently reads/writes `{entity}` records",
            "No coordination layer detected between them",
            f"A schema change in `{entity}` requires {n} teams to manually sync and retrain",
        ],
        "severity": "HIGH" if n >= 4 else "MEDIUM",
        "confidence": round(min(0.9, _dep_conf(system_items)), 2),
    }


def missing_evidence(a, b, from_items, to_items):
    failure = FAILURE_MODES.get((a, b)) or FAILURE_MODES.get((b, a)) or (
        f"decisions in {b} run without {a} signals at decision time"
    )
    sev = "HIGH" if (a in SEVERITY_HIGH_DOMAINS or b in SEVERITY_HIGH_DOMAINS) else "MEDIUM"
    return {
        "from_domain": a,
        "to_domain": b,
        "from_systems": [i["system_label"] for i in from_items],
        "to_systems": [i["system_label"] for i in to_items],
        "reasoning": [
            f"{a} produces signals that {b} decisions should consume",
            "No initiative in the list connects them",
            f"Failure mode: {failure}",
        ],
        "severity": sev,
        "confidence": round(min(0.85, _dep_conf(from_items + to_items)), 2),
    }


def bus_evidence(classified, domains):
    n = len(classified)
    sev = "HIGH" if (domains & SEVERITY_HIGH_DOMAINS) else "MEDIUM"
    return {
        "systems": sorted(i["system_label"] for i in classified),
        "reasoning": [
            f"All {n} systems compute features and signals privately",
            "No initiative in the list provides a shared feature store or signal bus",
            "Failure mode: every new cross-system connection becomes a bespoke integration project",
        ],
        "severity": sev,
        "confidence": round(min(0.9, _dep_conf(classified)), 2),
    }


# ── finding derivation ─────────────────────────────────────────────────

def derive(items):
    """Build the diagnostic from classified items (rules and/or LLM)."""
    # LLM-classified lines carry no rule entities; imply them from the domain
    for i in items:
        if i["domain"] and not i["entities"]:
            i["entities"] = DOMAIN_ENTITIES.get(i["domain"], ["customer"])

    classified = [i for i in items if i["domain"]]
    domains = {i["domain"] for i in classified}

    cap_items = defaultdict(list)
    for i in classified:
        cap_items[i["capability"]].append(i)

    entity_items = defaultdict(dict)   # entity -> {label: item}
    for i in classified:
        for e in i["entities"]:
            entity_items[e][i["system_label"]] = i
    data_touches = sum(len(v) for v in entity_items.values())

    by_domain = defaultdict(list)
    for i in classified:
        by_domain[i["domain"]].append(i)

    findings = []

    # DUPLICATED: a capability rebuilt across >=2 systems
    duplicated_caps = set()
    for cap, its in cap_items.items():
        if len(its) >= 2:
            duplicated_caps.add(cap)
            pretty = cap.replace("_", " ")
            findings.append({
                "type": "DUPLICATED",
                "title": f"{pretty.capitalize()} rebuilt {len(its)} times across the portfolio",
                "detail": f"Systems duplicating {pretty}: {', '.join(i['system_label'] for i in its)}.",
                "evidence": duplicated_evidence(cap, its),
            })

    # SHARED: same data entity touched by >=2 systems with no coordination
    contended_entities = set()
    for entity, by_label in entity_items.items():
        its = list(by_label.values())
        if len(its) >= 2:
            if len(its) >= 4:
                contended_entities.add(entity)
            findings.append({
                "type": "SHARED",
                "title": f"{entity.capitalize()} data touched by {len(its)} systems with no coordination",
                "detail": f"{', '.join(sorted(by_label))} all read/write {entity} independently.",
                "evidence": shared_evidence(entity, its),
            })

    # MISSING: cross-domain gaps present in this portfolio
    present_edges = []
    for a, b, label in MISSING_EDGES:
        if a in domains and b in domains:
            ev = missing_evidence(a, b, by_domain[a], by_domain[b])
            present_edges.append({"from": a, "to": b, "label": label,
                                  "severity": ev["severity"]})
            findings.append({
                "type": "MISSING",
                "title": f"No live connection between {a} and {b} ({label}).",
                "detail": f"Decisions in {b} run without {a} signals in real time.",
                "evidence": ev,
            })

    # always: the bus
    findings.append({
        "type": "MISSING",
        "title": "No shared feature store or signal bus exists.",
        "detail": "There is no layer for these systems to exchange features or signals live.",
        "evidence": bus_evidence(classified, domains),
    })

    rebuilt = len(duplicated_caps)
    status = "FRAGMENTED" if (rebuilt or present_edges) else "CONNECTED"

    return {
        "items": items,
        "status": status,
        "counts": {
            "initiatives": len(items),
            "problem_domains": len(domains),
            "independent_data_touches": data_touches,
            "rebuilt_capabilities": rebuilt,
        },
        "graph": {
            "nodes": [{
                "label": i["system_label"],
                "domain": i["domain"],
                "duplicated": i["capability"] in duplicated_caps,
                "contended": any(e in contended_entities for e in i["entities"]),
            } for i in classified],
            "missing_edges": present_edges,
            "missing_layer": True,
        },
        "findings": findings,
    }


def analyze(lines):
    """Rules-only path: classify then derive. LLM layer may run between."""
    return derive(classify(lines))
