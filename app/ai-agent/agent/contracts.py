from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


AiProvider = Literal["gemini", "openai-compatible", "deepseek"]


class AiModelRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    provider: AiProvider
    model: str
    base_url: str | None = Field(default=None, alias="baseUrl")
    provider_key: str | None = Field(default=None, alias="providerKey")


class LocalAgentRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    model: AiModelRequest
    prompt: str
    season_ids: list[str] = Field(default_factory=list, alias="seasonIds")
    workflow_id: str | None = Field(default=None, alias="workflowId")
    semantic_intent: dict[str, Any] | None = Field(default=None, alias="semanticIntent")
    required_gates: list[str] = Field(default_factory=list, alias="requiredGates")
    session_artifact: dict[str, Any] | None = Field(default=None, alias="sessionArtifact")
    notebook_context: dict[str, Any] | None = Field(default=None, alias="notebookContext")
    context_documents: list[dict[str, Any]] = Field(default_factory=list, alias="contextDocuments")
    source_policy: Literal["local-sqlite"] = Field(default="local-sqlite", alias="sourcePolicy")
    language: Literal["vi"] = "vi"
    sqlite_path: str | None = Field(default=None, alias="sqlitePath")


class QueryResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    query_id: str = Field(alias="queryId")
    columns: list[str]
    rows: list[dict[str, Any]]
    row_count: int = Field(alias="rowCount")
    truncated: bool = False
    executed_sql_preview: str | None = Field(default=None, alias="executedSqlPreview")
    data_quality_notes: list[str] = Field(default_factory=list, alias="dataQualityNotes")


class ToolTraceEntry(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    tool: str
    phase: str | None = None
    reason: str


class LocalAgentResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    assistant_text: str = Field(alias="assistantText")
    query_results: list[QueryResult] = Field(default_factory=list, alias="queryResults")
    result_profiles: list[dict[str, Any]] = Field(default_factory=list, alias="resultProfiles")
    answer_verification: dict[str, Any] | None = Field(default=None, alias="answerVerification")
    board_patch: dict[str, Any] | None = Field(default=None, alias="boardPatch")
    tool_trace_summary: list[ToolTraceEntry] = Field(default_factory=list, alias="toolTraceSummary")
    workflow_id: str | None = Field(default=None, alias="workflowId")
    prepared_data_contracts: list[dict[str, Any]] = Field(default_factory=list, alias="preparedDataContracts")
    workflow_trace_summary: list[ToolTraceEntry] = Field(default_factory=list, alias="workflowTraceSummary")
    export_action: dict[str, Any] | None = Field(default=None, alias="exportAction")
