"""LLM fallback. Only upgrades output when ANTHROPIC_API_KEY is set.
Everything degrades to rule-generated prose on missing key or any error."""
import os
import json

MODEL = "claude-sonnet-4-5"  # Claude Code: bump to the latest sonnet string

TAXONOMY = ("fraud, identity, lending, support, compliance, analytics, documents, "
            "claims, marketing, operations")


def _client():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    try:
        from anthropic import Anthropic
        return Anthropic(api_key=key)
    except Exception:
        return None


def classify_unknowns(items):
    """Fill domain/capability for lines the rules couldn't match."""
    client = _client()
    unknown = [i for i in items if not i["domain"]]
    if not client or not unknown:
        return items
    lines = [i["raw"] for i in unknown]
    prompt = (
        f"Classify each initiative into exactly one domain from: {TAXONOMY}. "
        "Also give a short capability slug (e.g. doc_parsing, anomaly_detection, "
        "conversational, bi_query). Return ONLY a JSON array of "
        '{"raw","domain","capability"} objects, no prose.\n\n'
        + "\n".join(f"- {l}" for l in lines)
    )
    try:
        resp = client.messages.create(
            model=MODEL, max_tokens=1000,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(b.text for b in resp.content if b.type == "text")
        parsed = json.loads(text.replace("```json", "").replace("```", "").strip())
        by_raw = {p["raw"]: p for p in parsed}
        for i in items:
            if not i["domain"] and i["raw"] in by_raw:
                i["domain"] = by_raw[i["raw"]].get("domain")
                i["capability"] = by_raw[i["raw"]].get("capability")
                i["classified_by"] = "llm"
                i["matched_on"] = None
                i["confidence"] = 0.7
    except Exception:
        pass
    return items


def write_prose(diag):
    """Generate summary + key_observation. Fallback to templated prose."""
    client = _client()
    fallback_summary = (
        f"{diag['counts']['initiatives']} independent AI systems with no shared "
        "runtime contract, duplicating capabilities while unable to exchange "
        "signals in real time."
    )
    fallback_obs = (
        "Systems make decisions without a live feed of each other's signals. "
        "The only coordination point is batch ETL, creating a window where "
        "contradictory decisions are simultaneously in production."
    )
    diag["summary"] = fallback_summary
    diag["key_observation"] = fallback_obs
    diag["closing"] = (
        f"{diag['counts']['initiatives']} initiatives. "
        f"{diag['counts']['rebuilt_capabilities']} capabilities rebuilt from scratch. "
        f"{diag['counts']['independent_data_touches']} data sources touched with no "
        "coordination. The layer that would connect them does not exist yet."
    )
    if not client:
        return diag
    try:
        prompt = (
            "You are analyzing an AI portfolio for fragmentation. Given this JSON, "
            "write two fields: 'summary' (1 sentence, blunt) and 'key_observation' "
            "(2-3 sentences, concrete risk scenario). Return ONLY JSON "
            '{"summary","key_observation"}.\n\n' + json.dumps(diag["findings"])
        )
        resp = client.messages.create(
            model=MODEL, max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(b.text for b in resp.content if b.type == "text")
        parsed = json.loads(text.replace("```json", "").replace("```", "").strip())
        diag["summary"] = parsed.get("summary", fallback_summary)
        diag["key_observation"] = parsed.get("key_observation", fallback_obs)
    except Exception:
        pass
    return diag
