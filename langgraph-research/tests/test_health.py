from app.schemas import HealthResponse


def test_health_response_schema_shape():
    resp = HealthResponse(status="ok", service="langgraph-research", version="v1", capabilities=["strategy-graduation-recommendation"])
    dumped = resp.model_dump()
    assert dumped["status"] == "ok"
    assert dumped["service"] == "langgraph-research"
    assert "strategy-graduation-recommendation" in dumped["capabilities"]
