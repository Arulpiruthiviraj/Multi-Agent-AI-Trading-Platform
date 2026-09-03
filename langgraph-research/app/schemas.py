"""
Explicit request/response schemas for the LangGraph research service's HTTP contract. Field-for-
field, this must stay in lockstep with the Node-side validator
(src/server/services/LangGraphResearchService.ts's validateEnvelope()) - a change to one side
without the other is exactly the kind of drift that would make Node reject every real response as
INVALID_RESPONSE. Kept deliberately small: this is the entire HTTP surface, no arbitrary query
endpoint, no free-form fields.
"""
from typing import List, Literal, Optional

from pydantic import BaseModel, Field

RecommendationValue = Literal[
    "PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW",
    "NOT_YET_ELIGIBLE",
    "INSUFFICIENT_EVIDENCE",
]

EvidenceStrengthValue = Literal["NONE", "WEAK", "MODERATE", "STRONG"]


class StrategyGraduationRequest(BaseModel):
    strategyId: str = Field(min_length=1, max_length=128)
    correlationId: str = Field(min_length=1, max_length=128)


class Provenance(BaseModel):
    source: str
    strategyId: str
    fetchedAt: str


class StrategyGraduationResult(BaseModel):
    lifecycleStatusAtRequest: str
    live: Literal["GO", "NO-GO"]
    failedGatesAtRequest: List[str]
    recommendation: RecommendationValue
    confidence: float = Field(ge=0.0, le=1.0)  # model self-reported only - never a substitute for evidenceStrength
    rationale: str
    limitations: List[str]
    evidenceUsed: List[str]
    counterEvidence: List[str]
    missingEvidence: List[str]
    evidenceStrength: EvidenceStrengthValue
    evidenceStrengthRationale: str
    humanReviewRequired: bool
    provenance: Provenance
    modelGeneratedNarrative: str


class StrategyGraduationResponse(BaseModel):
    runId: str
    correlationId: str
    strategyId: str
    graphVersion: str
    status: Literal["COMPLETED", "FAILED"]
    result: Optional[StrategyGraduationResult] = None
    error: Optional[str] = None
    durationMs: float
    nodesExecuted: List[str]
    providerModel: Optional[str] = None


class HealthResponse(BaseModel):
    status: Literal["ok"]
    service: Literal["langgraph-research"]
    version: str
    capabilities: List[str]
